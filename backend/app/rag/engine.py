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
    ASSISTANT_FAQ,
    CAPABILITIES_BRIEF,
    CONVERSATIONAL_FALLBACK,
    FAQ_IDS,
    LANGUAGES,
    NOT_SURE_REPLY,
    FaqEntry,
    faq_catalogue,
    faq_entry,
    pleasantry_reply,
    script_correction,
    unreadable_reply,
)
from app.rag.guard import (
    CLASSIFIER_SYSTEM_PROMPT,
    Category,
    Classification,
    build_classifier_prompt,
    classify_by_rules,
    claimed_language,
    dominant_script,
    is_elaboration,
    is_greeting,
    is_latin_script,
    is_meta_question,
    is_obvious_conversational,
    is_restricted_request,
    is_unintelligible,
    needs_earlier_context,
    normalise,
    parse_classification,
)
from app.rag.retrieval import (
    Candidate,
    HybridRetriever,
    IndexedDocuments,
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
    # Every chunk id this conversation has shown, in any answer. The whole thread
    # and not the last turn: a passage quoted four turns ago has been read, and
    # quoting it again is not "more".
    cited: frozenset[str] = frozenset()
    # Every document this conversation has cited, for the same reason.
    documents: frozenset[str] = frozenset()
    # Whether the conversation holds anything to continue at all: an earlier
    # assistant turn that answered, or searched for, an in-scope question. Greetings,
    # small talk, out-of-scope replies and refusals do not count, so a thread that
    # has only those has no topic and "anything else?" is not a question about it.
    has_topic: bool = False
    # How many replies this conversation has had, and whether one of them has
    # already said what the assistant is for. What a greeting is answered with
    # depends on both: the invitation is offered once, and the rest rotate.
    #
    # Counted from this conversation's own messages rather than kept in memory,
    # because a conversation is the only thing that should be able to know how far
    # along it is, and a reload must not restart the count.
    assistant_replies: int = 0
    invitation_given: bool = False
    # How many unreadable replies are at the end of the thread, and how many there
    # have ever been in it. The first chooses how much help to offer, the second
    # rotates it. Both are read out of the messages, so a refresh changes neither.
    unreadable_streak: int = 0
    unreadable_seen: int = 0
    # What this reader last typed, in their own words. Carried only so the script
    # correction can check the claim being made about it: "that is chinese" is only
    # a correction if what arrived really was Latin letters. Read from this
    # conversation's own messages like everything else here.
    previous_user: str = ""


# The vocabulary the wire used before `kind` existed, kept so a client that has
# not been redeployed still draws these replies recognisably. `kind` is what
# everything current reads.
# In scope, and the documents genuinely do not cover it. Named HR because a
# missing policy is a gap in what the corpus holds, and HR owns the corpus.
FALLBACK_MSG = (
    "I couldn't find that in the company documents. "
    f"Please contact HR at {settings.hr_contact}."
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
# A message that needs an earlier turn, in a conversation that has none. Said
# plainly, because the alternative is answering it: retrieving "anything else?"
# finds nothing, and a reader is told the documents do not cover it, which is a
# claim about the corpus made by a message that never asked the corpus anything.
#
# Static, and about the conversation rather than about any policy, so it is
# correct whatever the assistant covers.
NO_PRIOR_TOPIC_MSG = (
    "There's no earlier chat in this conversation to build on yet. Ask me a "
    "question about company policies, onboarding, leave or IT setup and I'll "
    "help from there."
)

# The documents behind the topic being continued are used up. Not a gap in the
# corpus and not a failure: the reader has been given everything those sections
# say, and the useful thing to do now is offer a different policy rather than a
# dead end or a false claim that something is missing.
EXHAUSTED_MSG = (
    "That covers everything the documents say on this topic. "
    "Is there another policy I can look up?"
)

# "Anything else?" after a turn that found nothing.
#
# The defect this replaces is one of kind, not of wording. The previous turn
# reported a gap in the corpus, and "anything else?" then reported that the *topic*
# was exhausted — a claim about documents that were never found and never read. It
# also ran a fresh search to support it, so a reader who had been told nothing
# existed was then billed for another look and told nothing more existed.
#
# So there is nothing to add, and saying that is the whole of the answer. No search
# runs: there is no document to continue from, which is exactly why the last turn
# found nothing. HR is named because a gap in what the corpus holds is HR's to
# close, which is the one thing a rephrase would not fix.
NOTHING_TO_ADD_MSG = (
    "I didn't find anything on that, so I have nothing to add. You could rephrase "
    f"it, or contact HR at {settings.hr_contact}."
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
- If a passage lists a set of things and the question is about that set, cover all
  of them. Answering two of ten listed items is not an answer to a question about
  ten, and the reader cannot tell which were left out.
- Never use outside knowledge.

After your answer, on a line of its own, write:
USED: <the key of every passage you actually used>
listing only keys that appear in the context, separated by commas. This names what
your answer rests on and decides which sources the reader is shown."""

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
- If a passage lists a set of things and the question is about that set, cover all
  of them, briefly.
- Never use outside knowledge.

After your answer, on a line of its own, write:
USED: <the key of every passage you actually used>
listing only keys that appear in the context, separated by commas."""

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
- If a passage lists a set of things, cover all of them, briefly.
- If the context adds nothing beyond what was already covered, reply with exactly: \
NOT_FOUND. It will be turned into a statement that those documents are exhausted, \
which is the truth.
- Never use outside knowledge, and never state a company fact that is not in the \
context.

After your answer, on a line of its own, write:
USED: <the key of every passage you actually used>
listing only keys that appear in the context, separated by commas."""

# An elaboration is told apart from an expansion by what it wants rather than by the
# conversation it follows: the subject is the previous answer's subject, so the
# passages that answer already quoted are in the pool instead of being held back from
# it. That is the whole difference, and it is why this is a separate prompt rather
# than a flag: the model has to be told that the passages in front of it overlap with
# what the reader has read, and that repeating them is the point rather than the
# mistake it is for an expansion.
ELABORATION_USER_PROMPT = """Conversation so far:
{conversation}

The reader is asking for more about the same subject: "{subject}". Some of the
passages below may be ones the last answer already used. That is expected — go into
the ones that carry the detail the last answer left out.

Context:
{context}

Question: {question}
Answer:"""

ELABORATION_SYSTEM_PROMPT = """You are the Internal Knowledge Assistant for Acme \
Technologies. Answer the question using ONLY the context given in the user message.
Be concise, and use numbered steps when the source describes a process.

The reader is asking for more detail about a subject they have already been given \
an answer on. Go further than that answer: give the specifics, the roles, the \
numbers, the exceptions. The context may repeat what they have already read, and \
where it does, prefer what they have not yet seen.

Rules:
- If the context does not contain the answer, reply with exactly: NOT_FOUND
- If the question asks about the asker's own personal records (their own leave
  balance, salary, payslip, appraisal), reply with exactly: PERSONAL
- If a passage lists a set of things and the question is about that set, cover all
  of them, briefly. Naming two of ten is not an answer to a question about ten.
- Never use outside knowledge.

After your answer, on a line of its own, write:
USED: <the key of every passage you actually used>
listing only keys that appear in the context, separated by commas."""

# The generator signals "nothing here" by replying with a sentinel rather than an
# answer, and the sentinel is compared as text. That is fragile in one direction
# worth closing: the model sometimes writes the same words as a sentence — "Not
# found." — and a comparison for the exact token lets that through as an answer
# whose whole content is that it found nothing. These are the spellings of the
# sentinel that mean the same thing; anything longer than this is a real answer
# that happens to use the words.
NOT_FOUND_REPLY = re.compile(r"^(?:not[ _-]?found|nothing found|no information found)\.?$", re.I)

PERSONAL_REPLY = re.compile(r"^personal\.?$", re.I)

# The generator's own report of which passages its answer rests on, as a line it
# writes after the answer.
#
# Structured output in the sense that matters here — a machine-readable line whose
# grammar this code owns, on a channel the reader never sees, because `done`
# replaces the answer with the text above it. It travels as text rather than as a
# tool call or a JSON mode because the configured client is an OpenAI-compatible
# endpoint with neither, and because a line that can be parsed is easier to keep
# working than a stream that has to be reconstructed from fragments.
_USAGE_LINE = re.compile(r"^[ \t]*USED[ \t]*:[ \t]*(?P<keys>.*)$", re.I | re.M)

# Keys are written by a model copying them out of the context, so they arrive with
# the punctuation of the sentence around them. Stripped rather than rejected, since
# "abcd1234." is plainly that key and refusing it would throw away a real answer's
# citations over a full stop. Commas and semicolons are separators, not part of a key.
_KEY_NOISE = re.compile(r"[\s,;\[\]()<>.•*_'\"]+")

# How many passages are shown when the generator named none that validate.
#
# Two, and no more: the fallback exists so that an answer is never drawn without the
# evidence behind it, not so it can be drawn with an arbitrary number of passages the
# reader did not ask for. The best two by score is what the rest of the system would
# have shown in a well-behaved answer anyway.
FALLBACK_SOURCE_COUNT = 2


def _split_used_keys(text: str, sources: Sequence[Mapping[str, object]]) -> tuple[str, frozenset[str]]:
    """The answer without the generator's usage line, and the keys it relied on.

    Validated against the passages this answer was actually given, because the report
    comes from a model and an unvalidated one is worse than none: a key that was
    never offered would be persisted as a citation naming a passage the reader cannot
    be shown, and would then be excluded from "anything else?" on the strength of a
    passage that does not exist.

    A bare number is accepted as well as a key, resolved against the same numbering
    the context uses. That is a convenience, not a second source of truth: it is
    resolved to the key of the passage it names, so an unrecognised number is
    discarded exactly as an unrecognised key is.

    Everything after the first usage line is dropped from the answer. A model that
    writes the line and then carries on talking has stopped answering, and the tail
    would be shown as though it were part of the reply.
    """
    matches = list(_USAGE_LINE.finditer(text or ""))

    if not matches:
        return (text or "").strip(), frozenset()

    match = matches[0]
    answer = (text[: match.start()] + text[match.end() :]).strip()

    valid = {str(source.get("chunk_id")) for source in sources if source.get("chunk_id")}
    # The context numbers its passages from one in the order it lists them, which is
    # the order `sources` is in.
    by_position = {
        str(position): str(source.get("chunk_id"))
        for position, source in enumerate(sources, start=1)
        if source.get("chunk_id")
    }

    used: set[str] = set()

    for token in _KEY_NOISE.split(match.group("keys")):
        if not token:
            continue

        resolved = by_position.get(token) if token.isdigit() else token

        if resolved in valid:
            used.add(str(resolved))

    return answer, frozenset(used)


def _display_order(sources: Sequence[Mapping[str, object]]) -> list[dict]:
    """The passages in the order they should be numbered in.

    Passages from the same document are put next to each other, in the order that
    document first appeared. Grouping is what the reader sees — a card shows each
    document's citations under its own heading — so an answer whose passages
    alternate between two documents is displayed 1, 3, 2: the third passage belongs
    to the document under the first heading, and the numbers underneath it skip. This
    removes the interleaving at the source, so the numbering a client derives from
    array position is also the numbering on screen.
    """
    grouped: dict[str, list[dict]] = {}
    order: list[str] = []

    for source in sources:
        document = str(source.get("document", ""))

        if document not in grouped:
            grouped[document] = []
            order.append(document)

        grouped[document].append(dict(source))

    return [source for document in order for source in grouped[document]]


def _displayed_sources(
    sources: Sequence[Mapping[str, object]], used: frozenset[str]
) -> list[dict]:
    """Only the passages the answer used, in display order.

    A citation is a claim that the passage supports the answer. Retrieval returns the
    best few passages regardless — it cannot know which the model will reach for —
    so displaying all of them asserts support for parts of the answer nothing behind
    them exists. "How many departments do we have?" retrieved four passages and cited
    four; the number came from one of them, and the other three were decoration.

    Each one persisted carries `"used": true`. That is the whole of the schema for
    this: the passage is in the list because it was used, the flag says so explicitly
    rather than leaving it to be inferred, and a row stored before the flag existed
    still reads as used — which is what it was.
    """
    if used:
        selected = [source for source in sources if str(source.get("chunk_id")) in used]
    else:
        # No key validated. Showing the best few beats showing nothing at all: an
        # answer with no evidence behind it is the one thing this must not produce.
        selected = sorted(
            sources, key=lambda source: float(source.get("score") or 0.0), reverse=True
        )[:FALLBACK_SOURCE_COUNT]

    displayed = _display_order(selected)

    for source in displayed:
        source["used"] = True

    return displayed

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
    "You name conversation threads. From the first user message in a conversation, "
    "give it a title of at most six words and at least three, in sentence case, "
    "that a person would recognise later in a list of conversations. Reply with "
    "only the title: no quotes, no surrounding text, no trailing period and no "
    "full stop."
)

# What a conversation is called when the model cannot be asked, and when the first
# message did not say anything to name it by.
#
# Fixed words rather than the message itself, because each of these says what the
# conversation turned out to be, and a sidebar row is the only place anybody ever
# reads it again.
GREETING_TITLE = "Greeting"
QUICK_CHAT_TITLE = "Quick chat"
UNCLEAR_TITLE = "Unclear message"

# A conversation that began with a request the assistant will not answer is named
# for the request and not for what was asked. A title is the one piece of the
# conversation that outlives it in a list somebody else can see through a shared
# screen, and "What is Kwame's salary?" is not something to write where it stays.
RESTRICTED_TITLE = "Restricted request"

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

# =============================================================================
# Choosing which FAQ entry answers a question about the assistant
# =============================================================================
# The rule layer catches the questions it was written for. This is what happens to
# the rest, and the shape of it is the point: the model is asked to name an entry, not
# to write an answer. It never sees an answer and could not produce one if it tried,
# because the reply that follows is read out of a table by id.

META_MAX_TOKENS = 64

META_PICKER_SYSTEM_PROMPT = """You match a reader's question about an AI \
assistant to the entry that answers it.

You are given a numbered list of entries. Reply with one line and nothing else:

ENTRY: <the id of the one entry that answers the question>

Rules:
- Reply with the id exactly as written in the list, and nothing else on the line.
- Choose the single best entry. If the list contains nothing that answers the
  question, reply with the line: ENTRY: none
- Never write the answer itself, never explain your choice, and never invent an id."""

META_PICKER_USER_PROMPT = """Entries:
{catalogue}

Conversation so far:
{conversation}

Question about the assistant: {message}"""

# The reasoning model wraps whatever it thinks onto lines of its own before the
# answer, so the first line carrying the marker is the answer and everything before
# it is discarded. Same reading as the classifier's, for the same reason.
_ENTRY_LINE = re.compile(r"entry\s*:\s*([a-z_]+)", re.I)


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


def title_for_first_message(
    question: str, classification: Classification, vocabulary: frozenset[str] = frozenset()
) -> str | None:
    """The name this conversation gets from its first message, or None to ask.

    A conversation is named once, by its first message, and never renamed: a name
    that changed with the topic would make a sidebar unreadable, because the only
    way to find a conversation again is to recognise its name.

    Only a message with something to name is sent to the model. The rest are named
    by rule — and named by what the conversation turned out to be rather than by
    what was typed, which matters most for the two that must not repeat the message:
    an unreadable one keeps no keyboard accident in the list forever, and a refused
    one keeps neither a name nor a detail of somebody's private business.
    """
    if classification.category is Category.RESTRICTED:
        return RESTRICTED_TITLE

    if classification.category is not Category.CONVERSATIONAL:
        return None

    if is_unintelligible(question, vocabulary):
        return UNCLEAR_TITLE

    if is_greeting(question):
        return GREETING_TITLE

    return QUICK_CHAT_TITLE


class LlmUnavailable(Exception):
    """No answer could be produced from the configured NVIDIA model.

    Carries the upstream reason so the route can log it and tell an operator what
    actually went wrong, rather than the caller seeing an opaque 500.
    """

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


class Assistant:
    # The indexed documents' own vocabulary, for deciding that a message is readable.
    # A class-level default rather than an attribute of `__init__` alone, so an
    # assistant built without an index — the shape the tests use, and the shape a
    # deployment without documents would have — still has the built-in word list to
    # fall back on instead of an `AttributeError` on the first "hey".
    _vocabulary: frozenset[str] = frozenset()

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
        self._keywords = KeywordIndex(index.docstore.docs.values())
        # `documents` is the same corpus read the other way round, for the
        # expansion path: whole documents by title, out of the store, rather than
        # a ranked window out of a search.
        self.retrieval = HybridRetriever(
            self.retriever,
            self._keywords,
            documents=IndexedDocuments(index),
            top_k=settings.top_k,
            vector_candidates=settings.vector_candidates,
            keyword_candidates=settings.keyword_candidates,
            min_score=settings.min_score,
            keyword_min_score=settings.keyword_min_score,
            recall_floor=settings.recall_floor,
            recall_candidates=settings.recall_candidates,
        )
        # The corpus's own vocabulary, for deciding that a message is not a
        # keyboard accident: a word these documents use is a real word, whether or
        # not a dictionary of English carries it.
        self._vocabulary = self._keywords.vocabulary
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

    def title_for(
        self, question: str, classification: Classification
    ) -> str | None:
        """`title_for_first_message`, with this deployment's own vocabulary.

        The words the indexed documents use are part of what makes a message
        readable, and they are only known here.
        """
        return title_for_first_message(question, classification, self._vocabulary)

    def generate_title(self, first_question: str) -> str:
        """A short label for a conversation, from the message that started it.

        The model names the thread once, right after that first exchange, so a
        conversation appears in the sidebar as something to read rather than as
        "New conversation". Which message gets the model's attention is
        `title_for_first_message`'s decision, not this one's: a greeting, a laugh
        and a refused request are named by rule, and only a message that actually
        says what the conversation is about is worth a model call.

        The reply is a title but can still carry quotes or run long, so it is
        always cleaned and bounded; if the model is unavailable, the question
        itself is truncated to the same length — which is the fallback the answer
        does not notice, because it happens on its own thread and long after the
        answer has been delivered.
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

            # The replies that are chosen rather than written. A greeting, a
            # thank-you, a laugh, a keyboard accident and a message that needed an
            # earlier turn all have exactly one right answer, and a model asked to
            # improvise one produces a different sentence each time — including,
            # eventually, a sign-off on a conversation that has not started.
            fixed = self.fixed_conversational_reply(question, previous, history)

            if fixed is not None:
                for piece in _stream_pieces(fixed):
                    yield {"type": "delta", "text": piece}
                yield {
                    "type": "done",
                    **_result(fixed, ResponseKind.CONVERSATIONAL),
                }
                return

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
            yield from self._expansion_events(
                question, history, previous, classification.elaboration
            )
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
            fixed = self.fixed_conversational_reply(question, previous, history)

            if fixed is not None:
                return _result(fixed, ResponseKind.CONVERSATIONAL)

            return _result(
                self.conversational_reply(question, history), ResponseKind.CONVERSATIONAL
            )

        if classification.category is Category.OUT_OF_SCOPE:
            return _result(OUT_OF_SCOPE_MSG, ResponseKind.OUT_OF_SCOPE)

        if classification.category is Category.RESTRICTED:
            return _result(PERSONAL_MSG, ResponseKind.RESTRICTED)

        if classification.category is Category.EXPANSION:
            return self._expansion(question, history, previous, classification.elaboration)

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

        # The guard first, and unconditionally: it is a refusal on grounds of what
        # the data is, and a message that is both "what about" and about a person's
        # salary is a refusal rather than a question about the conversation.
        if by_rule is Category.RESTRICTED:
            return Classification(by_rule, question)

        # An acknowledgement is not a request for more of anything. "ok" in an empty
        # conversation is "ok", and answering it with "there is no earlier chat to
        # build on" would be answering a question nobody asked.
        if by_rule is Category.CONVERSATIONAL:
            return Classification(by_rule, question)

        # A message that could not be read, and before anything else that could
        # mistake it for one: before the context-dependent check below, so "and then"
        # typed at the keyboard is not read as a follow-up with nothing to follow,
        # and before the model, so it is never rewritten into a question nobody
        # asked.
        #
        # Laughter has already been answered above — a laugh is a run of letters
        # too, and this is the check that would otherwise take it.
        if is_unintelligible(question, self._vocabulary):
            logger.info("could not read %r; answering as unreadable", question)

            return Classification(Category.CONVERSATIONAL, question)

        # A message that only means something against earlier turns, in a
        # conversation with none. Decided before the classifier, before the
        # rewrite and before retrieval, because the answer does not depend on what
        # any of them would say: there is nothing to continue from, and the reader
        # is told that instead of being given a search for a phrase that names no
        # document.
        #
        # Nothing outside this conversation is consulted, and nothing outside it is
        # remembered: `previous` is read from the messages stored under this
        # conversation's id, or is None.
        if orphaned_context_question(question, previous):
            logger.info("no earlier turn to continue from; answering %r as chat", question)
            return Classification(Category.CONVERSATIONAL, question)

        # An elaboration, whatever else it may also look like. Before everything
        # below it, and before the classifier, because it is a shape of wording the
        # rules recognise outright: "anything about these departments?" names no
        # document, so an expansion rule misses it and the classifier — which sees
        # the conversation rather than the words — reads it as an ordinary topic
        # shift and retrieves "these departments" against the corpus.
        #
        # Guarded on there being documents to elaborate from. With none, "explain
        # that" has nothing to explain and is a fresh question like any other.
        if is_elaboration(question) and _can_continue(previous):
            logger.info("continuation reads as an elaboration: %r", question)
            return Classification(Category.EXPANSION, question, elaboration=True)

        if by_rule is not None:
            if by_rule is Category.EXPANSION:
                # A refusal has no passages behind it, so there is nothing an
                # expansion could continue from, and "anything else?" after being
                # told what is not shared is not a request for more of it. It stays
                # a refusal rather than being told a topic is exhausted.
                if previous is not None and previous.kind == ResponseKind.RESTRICTED.value:
                    return Classification(Category.RESTRICTED, question)

                # The last turn found nothing, so there is nothing to continue and
                # nothing to add. Said as conversational rather than searched: the
                # search would return the same nothing, and reporting it a second
                # time as "those documents are exhausted" claims the reader was given
                # a passage that was never found.
                if _after_a_gap(previous, question):
                    logger.info("expansion after a gap; nothing to add")
                    return Classification(Category.CONVERSATIONAL, question)

                # Already exhausted, so still an expansion: same passages, same
                # answer, rather than a fresh search of documents already read.
                if _topic_is_exhausted(previous):
                    return Classification(Category.EXPANSION, question)

                if not _can_continue(previous):
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

        # An expansion the model found rather than the rules: the same question as
        # above, and the same requirement of something to continue from.
        if classification.category is Category.EXPANSION:
            if _after_a_gap(previous, question):
                return Classification(Category.CONVERSATIONAL, question)

            if not _can_continue(previous):
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
        elaboration: bool = False,
    ) -> Iterator[dict]:
        """"Anything else?", answered from what those documents had left.

        Never a `not_found`: the documents the reader is on have not run out of
        *topics*, and telling somebody the indexed documents do not cover "anything
        else" is a claim about the corpus that says nothing true about it.
        """
        yield {"type": "status", "stage": "writing"}

        answer, kind, sources, confidence = self._expansion(
            question, history, previous, elaboration
        )

        for piece in _stream_pieces(answer):
            yield {"type": "delta", "text": piece}

        yield {"type": "done", **_result(answer, kind, sources, confidence)}

    def _expansion(
        self,
        question: str,
        history: Sequence[tuple[str, str]],
        previous: PreviousAnswer | None,
        elaboration: bool = False,
    ) -> tuple[str, ResponseKind, list[dict], int | None]:
        """The continuation, as text, kind, citations and confidence.

        Retrieval is anchored to the documents this conversation's answers cited,
        read whole out of the store rather than out of a ranked window, with every
        chunk the thread has shown held back. So "anything else?" after a thorough
        first answer is answered from the sections of that document nobody quoted,
        and only says the topic is exhausted once the whole of it has been read.

        When there is nothing left, that is said plainly rather than reported as a
        gap in the corpus.

        An elaboration runs the same reader with the exclusion switched off. The two
        want opposite things from the same passages — "anything else?" wants what the
        last answer did *not* say, "tell me about those" wants *more about the same
        subject* — and holding back the passages that hold the answer is what made
        "anything about these departments?" return two of ten departments from a
        document that lists all ten. The subject is carried into the prompt rather
        than retrieved, because the follow-up names no document either.
        """
        if elaboration:
            return self._elaborate(question, history, previous)

        exhausted = (EXHAUSTED_MSG, ResponseKind.NO_MORE_INFO, [], None)

        if previous is None or not previous.documents or _topic_is_exhausted(previous):
            return exhausted

        candidates = self.retrieval.retrieve_continuation(
            previous.question or previous.answer, previous.documents, previous.cited
        )

        if not candidates:
            # Those documents are read out. The counts behind that are logged by
            # the retrieval, which is where "there was nothing left" can be told
            # apart from "nothing matched".
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
        answer, used = _split_used_keys(
            text, [_source(candidate) for candidate in candidates]
        )

        if _declined(answer) == "not_found" or not answer:
            return exhausted

        sources = [_source(candidate) for candidate in candidates]

        return (
            answer,
            ResponseKind.ANSWER,
            _displayed_sources(sources, used),
            retrieval_confidence(candidates),
        )

    def _elaborate(
        self,
        question: str,
        history: Sequence[tuple[str, str]],
        previous: PreviousAnswer | None,
    ) -> tuple[str, ResponseKind, list[dict], int | None]:
        """More about the subject the last answer was about, from the same documents.

        Retrieval is the continuation reader's, because the document is the same one —
        "anything about these departments?" names no document either, and the
        documents the last answer cited are the only place the answer can be. What
        differs is that nothing is held back: the passages the last answer used are
        exactly the ones holding the detail being asked for.

        Anchored on the question that started the thread *plus* the follow-up, because
        the follow-up alone ranks on a demonstrative and a noun ("these departments")
        and the question carries the terms that reach the right passage.
        """
        if previous is None or not previous.documents:
            # Nothing was cited, so there is no subject to elaborate on. Said as
            # nothing-to-add rather than searched for: the follow-up names no
            # document, and a search for a demonstrative finds nothing in any of
            # them.
            return NOTHING_TO_ADD_MSG, ResponseKind.CONVERSATIONAL, [], None

        anchor = f"{previous.question} {question}".strip()
        candidates = self.retrieval.retrieve_continuation(
            anchor, previous.documents, frozenset()
        )

        if not candidates:
            return NOTHING_TO_ADD_MSG, ResponseKind.CONVERSATIONAL, [], None

        user_prompt = ELABORATION_USER_PROMPT.format(
            conversation=_conversation(history, 600),
            subject=previous.question or previous.answer,
            context=_context(candidates),
            question=question,
        )

        try:
            parts: list[str] = []
            for delta in self._stream(
                user_prompt, system_prompt=ELABORATION_SYSTEM_PROMPT
            ):
                parts.append(delta)

            text = "".join(parts).strip()
        except LlmUnavailable as exc:
            logger.warning("elaboration unavailable: %s", exc.reason)
            return NOTHING_TO_ADD_MSG, ResponseKind.CONVERSATIONAL, [], None

        sources = [_source(candidate) for candidate in candidates]
        answer, used = _split_used_keys(text, sources)
        declined = _declined(answer)

        # A follow-up to a refusal is a refusal here as everywhere else, and the
        # confidentiality guard is re-applied to it by the classifier before this
        # point; this is the last thing standing between a rewritten message and the
        # page.
        if declined == "personal":
            return PERSONAL_MSG, ResponseKind.RESTRICTED, [], None

        if not answer or declined == "not_found":
            return NOTHING_TO_ADD_MSG, ResponseKind.CONVERSATIONAL, [], None

        logger.info("elaborated %r via %s", question, settings.llm_model)

        return (
            answer,
            ResponseKind.ANSWER,
            _displayed_sources(sources, used),
            retrieval_confidence(candidates),
        )

    def fixed_conversational_reply(
        self,
        message: str,
        previous: PreviousAnswer | None,
        history: Sequence[tuple[str, str]] = (),
    ) -> str | None:
        """The reply to this message, when there is only one right reply.

        Five kinds of message, all of which ask nothing of the documents and all of
        which are better served by words chosen once than by words invented:

        - a question about what this assistant is, answered from the FAQ rather than
          generated, because an improvised answer to "what can you do?" is a promise
          nobody checked, and because the description it used to be checked against
          said nothing about languages, so "do you understand Chinese?" matched
          nothing and was answered with an invitation to ask a question;
        - a message whose script did not survive transmission, corrected and then
          answered from the same table;
        - a message that needed an earlier turn this conversation does not have,
          which is said plainly rather than searched for;
        - a message that could not be read, which gets a warmer reply the more of
          them there have been;
        - a greeting, a thank-you, an acknowledgement or a laugh, which gets one of
          a small pool and says what this assistant is for exactly once.

        None means the message is a remark about the exchange itself — "there is no
        question", "that's not what I asked" — which is the one conversational
        message that is genuinely a reply to something, and the one worth writing.
        """
        meta = self.meta_reply(message, history, previous)

        if meta is not None:
            return meta

        # Before the gibberish check: "anything else?" with no earlier turn has a
        # true answer whatever it is made of, and the answer is that there is
        # nothing to continue.
        if orphaned_context_question(message, previous):
            return NO_PRIOR_TOPIC_MSG

        # "Anything else?" after a turn that found nothing. Ahead of the pleasantry
        # pool because it is a question and deserves an answer to it, and ahead of
        # the unreadable check because a reader who has been told the documents do
        # not cover something is not confused.
        if _after_a_gap(previous, message):
            return NOTHING_TO_ADD_MSG

        streak = previous.unreadable_streak if previous else 0
        seen = previous.unreadable_seen if previous else 0

        # A greeting, a thank-you, an acknowledgement or a laugh is answered as one,
        # and this is checked before the gibberish check below because a laugh is
        # also a run of letters: "hhhhh" is in no word list, and reading it as a
        # keyboard accident would answer somebody's laugh with "did your keyboard
        # slip?".
        #
        # The narrow reading rather than `classify_by_rules`, which now also returns
        # CONVERSATIONAL for a question about the assistant and for a message in
        # another script. Answering "that is chinese" — where `meta_reply` has
        # already decided there is nothing to correct — with "Hello, ask me anything"
        # would be treating a reader's observation as a greeting.
        if is_obvious_conversational(message):
            replies = previous.assistant_replies if previous else 0
            invited = previous.invitation_given if previous else False

            return pleasantry_reply(replies, invited)

        if is_unintelligible(message, self._vocabulary):
            return unreadable_reply(streak + 1, seen)

        return None

    def meta_reply(
        self,
        message: str,
        history: Sequence[tuple[str, str]] = (),
        previous: PreviousAnswer | None = None,
    ) -> str | None:
        """The approved answer to a question about this assistant, or None.

        Rules first, then the model, then the table — and the model never gets past
        the third step. A question the rules recognise is answered from its entry
        directly. A question they do not is offered to the model as a choice between
        the entry ids, and whichever id it names is read back from the same table. An
        id that is not in the table, a reply that names none, and a model that cannot
        be reached all produce the same reply: the honest one that says it does not
        know and then says what it can do.

        That ordering is the whole fix. The previous behaviour let the model write
        this reply, and the model's instructions for this path were explicit that it
        must not state facts about the assistant — so the only thing it could do with
        "do you understand Chinese?" was to improvise, and what it improvised was
        "I'm happy to help with any questions you have. Just let me know what you
        need".

        The two script cases come before the question test because they are not
        questions at all — a Chinese sentence and a complaint about a Chinese sentence
        both have to be answered, and neither would be recognised as a question about
        the assistant.
        """
        written_in = dominant_script(message)

        if written_in is not None:
            return self._script_reply(message, written_in)

        language = claimed_language(message)

        if (
            language
            and previous is not None
            and previous.previous_user
            and is_latin_script(previous.previous_user)
        ):
            # Only believed because what arrived really was Latin letters. A reader
            # saying "that was Chinese" about a message that arrived as Chinese
            # characters has not been let down by anything, and telling them it came
            # through as random letters would be inventing a fault that is not there.
            logger.info(
                "correcting a transmission the reader reports as %s", language.lower()
            )

            return f"{script_correction(language)} {LANGUAGES.answer}"

        if not is_meta_question(message):
            return None

        entry = match_faq_entry(message)

        if entry is not None:
            logger.info("answered a question about the assistant from the %r entry", entry.id)

            return entry.answer

        entry_id = self._choose_faq_entry(message, history)

        if entry_id is None:
            return NOT_SURE_REPLY

        chosen = faq_entry(entry_id)

        return chosen.answer if chosen else NOT_SURE_REPLY

    def _script_reply(self, message: str, script: str) -> str:
        """What to answer a message written in a script a Latin keyboard cannot produce.

        The languages entry, in English, and the script named rather than guessed
        into a language: Cyrillic is not Russian and the observation that a message
        arrived in a script the assistant cannot read is the true part of it.

        Whether the same question in English would retrieve the right document is the
        limitation the entry states, so it is stated here too rather than leaving a
        reader who asked in Chinese to discover it as a "not found".
        """
        logger.info("message arrived in %s script; answering in English", script)

        return (
            f"I can see that arrived as {script} script. {LANGUAGES.answer}"
        )

    def _choose_faq_entry(
        self, message: str, history: Sequence[tuple[str, str]]
    ) -> str | None:
        """Which FAQ entry the model says this question is about, or None.

        A choice between ids, never a draft. The model is shown the ids and what each
        one covers and is asked for one word back; whatever it writes is looked up in
        the table, so an id that does not exist resolves to nothing and the caller
        says it does not know. That is why this can involve a model at all without
        putting invented facts within its reach.
        """
        prompt = META_PICKER_USER_PROMPT.format(
            conversation=_conversation(history, 400) or "(this is the first message)",
            catalogue=faq_catalogue(),
            message=message,
        )

        try:
            reply = self._complete(
                prompt, system_prompt=META_PICKER_SYSTEM_PROMPT, max_tokens=META_MAX_TOKENS
            )
        except LlmUnavailable as exc:
            logger.warning("no FAQ entry chosen, saying so: %s", exc.reason)
            return None

        match = _ENTRY_LINE.search(reply or "")

        if match is None:
            return None

        chosen = match.group(1).strip().strip("\"'").lower()

        if chosen not in FAQ_IDS:
            logger.info("FAQ pick %r is not an entry this deployment has", chosen)
            return None

        logger.info("answered a question about the assistant from the %r entry", chosen)

        return chosen

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

        The messages that have one right reply never reach here: they are answered
        from `fixed_conversational_reply`, which is also why this only has to write
        the reply that is genuinely a response to the exchange.
        """
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

    The generator's usage line is read and removed here rather than shown, and what
    it named decides which passages are displayed. A model that answered and did not
    report — a truncated stream, a reasoning model that spent its budget thinking —
    falls back to the best two, so the answer is never drawn with nothing behind it.
    """
    text, used = _split_used_keys(text, sources)
    declined = _declined(text)

    if declined == "personal":
        return _result(PERSONAL_MSG, ResponseKind.RESTRICTED)

    if declined == "not_found":
        return _result(FALLBACK_MSG, ResponseKind.NOT_FOUND)

    return _result(text, ResponseKind.ANSWER, _displayed_sources(sources, used), confidence)


def _context(candidates: Sequence[Candidate]) -> str:
    """The passages a generator is given, each labelled with where it came from.

    Labelled with its key as well, and numbered, because the generator is asked to
    report which passages it used and cannot name one it was not shown. The number
    is a convenience for copying; the key is what the report is validated against.
    """
    return "\n\n".join(
        f"[{position}] ({candidate.node.metadata['policy_title']} > "
        f"{candidate.node.metadata['section']}) key: {chunk_key(candidate.node)}\n"
        f"{candidate.node.get_content(metadata_mode=MetadataMode.NONE)}"
        for position, candidate in enumerate(candidates, start=1)
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


def orphaned_context_question(
    question: str, previous: PreviousAnswer | None
) -> bool:
    """Whether this message needs an earlier turn that this conversation lacks.

    One condition, read in two places: the classifier uses it to decide that there
    is nothing to classify, and the conversational path uses it to answer
    statically instead of generating a reply about a conversation that does not
    exist yet.

    The scope is the conversation. `previous` is built from the messages stored
    under the conversation id this request is for, and is None when there are none,
    so a question that made sense in another thread is not answered from it.
    """
    return needs_earlier_context(question) and not (previous and previous.has_topic)


def _can_continue(previous: PreviousAnswer | None) -> bool:
    """Whether there is a document this message can be continued from.

    Documents, not citations on the last turn: the topic a conversation is on
    belongs to the thread, so a greeting typed after an answer does not take the
    answer's place. What decides it is whether any of the thread's answers cited
    anything.
    """
    return previous is not None and bool(previous.documents)


def _topic_is_exhausted(previous: PreviousAnswer | None) -> bool:
    """Whether the last turn already said this topic has nothing left in it.

    Which it may have: the corpus is chunked by section, so an answer that cited
    three sections can have read all of them. Asking "anything else?" again then
    would search the same documents for the same passages, and either restate the
    previous answer or come back as a false gap in the corpus — the two things this
    path exists to avoid. So the same answer is given again, which is the truth.

    Only reachable from an answer, and the documents are what say so: a turn that
    cited something read passages, and those passages can be exhausted. A turn that
    found nothing never cited anything, so the thread has no documents, and "nothing
    left" would be a claim about documents that were never opened. That is
    `_after_a_gap`'s case, and it is answered differently on purpose.
    """
    return (
        previous is not None
        and previous.kind == ResponseKind.NO_MORE_INFO.value
        and bool(previous.documents)
    )


def _after_a_gap(previous: PreviousAnswer | None, message: str = "") -> bool:
    """Whether this message is asking for more after a turn that found nothing.

    Two conditions, and both are needed. The last turn must have been a gap in the
    corpus — anything else and the ordinary paths have something true to say. And
    the message must be asking for more of it: "anything else?" after a not-found is
    that, while "ok" or "thanks" after one is not, and answering an acknowledgement
    with "I didn't find anything on that" would be answering something nobody said.
    """
    return (
        previous is not None
        and previous.kind == ResponseKind.NOT_FOUND.value
        and needs_earlier_context(message)
    )


def match_faq_entry(message: str) -> FaqEntry | None:
    """The FAQ entry whose triggers this message matches, or None.

    Longest trigger wins, so a specific phrase beats a general one: "do you remember
    our chats" is more exactly the memory entry than any one-word trigger in it, and
    "are my messages saved" is more exactly the privacy entry than "are my" anything.

    Read on the normalised message, which folds case, trailing punctuation and
    stretched letters — the same reading every other rule in this system uses, so
    "do you remembr our chats" reaches the same entry as the spelling of it.
    """
    cleaned = normalise(message)

    if not cleaned:
        return None

    best: tuple[int, FaqEntry] | None = None

    for entry in ASSISTANT_FAQ:
        for trigger in entry.triggers:
            if trigger in cleaned and (best is None or len(trigger) > best[0]):
                best = (len(trigger), entry)

    return best[1] if best else None


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