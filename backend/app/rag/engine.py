import logging
import time
from collections.abc import Iterator, Sequence

from llama_index.core import VectorStoreIndex
from llama_index.core.schema import MetadataMode
from openai import APIConnectionError, APIStatusError, OpenAI, OpenAIError

from app.config import settings
from app.rag.guard import (
    CLASSIFIER_SYSTEM_PROMPT,
    Category,
    Classification,
    build_classifier_prompt,
    is_greeting,
    is_personal_question,
    parse_classification,
)
from app.rag.retrieval import (
    Candidate,
    HybridRetriever,
    KeywordIndex,
    retrieval_confidence,
)

logger = logging.getLogger(__name__)

# In scope, and the documents genuinely do not cover it. Named HR because a
# missing policy is a gap in what the corpus holds, and HR owns the corpus.
FALLBACK_MSG = (
    "I couldn't find that in the company documents. "
    "Please contact HR at hr@acmetech.example or +233 30 000 0000."
)
PERSONAL_MSG = (
    "I can only answer general policy questions and I can't access personal "
    "records such as leave balances, salaries or payslips. Please check the HR "
    "self-service portal on the intranet, or contact HR at hr@acmetech.example."
)
# Never in scope, so it is not a gap in the corpus and there is nothing for HR to
# supply. This is deliberately a different sentence from FALLBACK_MSG: telling
# somebody to contact HR about the number of presidents a country has had claims
# a company policy exists on the subject, and reads as though the assistant
# misunderstood the question rather than as one that was never going to be
# answered here.
OUT_OF_SCOPE_MSG = (
    "I'm built to answer questions about company policies, processes and internal "
    "documents, so that isn't something I can help with. Is there something about "
    "company policy or procedures I can look up for you instead?"
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

# A follow-up arrives as a standalone question that has lost the thread it belongs
# to, so the earlier turns are put back in front of the generator. Without them
# "What else does the Code of Conduct cover?" is answerable but reads as a fresh
# question, and the answer restates what was just said. The context is still the
# only source of facts; the conversation is there to tell the model what "else",
# "that" and "it" were.
FOLLOW_UP_USER_PROMPT = """Conversation so far:
{conversation}

Context:
{context}

Question: {question}
Answer:"""

FOLLOW_UP_SYSTEM_PROMPT = """You are the Internal Knowledge Assistant for Acme \
Technologies. Answer the question using ONLY the context given in the user message.
Be concise, and use numbered steps when the source describes a process.

This question follows earlier ones in the same conversation. Build on them: do not
repeat what has already been said, and answer the part that is actually new.

Rules:
- If the context does not contain the answer, reply with exactly: NOT_FOUND
- If the question asks about the asker's own personal records (their own leave
  balance, salary, payslip, appraisal), reply with exactly: PERSONAL
- Never use outside knowledge."""

# Output budget for classifying a message. Two short lines, but the configured
# model reasons before it writes, so the same reasoning-model budget as the other
# small calls: a few dozen tokens went entirely to thinking and came back empty.
CLASSIFIER_MAX_TOKENS = 256

# How many of the stored messages are handed to the classifier. Two turns is
# enough for "what about contractors?" to be recognisable, and a longer window
# costs tokens on every question to answer a case that does not arise. Sent
# oldest-first.
HISTORY_MESSAGES = 4

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
        # `vector_candidates`, not `top_k`: the depth is what decides which chunks
        # the keyword leg is allowed to rescue, and a retriever built at `top_k`
        # would only ever have looked at four chunks for it to rescue from.
        self.retriever = index.as_retriever(
            similarity_top_k=settings.vector_candidates
        )
        # Both searches run over the same chunks the vector index holds, so the
        # keyword side is built from its docstore rather than from a second copy
        # of the corpus elsewhere. Built once, here, because scoring it is a pass
        # over 62 chunks and doing that per question would cost more than it saves.
        self.retrieval = HybridRetriever(
            self.retriever,
            KeywordIndex(index.docstore.docs.values()),
            top_k=settings.top_k,
            vector_candidates=settings.vector_candidates,
            keyword_candidates=settings.keyword_candidates,
            min_score=settings.min_score,
            keyword_min_score=settings.keyword_min_score,
            recall_floor=settings.recall_floor,
            recall_candidates=settings.recall_candidates,
        )
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

    def _stream(
        self, user_prompt: str, system_prompt: str = SYSTEM_PROMPT
    ) -> Iterator[str]:
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
                        {"role": "system", "content": system_prompt},
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

    def ask_stream(
        self, question: str, history: Sequence[tuple[str, str]] = ()
    ) -> Iterator[dict]:
        """Answer as a sequence of events, so the caller can render it as it lands.

        Emits a `status` saying the answer is being worked on, one `delta` per
        piece of answer text, and exactly one `done` carrying the final answer.

        The citations ride only on that closing `done` event, never on an event
        of their own part way through. A client that draws citations while the
        answer is still being written is asserting the sources before it has the
        text they are supposed to support, and `done` can still replace the answer
        with `NOT_FOUND` or `PERSONAL`, which cite nothing at all. So `done` is the
        authority on everything: it decides what the answer was and which sources
        belong to it, and a client renders the citation block only once it arrives.

        `history` is the recent turns as `(role, text)` pairs, oldest first and
        excluding the message being answered. It is what lets a follow-up be
        recognised as one, and what a follow-up's answer is written against.
        """
        classification = self.classify(question, history)

        # Small talk and out-of-scope are answered before anything is retrieved.
        # Both are cases where the documents cannot help: there is nothing to look
        # up in the first case, and in the second there is no answer to be found
        # however many chunks are read. Retrieving first and filtering afterwards
        # was how an off-topic question used to come back as "not found in the
        # company documents", which claims a gap in the corpus that is not there.
        if classification.category is Category.GREETING:
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

        if classification.category is Category.OUT_OF_SCOPE:
            yield {
                "type": "done",
                "answer": OUT_OF_SCOPE_MSG,
                "answered": False,
                "status": "out-of-scope",
                "sources": [],
                "confidence": None,
            }
            return

        if classification.category is Category.PERSONAL:
            yield {
                "type": "done",
                "answer": PERSONAL_MSG,
                "answered": False,
                "status": "restricted",
                "sources": [],
                "confidence": None,
            }
            return

        candidates = self._retrieve(classification.query)

        if not candidates:
            yield {
                "type": "done",
                "answer": FALLBACK_MSG,
                "answered": False,
                "status": "not-found",
                "sources": [],
                "confidence": None,
            }
            return

        sources = [_source(candidate) for candidate in candidates]
        # How well the passages matched, worked out before the model is called. It
        # describes the evidence and not the answer, which is why it is available
        # here and does not depend on what the model goes on to write.
        confidence = retrieval_confidence(candidates)
        user_prompt, system_prompt = _generation_prompt(
            classification, candidates, history
        )

        # Retrieval is done, but no answer text exists yet. The model thinks for a
        # while before its first word, so a stream that only spoke up when text
        # arrived would leave the browser on a spinner for the whole wait. The
        # event says the answer is being worked on, which is what is actually
        # happening, and it reaches the client before the model is called.
        yield {"type": "status", "stage": "writing"}

        parts: list[str] = []
        for delta in self._stream(user_prompt, system_prompt=system_prompt):
            parts.append(delta)
            yield {"type": "delta", "text": delta}

        text = "".join(parts).strip()
        logger.info("answered %r via %s", question, settings.llm_model)

        if "PERSONAL" == text:
            yield {
                "type": "done",
                "answer": PERSONAL_MSG,
                "answered": False,
                "status": "restricted",
                "sources": [],
                "confidence": None,
            }
        elif "NOT_FOUND" in text:
            yield {
                "type": "done",
                "answer": FALLBACK_MSG,
                "answered": False,
                "status": "not-found",
                "sources": [],
                "confidence": None,
            }
        else:
            yield {
                "type": "done",
                "answer": text,
                "answered": True,
                "sources": sources,
                "confidence": confidence,
            }

    def ask(self, question: str, history: Sequence[tuple[str, str]] = ()) -> dict:
        """The same answer as `ask_stream`, in one piece rather than as events."""
        classification = self.classify(question, history)

        if classification.category is Category.GREETING:
            answer = self.greet(question)
            return {
                "answer": answer,
                "answered": True,
                "status": "greeting",
                "sources": [],
                "confidence": None,
            }

        if classification.category is Category.OUT_OF_SCOPE:
            return {
                "answer": OUT_OF_SCOPE_MSG,
                "answered": False,
                "status": "out-of-scope",
                "sources": [],
                "confidence": None,
            }

        if classification.category is Category.PERSONAL:
            return {
                "answer": PERSONAL_MSG,
                "answered": False,
                "status": "restricted",
                "sources": [],
                "confidence": None,
            }

        candidates = self._retrieve(classification.query)

        if not candidates:
            return {
                "answer": FALLBACK_MSG,
                "answered": False,
                "status": "not-found",
                "sources": [],
                "confidence": None,
            }

        confidence = retrieval_confidence(candidates)
        user_prompt, system_prompt = _generation_prompt(
            classification, candidates, history
        )
        text = self._complete(user_prompt, system_prompt=system_prompt)
        logger.info("answered %r via %s", question, settings.llm_model)

        if "PERSONAL" == text:
            return {
                "answer": PERSONAL_MSG,
                "answered": False,
                "status": "restricted",
                "sources": [],
                "confidence": None,
            }
        if "NOT_FOUND" in text:
            return {
                "answer": FALLBACK_MSG,
                "answered": False,
                "status": "not-found",
                "sources": [],
                "confidence": None,
            }

        return {
            "answer": text,
            "answered": True,
            "sources": [_source(candidate) for candidate in candidates],
            "confidence": confidence,
        }

    def classify(
        self, question: str, history: Sequence[tuple[str, str]] = ()
    ) -> Classification:
        """What this message is, decided before anything is retrieved.

        Greeting and personal-record questions are matched by pattern, with no
        model call: both are exact-match judgements that a model could only make
        less reliably, and a greeting must not stop working when the model does.
        Everything else goes to the model with the recent turns attached, because
        a follow-up cannot be recognised from its own words and an out-of-scope
        question can be worded in too many ways to list.

        A model that cannot be reached is treated as saying nothing useful, which
        `parse_classification` reads as `QUESTION`: the ordinary retrieval path
        decides, exactly as it did before classification existed. The alternative
        — treating an outage as out-of-scope — would have every question answered
        with "that isn't something I can help with" for as long as the outage
        lasted.
        """
        if is_greeting(question):
            return Classification(Category.GREETING, question)

        if is_personal_question(question):
            return Classification(Category.PERSONAL, question)

        try:
            reply = self._complete(
                build_classifier_prompt(question, history),
                system_prompt=CLASSIFIER_SYSTEM_PROMPT,
                max_tokens=CLASSIFIER_MAX_TOKENS,
            )
        except LlmUnavailable as exc:
            logger.warning("classification skipped, treating as a question: %s", exc.reason)
            return Classification(Category.QUESTION, question)

        classification = parse_classification(reply, question)
        logger.info(
            "classified %r as %s (raw reply: %r)",
            question,
            classification.category.value,
            reply,
        )

        # Only a follow-up uses the rewritten wording. For everything else the
        # user's own words are what gets retrieved: the rewrite is the model's
        # paraphrase, and paraphrasing a question that was already standalone can
        # only lose detail from it — a figure, a name, a period — for no gain,
        # since there was nothing to resolve.
        if classification.category is not Category.FOLLOW_UP:
            return Classification(classification.category, question)

        if classification.query != question:
            logger.info("follow-up rewritten for retrieval: %r -> %r", question, classification.query)

        return classification

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

    def _retrieve(self, query: str) -> list[Candidate]:
        """The chunks worth answering from, or none at all.

        Both searches, fused — see `app/rag/retrieval.py`. Nothing here can fail
        the question outright: a vector search that errors degrades to the keyword
        half, and a question with no usable keywords comes back empty, which the
        caller reports as a gap in the corpus rather than as an outage.
        """
        return self.retrieval.retrieve(query)


def _source(candidate: Candidate) -> dict:
    """One citation, as the API reports it.

    The score is the chunk's own cosine similarity, which is the number a reader of
    the API has always seen and is on a scale they can reason about. It is
    deliberately *not* the fusion score: that is a sum of reciprocal ranks over two
    searches, so it is comparable between chunks in one answer but means nothing
    across answers, and quoting it as "the score" would invite exactly that
    comparison.

    Every cited chunk carries a real similarity, including one the keyword half
    rescued from under the floor. Reporting those as no score — or as zero — would
    misdescribe them twice over: "zero" reads as no similarity at all, when the
    truth is that it was measured and came out low. Zero is reserved for a chunk
    the vector search genuinely never scored, which happens only if it failed
    outright, and in that case the log says so.
    """
    node = candidate.node

    return {
        "document": node.metadata["policy_title"],
        "section": node.metadata["section"],
        "snippet": node.get_content(metadata_mode=MetadataMode.NONE)[:200],
        "score": (
            round(candidate.similarity, 3) if candidate.similarity is not None else 0.0
        ),
    }


def _generation_prompt(
    classification: Classification,
    candidates: Sequence[Candidate],
    history: Sequence[tuple[str, str]],
) -> tuple[str, str]:
    """The prompt and system message this answer is generated from.

    A follow-up is generated against the conversation as well as the context, so
    the answer continues the thread rather than opening a new one. The context is
    still the only source of facts either way.
    """
    context = "\n\n".join(
        f"({candidate.node.metadata['policy_title']} > {candidate.node.metadata['section']})\n"
        f"{candidate.node.get_content(metadata_mode=MetadataMode.NONE)}"
        for candidate in candidates
    )

    if classification.category is not Category.FOLLOW_UP:
        return USER_PROMPT.format(context=context, question=classification.query), SYSTEM_PROMPT

    conversation = "\n".join(
        f"{'Employee' if role == 'user' else 'Assistant'}: {' '.join(text.split())[:600]}"
        for role, text in history
    )

    return (
        FOLLOW_UP_USER_PROMPT.format(
            conversation=conversation,
            context=context,
            question=classification.query,
        ),
        FOLLOW_UP_SYSTEM_PROMPT,
    )