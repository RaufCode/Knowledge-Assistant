import logging
import time
from collections.abc import Iterator

from llama_index.core import VectorStoreIndex
from llama_index.core.schema import MetadataMode
from openai import APIConnectionError, APIStatusError, OpenAI, OpenAIError

from app.config import settings
from app.rag.guard import is_greeting, is_personal_question

logger = logging.getLogger(__name__)

FALLBACK_MSG = (
    "I couldn't find that in the company documents. "
    "Please contact HR at hr@acmetech.example or +233 30 000 0000."
)
PERSONAL_MSG = (
    "I can only answer general policy questions and I can't access personal "
    "records such as leave balances, salaries or payslips. Please check the HR "
    "self-service portal on the intranet, or contact HR at hr@acmetech.example."
)

# The rules live in the system message and the retrieved context in the user
# message, so the model is never asked to treat its own instructions as data.
SYSTEM_PROMPT = """You are the Internal Knowledge Assistant for Acme Technologies.
Answer the question using ONLY the context given in the user message. Be concise,
and use numbered steps when the source describes a process.

Rules:
- If the context does not contain the answer, reply with exactly: NOT_FOUND
- If the question asks about the asker's own personal records (their own leave
  balance, salary, payslip, appraisal), reply with exactly: PERSONAL
- Never use outside knowledge."""

USER_PROMPT = """Context:
{context}

Question: {question}
Answer:"""

# A title is a single short line, so it gets its own prompt and its own tiny
# output budget: labelling a conversation never needs the answer's context, and
# letting it share the answer's budget would let the model ramble.
TITLE_SYSTEM_PROMPT = (
    "You name conversation threads. From the first user message in a fresh "
    "conversation, give it a short title of at most six words that a person "
    "would recognise later in a list of conversations. Reply with only the "
    "title: no quotes, no surrounding text and no trailing period."
)

# Fallback for when the model is unreachable or its title comes back unusable.
# Single-line, and bounded so the longest title still fits a sidebar row.
TITLE_MAX_CHARS = 50

# Output budget for a title. Generous for six words, because the configured model
# is a reasoning model that spends tokens thinking before it writes anything: a
# budget of a few dozen was consumed by the thinking and the call came back with
# no content at all, so every title silently fell back to truncation.
TITLE_MAX_TOKENS = 256

# Output budget for a greeting. Generous for two sentences, because the
# configured model is a reasoning model that spends tokens thinking before it
# writes anything: a budget of a few dozen was consumed by the thinking and the
# call came back with no content at all.
GREETING_MAX_TOKENS = 256

# How a greeting is answered when the model itself cannot be reached. Static
# rather than absent: an outage should not turn "hello" into a lecture about
# the corpus.
GREETING_FALLBACK = (
    "Hello! I'm the Internal Knowledge Assistant for Acme Technologies. "
    "I answer questions from our company policies — ask me about leave, "
    "working hours, benefits, IT setup, or conduct."
)

# A greeting gets no retrieval and no policy context: there is nothing to look
# up, and handing the policies over would only invite quoting them at small
# talk. The model is told to be brief and to point at what it is for.
GREETING_SYSTEM_PROMPT = (
    "You are the Internal Knowledge Assistant for Acme Technologies, greeting "
    "somebody who just said hello. Reply warmly in one or two short sentences: "
    "greet them back, say you answer questions from the company policies, and "
    "invite one. Name no policy and quote no document."
)


def truncate_title(text: str, max_chars: int = TITLE_MAX_CHARS) -> str:
    text = " ".join(text.split())
    if not text:
        return "New conversation"
    if len(text) <= max_chars:
        return text
    cut = text[:max_chars]
    if " " in cut:
        return cut.rsplit(" ", 1)[0]
    return cut


class LlmUnavailable(Exception):
    """No answer could be produced from the configured NVIDIA model.

    Carries the upstream reason so the route can log it and tell an operator what
    actually went wrong, rather than the caller seeing an opaque 500.
    """

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


class Assistant:
    def __init__(self, index: VectorStoreIndex):
        self.retriever = index.as_retriever(similarity_top_k=settings.top_k)
        # Built once so the HTTP connection is reused across turns. Only built
        # when a key is present, so a missing key surfaces as a 503 from /chat
        # rather than an OpenAI client-init error escaping as a 500.
        self._client = (
            OpenAI(
                base_url=settings.nvidia_base_url,
                api_key=settings.nvidia_api_key,
                max_retries=0,  # this module owns the backoff, not the SDK
            )
            if settings.has_nvidia_api_key
            else None
        )

    def _complete(
        self,
        user_prompt: str,
        system_prompt: str = SYSTEM_PROMPT,
        max_tokens: int | None = None,
    ) -> str:
        """Answer via the configured NVIDIA model, with retries.

        NVIDIA's OpenAI-compatible endpoint fails in two very different ways and
        the difference decides what to do next: a 429 or 5xx is load that usually
        clears, so it is worth waiting on, while a 4xx means the key is rejected or
        the account cannot reach the model, and retrying can only fail again.
        """
        if self._client is None:
            raise LlmUnavailable("NVIDIA_API_KEY is unset")

        failures: list[str] = []

        for attempt in range(1, settings.llm_max_attempts + 1):
            try:
                completion = self._client.chat.completions.create(
                    model=settings.llm_model,
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_prompt},
                    ],
                    temperature=settings.llm_temperature,
                    top_p=settings.llm_top_p,
                    max_tokens=max_tokens or settings.llm_max_tokens,
                    stream=False,
                )
                answer = (completion.choices[0].message.content or "").strip()
                if answer:
                    return answer
                failures.append(f"attempt {attempt}: model returned no content")
            except APIStatusError as exc:
                status = exc.status_code
                if status == 429 or status >= 500:
                    failures.append(f"attempt {attempt}: upstream {status} {exc}")
                    if attempt < settings.llm_max_attempts:
                        self._backoff(attempt)
                        continue
                else:
                    # 401/403: key rejected. 404: model gone. Neither gets better
                    # by asking again, so stop instead of burning the attempts.
                    failures.append(f"rejected by API: {status} {exc}")
                    break
            except APIConnectionError as exc:
                # Timeout or DNS/TLS failure: worth another go.
                failures.append(f"attempt {attempt}: connection failed: {exc}")
                if attempt < settings.llm_max_attempts:
                    self._backoff(attempt)
            except OpenAIError as exc:
                failures.append(f"attempt {attempt}: {exc}")
                break

        reason = "; ".join(failures) or "no usable model configured"
        logger.error("%s could not answer: %s", settings.llm_model, reason)
        raise LlmUnavailable(reason)

    def _stream(self, user_prompt: str) -> Iterator[str]:
        """Yield answer text as NVIDIA produces it, with the same retry policy.

        A streamed call fails while it is being read rather than when it is opened,
        so the whole iteration is inside the attempt. The model is a reasoning
        model: it emits `reasoning_content` before any answer, and those deltas are
        skipped so only the answer itself reaches the browser.
        """
        if self._client is None:
            raise LlmUnavailable("NVIDIA_API_KEY is unset")

        failures: list[str] = []

        for attempt in range(1, settings.llm_max_attempts + 1):
            emitted = False
            try:
                stream = self._client.chat.completions.create(
                    model=settings.llm_model,
                    messages=[
                        {"role": "system", "content": SYSTEM_PROMPT},
                        {"role": "user", "content": user_prompt},
                    ],
                    temperature=settings.llm_temperature,
                    top_p=settings.llm_top_p,
                    max_tokens=settings.llm_max_tokens,
                    stream=True,
                )
                for chunk in stream:
                    if not chunk.choices:
                        continue
                    text = chunk.choices[0].delta.content
                    if text:
                        emitted = True
                        yield text

                if emitted:
                    return

                # An empty stream is what a reasoning model returns when its
                # thinking consumed the whole output allowance, so it is retried
                # rather than answered with nothing.
                failures.append(f"attempt {attempt}: model returned no content")
            except APIStatusError as exc:
                status = exc.status_code
                if emitted:
                    # Part of the answer is already on screen. A retry would replay
                    # the whole answer underneath it, leaving the user reading the
                    # same sentence twice with nothing between the halves.
                    failures.append(f"attempt {attempt}: stream broke after partial output: {exc}")
                    break
                if status == 429 or status >= 500:
                    failures.append(f"attempt {attempt}: upstream {status} {exc}")
                    if attempt < settings.llm_max_attempts:
                        self._backoff(attempt)
                        continue
                else:
                    failures.append(f"rejected by API: {status} {exc}")
                    break
            except APIConnectionError as exc:
                if emitted:
                    # Same as above: a dropped connection mid-answer is reported as
                    # an interruption, not repaired by starting over.
                    failures.append(
                        f"attempt {attempt}: connection dropped after partial output: {exc}"
                    )
                    break
                failures.append(f"attempt {attempt}: connection failed: {exc}")
                if attempt < settings.llm_max_attempts:
                    self._backoff(attempt)
            except OpenAIError as exc:
                failures.append(f"attempt {attempt}: {exc}")
                break

        reason = "; ".join(failures) or "no usable model configured"
        logger.error("%s could not answer: %s", settings.llm_model, reason)
        raise LlmUnavailable(reason)

    def _backoff(self, attempt: int) -> None:
        delay = settings.llm_retry_base_seconds * (2 ** (attempt - 1))
        logger.warning(
            "%s unavailable (attempt %s/%s), retrying in %.1fs",
            settings.llm_model, attempt, settings.llm_max_attempts, delay,
        )
        time.sleep(delay)

    def generate_title(self, first_message: str) -> str:
        """A short label for a conversation, from its first user message.

        The model names the thread once, right after its first exchange, so a
        new conversation appears on the sidebar as something to read rather than
        as "New conversation". The reply is a title but can still carry quotes
        or run long, so it is always cleaned and bounded; if the model is
        unavailable, the message itself is truncated to the same length.
        """
        try:
            raw = self._complete(
                first_message,
                system_prompt=TITLE_SYSTEM_PROMPT,
                max_tokens=TITLE_MAX_TOKENS,
            )
        except LlmUnavailable as exc:
            logger.warning("title generation skipped, truncating instead: %s", exc.reason)
            return truncate_title(first_message)

        cleaned = raw.strip().strip('"').strip("'").rstrip(".")
        return truncate_title(cleaned)

    def ask_stream(self, question: str) -> Iterator[dict]:
        """Answer as a sequence of events, so the caller can render it as it lands.

        Emits a `status` saying the answer is being written, one `delta` per piece
        of answer text, and exactly one `done` carrying the final answer.

        The citations ride only on that closing `done` event, never on an event
        of their own part way through. A client that draws citations while the
        answer is still being written is asserting the sources before it has the
        text they are supposed to support, and `done` can still replace the answer
        with `NOT_FOUND` or `PERSONAL`, which cite nothing at all. So `done` is the
        authority on everything: it decides what the answer was and which sources
        belong to it, and a client renders the citation block only once it arrives.
        """
        # Small talk first: a greeting answered from retrieval is a "not found in
        # the documents", which reads as a confused assistant rather than an
        # honest one. No retrieval, no context — there is nothing to look up.
        if is_greeting(question):
            yield {"type": "status", "stage": "writing"}
            answer = self.greet(question)
            yield {"type": "delta", "text": answer}
            yield {
                "type": "done",
                "answer": answer,
                "answered": True,
                "status": "greeting",
                "sources": [],
            }
            return

        if is_personal_question(question):
            yield {"type": "done", "answer": PERSONAL_MSG, "answered": False, "sources": []}
            return

        nodes = self._retrieve(question)

        if not nodes:
            yield {"type": "done", "answer": FALLBACK_MSG, "answered": False, "sources": []}
            return

        sources = [
            {
                "document": n.metadata["policy_title"],
                "section": n.metadata["section"],
                "snippet": n.get_content(metadata_mode=MetadataMode.NONE)[:200],
                "score": round(float(n.score or 0), 3),
            }
            for n in nodes
        ]
        context = "\n\n".join(
            f"({n.metadata['policy_title']} > {n.metadata['section']})\n"
            f"{n.get_content(metadata_mode=MetadataMode.NONE)}"
            for n in nodes
        )
        user_prompt = USER_PROMPT.format(context=context, question=question)

        # Retrieval is done, but no answer text exists yet. The model thinks for a
        # while before its first word, so a stream that only spoke up when text
        # arrived would leave the browser on a spinner for the whole wait. The
        # event says the answer is being worked on, which is what is actually
        # happening, and it reaches the client before the model is called.
        yield {"type": "status", "stage": "writing"}

        parts: list[str] = []
        for delta in self._stream(user_prompt):
            parts.append(delta)
            yield {"type": "delta", "text": delta}

        text = "".join(parts).strip()
        logger.info("answered %r via %s", question, settings.llm_model)

        if "PERSONAL" == text:
            yield {"type": "done", "answer": PERSONAL_MSG, "answered": False, "sources": []}
        elif "NOT_FOUND" in text:
            yield {"type": "done", "answer": FALLBACK_MSG, "answered": False, "sources": []}
        else:
            yield {"type": "done", "answer": text, "answered": True, "sources": sources}

    def ask(self, question: str) -> dict:
        if is_greeting(question):
            answer = self.greet(question)
            return {"answer": answer, "answered": True, "status": "greeting", "sources": []}

        if is_personal_question(question):
            return {"answer": PERSONAL_MSG, "answered": False, "sources": []}

        nodes = self._retrieve(question)

        if not nodes:
            return {"answer": FALLBACK_MSG, "answered": False, "sources": []}

        context = "\n\n".join(
            f"({n.metadata['policy_title']} > {n.metadata['section']})\n"
            f"{n.get_content(metadata_mode=MetadataMode.NONE)}"
            for n in nodes
        )
        text = self._complete(USER_PROMPT.format(context=context, question=question))
        logger.info("answered %r via %s", question, settings.llm_model)

        if "PERSONAL" == text:
            return {"answer": PERSONAL_MSG, "answered": False, "sources": []}
        if "NOT_FOUND" in text:
            return {"answer": FALLBACK_MSG, "answered": False, "sources": []}

        sources = [
            {
                "document": n.metadata["policy_title"],
                "section": n.metadata["section"],
                "snippet": n.get_content(metadata_mode=MetadataMode.NONE)[:200],
                "score": round(float(n.score or 0), 3),
            }
            for n in nodes
        ]
        return {"answer": text, "answered": True, "sources": sources}

    def greet(self, question: str) -> str:
        """A polite reply to small talk, from the model and nothing else.

        No retrieval and no policy context: there is nothing to ground it in,
        and the model is told to keep it to a greeting. Falls back to a static
        reply when the model cannot be reached, so an outage does not turn
        "hello" into an error.
        """
        try:
            raw = self._complete(
                question,
                system_prompt=GREETING_SYSTEM_PROMPT,
                max_tokens=GREETING_MAX_TOKENS,
            )
        except LlmUnavailable as exc:
            logger.warning("greeting answered statically: %s", exc.reason)
            return GREETING_FALLBACK

        return raw.strip() or GREETING_FALLBACK

    def _retrieve(self, question: str) -> list:
        """The retrieved chunks worth answering from, or none at all.

        A failure here is a call to the same NVIDIA account as the model, so a
        rejected key or a throttled tier shows up before generation is even tried.
        """
        try:
            retrieved = self.retriever.retrieve(question)
        except OpenAIError as exc:
            raise LlmUnavailable(f"embedding/retrieval failed: {exc}") from exc

        return [n for n in retrieved if (n.score or 0) >= settings.min_score]