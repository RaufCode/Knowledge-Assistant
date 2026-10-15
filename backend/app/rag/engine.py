import logging
import re
import time
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass
from enum import Enum

from llama_index.core import VectorStoreIndex
from llama_index.core.schema import MetadataMode
from openai import APIConnectionError, APIStatusError, OpenAI, OpenAIError

from app.config import settings
from app.rag.capabilities import (
    CAPABILITIES_BRIEF,
    CAPABILITIES_REPLY,
    CONVERSATIONAL_FALLBACK,
)
from app.rag.guard import (
    CLASSIFIER_SYSTEM_PROMPT,
    Category,
    Classification,
    asks_about_capabilities,
    build_classifier_prompt,
    classify_by_rules,
    is_restricted_request,
    parse_classification,
)
from app.rag.retrieval import (
    Candidate,
    HybridRetriever,
    KeywordIndex,
    chunk_key,
    retrieval_confidence,
)

logger = logging.getLogger(__name__)


class ResponseKind(str, Enum):
    """What kind of reply this is, which is what decides how it is drawn.

    On every response and on the stream's closing event, and stored on the
    assistant's message so a reloaded conversation draws the same thing it drew
    live.

    The point of naming these is that "not answered" is not one thing. `not_found`
    is the only one of them that is a statement about the corpus, and therefore the
    only one that may be dressed as "not found in company documents" with a route
    to HR attached: an out-of-scope reply and a refusal say something else
    entirely, and drawing either of them as a failed search tells the reader the
    documents have a gap where the truth is that the question was never theirs or
    was never answered on purpose.
    """

    ANSWER = "answer"
    NOT_FOUND = "not_found"
    OUT_OF_SCOPE = "out_of_scope"
    CONVERSATIONAL = "conversational"
    RESTRICTED = "restricted"
    NO_MORE_INFO = "no_more_info"


# The vocabulary the wire used before `kind` existed, kept so a client that has
# not been redeployed still draws these replies recognisably. `kind` is what
# everything current reads.
LEGACY_STATUS: dict[ResponseKind, str] = {
    ResponseKind.ANSWER: "answered",
    ResponseKind.NOT_FOUND: "not-found",
    ResponseKind.OUT_OF_SCOPE: "out-of-scope",
    ResponseKind.CONVERSATIONAL: "greeting",
    ResponseKind.RESTRICTED: "restricted",
    ResponseKind.NO_MORE_INFO: "no-more-info",
}


@dataclass(frozen=True)
class PreviousAnswer:
    """The exchange this message follows, as far as answering it needs to know.

    Read from the conversation's own record rather than from the in-memory stream,
    so it survives a reload: a reader who asks "anything else?" tomorrow after a
    page refresh gets the same continuation the same day.

    `kind` is there for one rule — a follow-up to a refusal is a refusal, however
    it is phrased — and `sources` and `cited` for another: the sources say which
    documents and sections the topic lives in, and `cited` is every chunk id the
    conversation has already shown, so the continuation can be answered from what
    is left rather than repeating what the reader has already read.
    """

    kind: str | None = None
    question: str = ""
    answer: str = ""
    sources: tuple[Mapping[str, object], ...] = ()
    cited: frozenset[str] = frozenset()


# The vocabulary the wire used before `kind` existed, kept so a client that has
# not been redeployed still draws these replies recognisably. `kind` is what
# everything current reads.
# In scope, and the documents genuinely do not cover it. Named HR because a
# missing policy is a gap in what the corpus holds, and HR owns the corpus.
FALLBACK_MSG = (
    "I couldn't find that in the company documents. "
    "Please contact HR at hr@acmetech.example or +233 30 000 0000."
)
# The refusal is the same whether the record is the asker's own or somebody else's,
# and that is deliberate. It says what this assistant does not share; it does not
# say whether a record exists, who has one, or what any document says about it. A
# refusal that distinguished "there is no record of that" from "there is, but not
# for you" would answer the question the reader was refused.
PERSONAL_MSG = (
    "I can only answer general policy questions and I can't access personal "
    "records such as leave balances, salaries or payslips. Please check the HR "
    "self-service portal on the intranet, or contact HR at hr@acmetech.example."
)
# The documents behind the topic being continued are used up. Not a gap in the
# corpus and not a failure: the reader has been given everything those sections
# say, and the useful thing to do now is offer a different policy rather than a
# dead end or a false claim that something is missing.
EXHAUSTED_MSG = (
    "That covers everything the documents say on this topic. "
    "Is there another policy I can look up?"
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

# An expansion is told apart from a follow-up by its context, not its question:
# everything here has already been answered, and the passages the previous answer
# cited have been removed from the pool. So the job is to say what is *left*, and
# the previous answer is in the prompt precisely so the model knows what it must
# not say again.
EXPANSION_USER_PROMPT = """Conversation so far:
{conversation}

Already covered by the last answer:
{covered}

Context — the rest of the same documents:
{context}

Question: {question}
Answer:"""

EXPANSION_SYSTEM_PROMPT = """You are the Internal Knowledge Assistant for Acme \
Technologies, continuing an answer the reader has already been given.

Everything they have already been told is listed in the user message, and the \
context holds only what those same documents say beyond it. Add what is missing and \
nothing else:

- Do not repeat, restate or reword anything in the "already covered" list. The \
reader has read it.
- Do not open with "In addition" or any other connective. Begin with the new point.
- If the context adds nothing beyond what was already covered, reply with exactly: \
NOT_FOUND. It will be turned into a statement that those documents are exhausted, \
which is the truth.
- Never use outside knowledge, and never state a company fact that is not in the \
context."""

# The generator signals "nothing here" by replying with a sentinel rather than an
# answer, and the sentinel is compared as text. That is fragile in one direction
# worth closing: the model sometimes writes the same words as a sentence — "Not
# found." — and a comparison for the exact token lets that through as an answer
# whose whole content is that it found nothing. These are the spellings of the
# sentinel that mean the same thing; anything longer than this is a real answer
# that happens to use the words.
NOT_FOUND_REPLY = re.compile(r"^(?:not[ _-]?found|nothing found|no information found)\.?$", re.I)

PERSONAL_REPLY = re.compile(r"^personal\.?$", re.I)

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

# Output budget for a conversational reply. Generous for three sentences, because
# the configured model is a reasoning model that spends tokens thinking before it
# writes anything: a budget of a few dozen was consumed by the thinking and the
# call came back with no content at all.
CONVERSATIONAL_MAX_TOKENS = 256

# A conversational message gets no retrieval and no policy context: there is
# nothing to look up, and handing the policies over would only invite quoting them
# at small talk. What it does get is the recent conversation, because the whole
# content of a reply like "You're right, no question yet" is what was said in it.
CONVERSATIONAL_USER_PROMPT = """Conversation so far:
{conversation}

Message: {message}"""

CONVERSATIONAL_SYSTEM_PROMPT = f"""{CAPABILITIES_BRIEF}

The last message above is not a request for information: it is small talk, an
acknowledgement, a remark or correction about the exchange itself, or a question
about you. Reply to it in one to three short sentences, warm and direct, the way a
colleague would. Acknowledge what they actually said — "you're right, no question
yet", "sorry about that, tell me again" — rather than deflecting, and do not
repeat an introduction you have already given.

Hard limits:
- Never state a company fact, policy, figure or process. You have no documents in
  front of you on this path, so anything specific would be invention.
- Never say that something is not in the documents, and never mention documents,
  retrieval, indexing or searching at all.
- Never promise anything beyond the abilities described above.
- No lists, no headings, no markdown, no emoji."""


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
        self,
        user_prompt: str,
        system_prompt: str = SYSTEM_PROMPT,
        max_tokens: int | None = None,
    ) -> Iterator[str]:
        """Yield answer text as NVIDIA produces it, with the same retry policy.

        A streamed call fails while it is being read rather than when it is opened,
        so the whole iteration is inside the attempt. The model is a reasoning
        model: it emits `reasoning_content` before any answer, and those deltas are
        skipped so only the answer itself reaches the browser.

        `max_tokens` is the caller's own budget for the shorter replies, which are
        not the answer's business: a three-sentence acknowledgement given an
        answer's budget is an invitation to fill it.
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
                    max_tokens=max_tokens or settings.llm_max_tokens,
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

    def generate_title(self, first_question: str) -> str:
        """A short label for a conversation, from the first real question in it.

        The model names the thread once, right after that exchange, so a new
        conversation appears on the sidebar as something to read rather than as
        "New conversation". The caller decides which message is worth naming —
        a greeting is not, and a sidebar of conversations called "Hey" is worse
        than a sidebar of untitled ones.

        The reply is a title but can still carry quotes or run long, so it is
        always cleaned and bounded; if the model is unavailable, the question
        itself is truncated to the same length.
        """
        try:
            raw = self._complete(
                first_question,
                system_prompt=TITLE_SYSTEM_PROMPT,
                max_tokens=TITLE_MAX_TOKENS,
            )
        except LlmUnavailable as exc:
            logger.warning("title generation skipped, truncating instead: %s", exc.reason)
            return truncate_title(first_question)

        cleaned = raw.strip().strip('"').strip("'").rstrip(".")
        return truncate_title(cleaned)

    def ask_stream(
        self,
        question: str,
        history: Sequence[tuple[str, str]] = (),
        classification: Classification | None = None,
        previous: PreviousAnswer | None = None,
    ) -> Iterator[dict]:
        """Answer as a sequence of events, so the caller can render it as it lands.

        Emits a `status` saying the answer is being worked on, one `delta` per
        piece of answer text, and exactly one `done` carrying the final answer and
        the `kind` of reply it is. Every kind streams the same way: the difference
        between an answer and a reply that cites nothing is drawn by the client,
        not by a different shape of stream.

        The citations ride only on that closing `done` event, never on an event
        of their own part way through. A client that draws citations while the
        answer is still being written is asserting the sources before it has the
        text they are supposed to support, and `done` can still replace the answer
        with a refusal or a `NOT_FOUND`, which cite nothing at all. So `done` is
        the authority on everything: it decides what the answer was, which kind of
        reply it is, and which sources belong to it.

        `history` is the recent turns as `(role, text)` pairs, oldest first and
        excluding the message being answered. It is what lets a follow-up be
        recognised as one, what a follow-up's answer is written against, and what
        a conversational reply acknowledges.

        `classification` and `previous` are the caller's, when it has already read
        them: the route classifies once for two reasons — what to say, and whether
        the conversation is worth naming — and the previous answer is the same
        conversation's own record.
        """
        classification = classification or self.classify(question, history, previous)

        # Small talk, out-of-scope requests and refusals are all answered before
        # anything is retrieved. They are cases where the documents cannot help:
        # there is nothing to look up in the first, no answer to be found in the
        # second however many chunks are read, and the third is not an answer at
        # all. Retrieving first and filtering afterwards was how an off-topic
        # question came back as "not found in the company documents", which claims
        # a gap in the corpus that is not there.
        if classification.category is Category.CONVERSATIONAL:
            yield {"type": "status", "stage": "writing"}
            pieces: list[str] = []
            for piece in self.conversational_pieces(question, history):
                pieces.append(piece)
                yield {"type": "delta", "text": piece}
            yield {
                "type": "done",
                **_result(
                    _finish_conversational(pieces), ResponseKind.CONVERSATIONAL
                ),
            }
            return

        if classification.category is Category.OUT_OF_SCOPE:
            yield {"type": "status", "stage": "writing"}
            yield {"type": "delta", "text": OUT_OF_SCOPE_MSG}
            yield {
                "type": "done",
                **_result(OUT_OF_SCOPE_MSG, ResponseKind.OUT_OF_SCOPE),
            }
            return

        if classification.category is Category.RESTRICTED:
            # Before retrieval, always, and never on the strength of what retrieval
            # found: a question about a colleague's pay has no chunk to find, which
            # used to be the only thing standing between it and a reply saying the
            # documents do not cover it. Nothing here is quoted from the documents
            # either — the notice is the same one for any record, and says what is
            # not shared rather than whether anything exists.
            yield {"type": "status", "stage": "writing"}
            yield {"type": "delta", "text": PERSONAL_MSG}
            yield {
                "type": "done",
                **_result(PERSONAL_MSG, ResponseKind.RESTRICTED),
            }
            return

        if classification.category is Category.EXPANSION:
            yield from self._expansion_events(question, history, previous)
            return

        candidates = self._retrieve(classification, previous)

        # From here on the message is a genuine in-scope question, so this is the
        # one path that may report a gap in the corpus.
        if not candidates:
            yield {
                "type": "done",
                **_result(FALLBACK_MSG, ResponseKind.NOT_FOUND),
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

        yield {"type": "done", **_settle(text, sources, confidence)}

    def ask(
        self,
        question: str,
        history: Sequence[tuple[str, str]] = (),
        classification: Classification | None = None,
        previous: PreviousAnswer | None = None,
    ) -> dict:
        """The same answer as `ask_stream`, in one piece rather than as events."""
        classification = classification or self.classify(question, history, previous)

        if classification.category is Category.CONVERSATIONAL:
            return _result(
                self.conversational_reply(question, history), ResponseKind.CONVERSATIONAL
            )

        if classification.category is Category.OUT_OF_SCOPE:
            return _result(OUT_OF_SCOPE_MSG, ResponseKind.OUT_OF_SCOPE)

        if classification.category is Category.RESTRICTED:
            return _result(PERSONAL_MSG, ResponseKind.RESTRICTED)

        if classification.category is Category.EXPANSION:
            return self._expansion(question, history, previous)

        candidates = self._retrieve(classification, previous)

        if not candidates:
            return _result(FALLBACK_MSG, ResponseKind.NOT_FOUND)

        confidence = retrieval_confidence(candidates)
        user_prompt, system_prompt = _generation_prompt(
            classification, candidates, history
        )
        text = self._complete(user_prompt, system_prompt=system_prompt)
        logger.info("answered %r via %s", question, settings.llm_model)

        return _settle(text, [_source(c) for c in candidates], confidence)

    def classify(
        self,
        question: str,
        history: Sequence[tuple[str, str]] = (),
        previous: PreviousAnswer | None = None,
    ) -> Classification:
        """What this message is, decided before anything is retrieved.

        Obvious small talk, obvious expansions and private-record requests are
        matched by pattern, with no model call: they are exact-match judgements a
        model could only make less reliably, a greeting must not stop working when
        the model does, and a refusal must not depend on a classifier call being
        available. Everything else goes to the model with the recent turns
        attached, because a remark about the conversation cannot be told from a
        question by pattern, a follow-up cannot be recognised from its own words,
        an out-of-scope request can be worded in too many ways to list, and the
        guard's patterns are bypassed by rephrasing.

        The confidentiality guard is applied twice, and the second time is the one
        that matters: to the *standalone* query, after a follow-up has been
        rewritten. "and his bonus?" is refused by the rules on the raw message, but
        a rewrite that turns it into "What is Kwame's bonus?" would otherwise be
        the form that got through — the message looks harmless and the query is the
        one that is retrieved. A follow-up to a refusal stays a refusal for the
        same reason: a reader who has just been told what is not shared is not
        asking a new question with "and what about...".

        A model that cannot be reached is treated as saying nothing useful, which
        `parse_classification` reads as `COMPANY_QUESTION`: the ordinary retrieval
        path decides, exactly as it did before classification existed. The
        alternative — treating an outage as out-of-scope — would have every
        question answered with "that isn't something I can help with" for as long
        as the outage lasted.
        """
        by_rule = classify_by_rules(question)

        if by_rule is not None:
            if by_rule is Category.EXPANSION:
                # A refusal has no passages behind it, so there is nothing an
                # expansion could continue from, and "anything else?" after being
                # told what is not shared is not a request for more of it. It stays
                # a refusal rather than being told a topic is exhausted.
                if previous is not None and previous.kind == ResponseKind.RESTRICTED.value:
                    return Classification(Category.RESTRICTED, question)

                # Already exhausted, so still an expansion: same passages, same
                # answer, rather than a fresh search of documents already read.
                if _topic_is_exhausted(previous):
                    return Classification(Category.EXPANSION, question)

                if not _has_previous_answer(previous):
                    # Nothing to continue from. "Anything else?" as the first
                    # message of a conversation is a follow-up with nothing to
                    # follow, so it takes the ordinary path and is judged on its
                    # merits like any other.
                    return Classification(Category.FOLLOW_UP, question)

            return Classification(by_rule, question)

        try:
            reply = self._complete(
                build_classifier_prompt(question, history),
                system_prompt=CLASSIFIER_SYSTEM_PROMPT,
                max_tokens=CLASSIFIER_MAX_TOKENS,
            )
        except LlmUnavailable as exc:
            logger.warning("classification skipped, treating as a question: %s", exc.reason)
            return Classification(Category.COMPANY_QUESTION, question)

        classification = parse_classification(reply, question)
        logger.info(
            "classified %r as %s (raw reply: %r)",
            question,
            classification.category.value,
            reply,
        )

        if classification.category is Category.EXPANSION and not _has_previous_answer(
            previous
        ):
            return Classification(Category.FOLLOW_UP, question)

        # The guard, again, on whatever will actually be retrieved or generated
        # against. Rules first so a rewrite cannot smuggle a request past them, and
        # the refusal inherited from the last turn so that "and his bonus?" after a
        # refusal is one.
        if (
            classification.category in {Category.FOLLOW_UP, Category.EXPANSION}
            and previous is not None
            and previous.kind == ResponseKind.RESTRICTED.value
        ):
            # Scoped to follow-ups and expansions on purpose: the turn after a
            # refusal is very often an ordinary question — "what is the leave
            # policy?" — and refusing that would be refusing the conversation
            # rather than the record.
            logger.info("follow-up to a refused turn stays refused: %r", question)
            return Classification(Category.RESTRICTED, question)

        if is_restricted_request(classification.query):
            return Classification(Category.RESTRICTED, classification.query)

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

    def _expansion_events(
        self,
        question: str,
        history: Sequence[tuple[str, str]],
        previous: PreviousAnswer | None,
    ) -> Iterator[dict]:
        """"Anything else?", answered from what the last answer had left.

        Never a `not_found`: the documents the reader is on have not run out of
        *topics*, and telling somebody the indexed documents do not cover "anything
        else" is a claim about the corpus that says nothing true about it.
        """
        yield {"type": "status", "stage": "writing"}

        answer, kind, sources, confidence = self._expansion(question, history, previous)

        for piece in _stream_pieces(answer):
            yield {"type": "delta", "text": piece}

        yield {"type": "done", **_result(answer, kind, sources, confidence)}

    def _expansion(
        self,
        question: str,
        history: Sequence[tuple[str, str]],
        previous: PreviousAnswer | None,
    ) -> tuple[str, ResponseKind, list[dict], int | None]:
        """The continuation, as text, kind, citations and confidence.

        Retrieval is anchored to the passages the last answer cited, with those
        passages themselves removed, so what reaches the generator is what the
        reader has not been shown yet. When there is nothing left, that is said
        plainly rather than reported as a gap in the corpus.
        """
        exhausted = (EXHAUSTED_MSG, ResponseKind.NO_MORE_INFO, [], None)

        if previous is None or not previous.sources or _topic_is_exhausted(previous):
            return exhausted

        anchors = {
            (str(source.get("document", "")), str(source.get("section", "")))
            for source in previous.sources
        }

        candidates = self.retrieval.retrieve_continuation(
            previous.question or previous.answer, anchors, previous.cited
        )

        if not candidates:
            logger.info("nothing left in %d anchored passages to continue", len(anchors))
            return exhausted

        user_prompt = EXPANSION_USER_PROMPT.format(
            conversation=_conversation(history, 600),
            covered=_covered(previous.answer),
            context=_context(candidates),
            question=question,
        )

        try:
            parts: list[str] = []
            for delta in self._stream(
                user_prompt, system_prompt=EXPANSION_SYSTEM_PROMPT
            ):
                parts.append(delta)

            text = "".join(parts).strip()
        except LlmUnavailable as exc:
            logger.warning("continuation unavailable, saying the sources are spent: %s", exc.reason)
            return exhausted

        logger.info("continued %r via %s", question, settings.llm_model)

        # The generator saying it has nothing left is the same fact as the passages
        # having nothing left, and it is reported the same way.
        if _declined(text) == "not_found" or not text:
            return exhausted

        sources = [_source(candidate) for candidate in candidates]

        return text, ResponseKind.ANSWER, sources, retrieval_confidence(candidates)

    def conversational_pieces(
        self, message: str, history: Sequence[tuple[str, str]] = ()
    ) -> Iterator[str]:
        """The reply to a message that is not a request for information.

        Nothing is retrieved and no policy context is handed over: there is nothing
        to ground a reply in, and giving the model the documents here would only
        invite quoting them at small talk. What it does get is the conversation, so
        "you're right, no question yet" is a reply to what was actually said rather
        than an introduction the reader has already read.

        Streamed like any other answer, so the exchange feels the same as one being
        answered from a document.

        A question about what this assistant is, and what it covers, is answered
        from `app/rag/capabilities.py` rather than generated at all. That is the
        one reply in the system where an improvised answer is a promise: a model
        asked what it can do will describe whatever would read best, including
        abilities this deployment does not have.
        """
        if asks_about_capabilities(message):
            yield CAPABILITIES_REPLY
            return

        try:
            yield from self._stream(
                _conversational_prompt(message, history),
                system_prompt=CONVERSATIONAL_SYSTEM_PROMPT,
                max_tokens=CONVERSATIONAL_MAX_TOKENS,
            )
        except LlmUnavailable as exc:
            # Anything already emitted is kept: it is the best half of a reply that
            # exists, and `_finish_conversational` decides what is usable.
            logger.warning("conversational reply interrupted: %s", exc.reason)

    def conversational_reply(
        self, message: str, history: Sequence[tuple[str, str]] = ()
    ) -> str:
        """`conversational_pieces` as one piece of text, for the unstreamed path."""
        return _finish_conversational(list(self.conversational_pieces(message, history)))

    def _retrieve(
        self, classification: Classification, previous: PreviousAnswer | None = None
    ) -> list[Candidate]:
        """The chunks worth answering from, or none at all.

        Both searches, fused — see `app/rag/retrieval.py`. Nothing here can fail
        the question outright: a vector search that errors degrades to the keyword
        half, and a question with no usable keywords comes back empty, which the
        caller reports as a gap in the corpus rather than as an outage.

        A follow-up gets a second attempt, and this is the only path that does.
        Its query is the model's paraphrase, and a paraphrase can land on wording
        the corpus does not use — "What else does the expectations document cover?"
        finds nothing, while the question that started the thread found plenty.
        So when the rewrite retrieves nothing, the question the reader actually
        asked is tried in its place. It is the same topic by definition, and the
        generator is still told it is continuing the thread; what changes is which
        words the search used. Only when that finds nothing either is the turn
        reported as a gap in the corpus.
        """
        candidates = self.retrieval.retrieve(classification.query)

        if candidates or classification.category is not Category.FOLLOW_UP:
            return candidates

        fallback = (previous.question if previous else "").strip()

        if not fallback or fallback == classification.query:
            return candidates

        logger.info(
            "follow-up retrieved nothing for %r; trying the question it continues: %r",
            classification.query,
            fallback,
        )

        return self.retrieval.retrieve(fallback)


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
        # Stable across restarts of the index, so "anything else?" knows which
        # passages it has already shown without keeping a second copy of the
        # conversation in memory. See `chunk_key`.
        "chunk_id": chunk_key(node),
        "score": (
            round(candidate.similarity, 3) if candidate.similarity is not None else 0.0
        ),
    }


def _declined(text: str) -> str | None:
    """Which sentinel the generator answered with, if it answered with one.

    The two sentinels are short and exact because they have to be unambiguous: a
    generator that writes "Not found." rather than the token has still said it
    found nothing, and shipping that as an answer whose entire content is that it
    found nothing is the one reading that cannot be defended afterwards. Anything
    longer than a sentinel is treated as an answer, including an answer that uses
    the words in passing.
    """
    cleaned = " ".join((text or "").split())

    if PERSONAL_REPLY.match(cleaned):
        return "personal"

    if NOT_FOUND_REPLY.match(cleaned):
        return "not_found"

    # The token can also arrive with a little of the reasoning model around it,
    # which is what the substring test catches.
    if "PERSONAL" in cleaned:
        return "personal"

    if "NOT_FOUND" in cleaned:
        return "not_found"

    return None


def _settle(text: str, sources: list[dict], confidence: int | None) -> dict:
    """The closing event for a generated answer, whatever it turned out to be.

    A refusal drops the citations and the figure on the way through: neither is
    evidence when the answer is that nothing is shared, and a confidence score
    beside a refusal would describe a measurement nobody made.
    """
    declined = _declined(text)

    if declined == "personal":
        return _result(PERSONAL_MSG, ResponseKind.RESTRICTED)

    if declined == "not_found":
        return _result(FALLBACK_MSG, ResponseKind.NOT_FOUND)

    return _result(text, ResponseKind.ANSWER, sources, confidence)


def _context(candidates: Sequence[Candidate]) -> str:
    """The passages a generator is given, each labelled with where it came from."""
    return "\n\n".join(
        f"({candidate.node.metadata['policy_title']} > {candidate.node.metadata['section']})\n"
        f"{candidate.node.get_content(metadata_mode=MetadataMode.NONE)}"
        for candidate in candidates
    )


def _covered(answer: str) -> str:
    """What the last answer already said, so the continuation can leave it out."""
    return " ".join((answer or "").split())[:2000] or "(nothing yet)"


def _stream_pieces(text: str) -> Iterator[str]:
    """A finished reply, as the pieces a client appends as they arrive.

    The same shape as a streamed answer — `done` carries the whole reply whatever
    the deltas were — so a reader watching one sees the message arrive the way
    every other reply does. Split on sentence ends, which is as fine-grained as it
    is worth being without a second call per sentence.
    """
    parts = re.split(r"(?<=[.!?])\s+", text.strip()) if text.strip() else []

    if not parts:
        return

    yield " ".join(parts[:-1]) + " " if len(parts) > 1 else parts[0]
    yield parts[-1]


def _has_previous_answer(previous: PreviousAnswer | None) -> bool:
    """Whether there is a previous answer this message can continue.

    Only a grounded answer counts. A refusal, a small talk reply and an
    out-of-scope reply have no passages behind them, so there is nothing an
    expansion could continue from, and a reader asking "anything else?" after one
    is better served by the ordinary path than by being told a topic is exhausted.
    """
    return previous is not None and bool(previous.sources)


def _topic_is_exhausted(previous: PreviousAnswer | None) -> bool:
    """Whether the last turn already said this topic has nothing left in it.

    Which it may have: the corpus is chunked by section, so an answer that cited
    three sections can have read all of them. Asking "anything else?" again then
    would search the same documents for the same passages, and either restate the
    previous answer or come back as a false gap in the corpus — the two things this
    path exists to avoid. So the same answer is given again, which is the truth.
    """
    return previous is not None and previous.kind == ResponseKind.NO_MORE_INFO.value


def _result(
    answer: str,
    kind: ResponseKind,
    sources: Sequence[dict] | None = None,
    confidence: int | None = None,
) -> dict:
    """One reply, as the API reports it.

    `kind` is what the response is; `answered` and `status` are what it used to be
    reported as, kept so a client that predates `kind` still draws something
    recognisable. `answered` is now exactly "a grounded answer", which is the
    narrower and truer meaning of the word: an out-of-scope reply, a refusal and a
    gap in the corpus all cite nothing, and only the first of them ever was an
    answer.

    Sources and a confidence figure ride only on an answer. They are evidence, and
    there is no evidence behind any of the other kinds — reporting a figure on a
    refusal would imply the refusal was measured against something.
    """
    return {
        "answer": answer,
        "kind": kind.value,
        "answered": kind is ResponseKind.ANSWER,
        "status": LEGACY_STATUS[kind],
        "sources": list(sources) if sources else [],
        "confidence": confidence if kind is ResponseKind.ANSWER else None,
    }


def _finish_conversational(pieces: Sequence[str]) -> str:
    """The reply a conversational stream settles on.

    A stream that broke part way through leaves a fragment, and a fragment that
    stops mid-sentence is worse than a whole shorter sentence: the reader is left
    with a truncated thought that looks like the assistant trailing off. So the
    fragment is cut back to its last complete sentence, and when there is not one —
    an outage before the first full stop, most often — the static reply stands in.

    The client's `done` event carries this, and `done` replaces whatever the
    deltas wrote, so trimming here is what the reader ends up with.
    """
    text = " ".join("".join(pieces).split())

    if text and text[-1] in ".!?…":
        return text

    cut = max(text.rfind(mark) for mark in ".!?…") if text else -1

    return text[: cut + 1] if cut > 0 else CONVERSATIONAL_FALLBACK


def _conversation(history: Sequence[tuple[str, str]], per_turn_chars: int) -> str:
    """The recent turns as a conversation, oldest first, each one bounded."""
    return "\n".join(
        f"{'Employee' if role == 'user' else 'Assistant'}: {' '.join(text.split())[:per_turn_chars]}"
        for role, text in history
    )


def _conversational_prompt(message: str, history: Sequence[tuple[str, str]]) -> str:
    """What the responder is given: the exchange so far, and the message itself.

    The exchange is the whole point of this path. A reply to "there is no question"
    is only right if the model can see that it is the second turn and that the first
    was a greeting, and a reply to "that's not what I asked" is only right if it can
    see the question that was ignored.
    """
    turns = _conversation(history, 600) or "(this is the first message)"

    return CONVERSATIONAL_USER_PROMPT.format(conversation=turns, message=message)


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
    context = _context(candidates)

    if classification.category is not Category.FOLLOW_UP:
        return USER_PROMPT.format(context=context, question=classification.query), SYSTEM_PROMPT

    return (
        FOLLOW_UP_USER_PROMPT.format(
            conversation=_conversation(history, 600),
            context=context,
            question=classification.query,
        ),
        FOLLOW_UP_SYSTEM_PROMPT,
    )