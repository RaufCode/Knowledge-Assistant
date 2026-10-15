"""Which of five things a message is, decided before anything is looked up.

Every message reaches retrieval down exactly one of these paths, and the five mean
genuinely different things, which is why they are told apart rather than collapsed
into "a question or not a question":

- CONVERSATIONAL: not a request for information at all. Greetings, thanks,
  goodbyes, acknowledgements, reactions, comments or corrections about the chat
  itself ("there is no question", "that's not what I asked"), and questions about
  the assistant ("who are you?"). Answered from the conversation, with no
  retrieval: there is nothing to look up.
- COMPANY_QUESTION: a self-contained request for company information. The
  ordinary path, and the only one that reads documents.
- FOLLOW_UP: a request that only means something against the turns before it
  ("anything else?", "what about contractors?"). Retrieved as the standalone
  question it resolves to, and generated against the thread.
- OUT_OF_SCOPE: a real request for information or help that has nothing to do
  with the company. Answered with what the assistant is for, because "I could
  not find that in the documents" claims a gap in the corpus that is not there.
- RESTRICTED: a request for information the confidentiality guard withholds,
  whatever else it would otherwise have been.

The categories are decided by *intent*, never by punctuation or by topic alone. A
missing question mark does not mean there is no question, and a question mark does
not mean there is a company question; and a message that asks for nothing can
never be out of scope, because out-of-scope is a kind of request. Two rules that
follow from that are load-bearing rather than cosmetic:

- OUT_OF_SCOPE requires a request. A statement about the conversation, a "thank
  you", a "lol" and a correction all have no category among the document-answering
  ones, and forcing them into out-of-scope is what answered "there is no question"
  with a refusal and a false gap in the corpus.
- Anything that is not *clearly* a request for information is CONVERSATIONAL. A
  message wrongly called conversational costs the reader one more message; a
  message wrongly sent to retrieval, or refused as out of scope, makes the product
  look broken rather than hesitant.

Two of the five are decided by pattern, without a model call: the obvious
conversational openers, and personal-record questions. Both are recognisable from
the message alone, both are exact-match judgements where a model can only add a
way to be wrong, and the first in particular must not depend on the model being
reachable — a greeting has to work during an outage. The rest go to the model with
the recent turns in hand: a follow-up is defined by the conversation it follows,
and an out-of-scope request can be phrased in any of a hundred ways.
"""

import re
from collections.abc import Sequence
from dataclasses import dataclass
from enum import Enum
from typing import Literal

from pydantic import BaseModel, ConfigDict, ValidationError

# The confidentiality guard's own patterns. Unchanged, and deliberately not
# merged into the rules below: this is a refusal on grounds of what the data is,
# not a judgement about what the message is asking for.
PERSONAL_PATTERNS = [
    r"\bmy\b(\s+\w+){0,2}\s+(salary|pay\s?slip|appraisal|balance|tax)\b",
    r"\b(days|leave)\b.*\b(do i have|have i got|i have)\b.*\b(left|remaining)\b",
    r"\bhow (much|many)\b.*\b(do i have|have i got)\b.*\b(left|remaining)\b",
]


class Category(str, Enum):
    """What a message turned out to be. The path it takes from here."""

    CONVERSATIONAL = "conversational"
    COMPANY_QUESTION = "company_question"
    FOLLOW_UP = "follow_up"
    OUT_OF_SCOPE = "out_of_scope"
    RESTRICTED = "restricted"


# The four the model chooses between. RESTRICTED is absent because it is decided
# by the confidentiality guard's own patterns and never by the model: a rule the
# guard already applies must not be something a classifier call can talk it out of.
MODEL_CATEGORIES: tuple[str, ...] = (
    Category.CONVERSATIONAL.value,
    Category.COMPANY_QUESTION.value,
    Category.FOLLOW_UP.value,
    Category.OUT_OF_SCOPE.value,
)


@dataclass(frozen=True)
class Classification:
    """A category, and for a follow-up the standalone question it resolves to.

    `query` is what gets retrieved and generated against. For a question it is the
    message itself; for a follow-up it is the follow-up rewritten so it stands on
    its own — "anything else I should know?" asked after a question about the Code
    of Conduct becomes a question about the Code of Conduct. Retrieval cannot use
    the original wording: "anything else" matches nothing in any document, which is
    exactly how a follow-up used to end as a false "not found".
    """

    category: Category
    query: str


def is_personal_question(question: str) -> bool:
    q = question.lower()
    return any(re.search(p, q) for p in PERSONAL_PATTERNS)


# Openers, acknowledgements and sign-offs that ask for nothing. A fast path, not
# the definition: the set is what is *obviously* conversational, so "ok" costs no
# model call and "there is no question" is left to the classifier rather than
# being guessed at here.
CONVERSATIONAL_WORDS = {
    # greetings
    "hi",
    "hii",
    "hello",
    "helloo",
    "hey",
    "heyy",
    "yo",
    "hiya",
    "howdy",
    "greetings",
    "good morning",
    "good afternoon",
    "good evening",
    "good day",
    "good night",
    "goodnight",
    "morning",
    "afternoon",
    "evening",
    # sign-offs
    "bye",
    "byeee",
    "goodbye",
    "good bye",
    "see you",
    "see you later",
    "see ya",
    "talk to you later",
    "later",
    "night",
    "ciao",
    # thanks
    "thanks",
    "thank you",
    "thankyou",
    "thx",
    "ta",
    "thanks a lot",
    "thank you so much",
    "cheers",
    # acknowledgements
    "ok",
    "okay",
    "k",
    "kk",
    "sure",
    "yep",
    "yup",
    "yeah",
    "yes",
    "no",
    "np",
    "no problem",
    "got it",
    "gotcha",
    "understood",
    "makes sense",
    "sounds good",
    "sure thing",
    "will do",
    "done",
    "cool",
    "nice",
    "great",
    "awesome",
    "perfect",
    "fair",
    "agreed",
    "same",
    "indeed",
    # reactions
    "lol",
    "lmao",
    "haha",
    "hehe",
    "hmm",
    "hm",
    "oh",
    "ah",
    "ahh",
    "wow",
    "ohh",
    # courtesy openers that carry no request on their own
    "how are you",
    "how r u",
    "how are u",
    "how is your day",
    "how was your day",
    "how's it going",
    "hows it going",
    "how is it going",
    "what's up",
    "whats up",
    "what is up",
    "sup",
    "how do you do",
    "how do u do",
    "nice to meet you",
    "hi all",
    "hello all",
    "hey all",
}

# Questions about the assistant itself. Asked by rule for the same reason as
# `CONVERSATIONAL_WORDS` — a model call to learn that somebody asked what this is
# would be a model call that cannot fail usefully — and answered from the static
# capabilities description rather than improvised, so the assistant cannot describe
# abilities it does not have.
CAPABILITY_QUESTIONS = {
    "who are you",
    "who r u",
    "who are u",
    "what are you",
    "what r you",
    "what is this",
    "what's this",
    "what can you do",
    "what can you help with",
    "what do you do",
    "what do you know",
    "what are you for",
    "what are you here for",
    "what can i ask you",
    "what can i ask",
    "how do you work",
    "how does this work",
    "how does that work",
    "how do you do that",
    "help",
    "help me",
    "please help",
    "how can you help",
    "can you help",
    "can you help me",
}

# Words that may follow a greeting without making it a request.
CONVERSATIONAL_ADDRESSEES = {
    "there",
    "assistant",
    "bot",
    "team",
    "everyone",
    "everybody",
    "folks",
    "friend",
    "friends",
    "all",
}

# Upper bound on a normalised message, so a sentence never qualifies on a word
# inside it. "hello, what is the leave policy?" is a question, and answering it
# with a greeting would be refusing to do the actual job.
MAX_CONVERSATIONAL_LENGTH = 32


def normalise(text: str) -> str:
    """The message as these rules read it.

    Case, surrounding whitespace and trailing punctuation are ignored, and
    stretched letters are folded, because none of those change what the message is.
    """
    cleaned = re.sub(r"\s+", " ", text.strip().lower())
    cleaned = re.sub(r"(.)\1{2,}", r"\1\1", cleaned)
    return re.sub(r"[!?.\u2026,;:'\"]+$", "", cleaned).strip()


def is_obvious_conversational(text: str) -> bool:
    """Whether this message is obviously not a request for information.

    Exactly matching: a greeting, a thank you, an acknowledgement, a sign-off, a
    reaction, or a question about the assistant. Deliberately narrow. Everything
    else — including a comment about the conversation, which asks for nothing and
    is the case that used to be refused — is the classifier's to decide, because
    guessing here would put a wrong guess in front of the reader.
    """
    cleaned = normalise(text)

    if not cleaned or len(cleaned) > MAX_CONVERSATIONAL_LENGTH:
        return False

    if cleaned in CONVERSATIONAL_WORDS or cleaned in CAPABILITY_QUESTIONS:
        return True

    head, _, tail = cleaned.rpartition(" ")

    return bool(tail) and head in CONVERSATIONAL_WORDS and tail in CONVERSATIONAL_ADDRESSEES


def asks_about_capabilities(text: str) -> bool:
    """Whether this message is a question about what the assistant is and does.

    These are answered verbatim from the capabilities description rather than
    generated, which is the only way the assistant cannot describe abilities it
    does not have: an improvised answer is a promise nobody checked.
    """
    return normalise(text) in CAPABILITY_QUESTIONS


def classify_by_rules(message: str) -> Category | None:
    """The category these rules decide on their own, or None to ask the model.

    The confidentiality guard is checked first because it is a refusal on grounds
    of what the data is, and it has to win over any reading of the message's
    shape — "thanks, but what is my leave balance?" is a restricted request.
    """
    if is_personal_question(message):
        return Category.RESTRICTED

    if is_obvious_conversational(message):
        return Category.CONVERSATIONAL

    return None


# What the model is asked for, and the words it answers with. Kept here rather
# than in the engine so the whole decision — patterns, categories, prompt and
# parsing — is one readable unit, and so the classification can be tested without
# a client, a key or a network.
CLASSIFIER_SYSTEM_PROMPT = """You route messages for an internal knowledge \
assistant that answers questions about one company's policies, processes and \
workplace rules.

Reply with one line and nothing else, in exactly this form:
CATEGORY: <one of the four below>
QUESTION: <the message rewritten as a standalone question>

CATEGORY is:
- CONVERSATIONAL — anything that is not a request for information: greetings, \
thanks, goodbyes, acknowledgements ("ok", "got it"), reactions ("lol", "wow"), \
comments about the conversation itself ("there is no question", "that's not what \
I asked", "I was just saying hi"), and questions about the assistant itself ("who \
are you?", "what can you do?"). This is also the answer whenever you are unsure \
whether the message is a request for information at all: wrongly answering as \
conversational costs the reader one more message, while a wrong guess in either \
other direction makes the product look broken.
- COMPANY_QUESTION — a self-contained request for information about the company. \
The ordinary case.
- FOLLOW_UP — an in-scope request that only means something because of the turns \
before it ("anything else I should know?", "tell me more about that", "what about \
for contractors?", "and if I'm part-time?"). It is in scope, but it cannot be \
retrieved as written because the words in it name no document.
- OUT_OF_SCOPE — a real request for information or help that has nothing to do \
with the company: general knowledge, current events, weather, other \
organisations, personal favours. Not a follow-up to something in scope.

Judge by intent, never by punctuation or by topic. No question mark does not mean \
there is no question, and a question mark does not mean there is a company \
question. OUT_OF_SCOPE requires an actual request: a message that asks for \
nothing can never be OUT_OF_SCOPE.

QUESTION is the message as a complete, standalone question, with any reference to \
the conversation replaced by what it refers to. For COMPANY_QUESTION it is the \
message itself, lightly cleaned. For FOLLOW_UP it must name the topic in the words \
the conversation used, so "anything else I should know?" after a question about \
the Code of Conduct becomes "What else does the Code of Conduct document cover?"; \
do not invent a document title, because retrieval has nothing to match one \
against. For OUT_OF_SCOPE or CONVERSATIONAL, repeat the message unchanged."""


def build_classifier_prompt(message: str, history: Sequence[tuple[str, str]]) -> str:
    """The classifier's user message: the recent turns, then the message.

    The history is what makes a follow-up recognisable at all — "and if I'm
    part-time?" is a complete, self-contained, in-scope request on its own and only
    a follow-up because of what came before. It is also what tells the classifier
    that "there is no question" is a remark about the exchange rather than a
    request about anything. Oldest turn first, so it reads as a conversation, and
    truncated per turn because a long earlier answer is enough context to identify
    the topic and enough tokens to crowd out the message being classified.
    """
    if not history:
        return f"Conversation so far: (this is the first message)\n\nMessage: {message}"

    turns = "\n".join(
        f"{'Employee' if role == 'user' else 'Assistant'}: {' '.join(text.split())[:400]}"
        for role, text in history
    )

    return f"Conversation so far:\n{turns}\n\nMessage: {message}"


class ClassifierVerdict(BaseModel):
    """The classifier's reply, as a schema it has to satisfy to be read at all.

    A strict `Literal` rather than a lookup in a dict, so a value this code does
    not know fails validation instead of being coerced into one it does. The
    consequence is deliberate and is the important half of the rule: an unreadable
    verdict becomes a COMPANY_QUESTION, which retrieves and lets the corpus
    decide. A classifier quirk must never turn an answer the documents hold into
    a refusal.
    """

    model_config = ConfigDict(extra="forbid")

    category: Literal[
        "conversational",
        "company_question",
        "follow_up",
        "out_of_scope",
    ]
    question: str


# The classifier answers on one line, and a reasoning model wraps whatever it
# thinks onto lines of its own before that. The first line carrying a marker is
# therefore the answer; everything before it is discarded. The category is read
# permissively on purpose — `_CATEGORY_LINE` matches any word — so that an unknown
# category is caught by the schema below rather than by this regular expression.
_CATEGORY_LINE = re.compile(r"category\s*:\s*([a-z_ \-]+)", re.I)
_QUESTION_LINE = re.compile(r"question\s*:\s*(.+)", re.I)


def parse_classification(reply: str, message: str) -> Classification:
    """What the classifier decided, from however it phrased it.

    Every route out of here is the safe one. A reply that names no category, or
    names one this code does not know, is read as `COMPANY_QUESTION`: that
    retrieves and lets the corpus decide, which is what happened before
    classification existed. A reply that is missing the rewritten question keeps
    the original message, and so does one whose rewrite was cut off — see
    `_ends_a_sentence`. Both are deliberately wrong-looking answers rather than a
    wrong-looking refusal: guessing a category wrongly sends an in-scope question
    down the out-of-scope path, which loses an answer the documents had.
    """
    text = reply or ""
    match = _CATEGORY_LINE.search(text)

    if match is None:
        return Classification(Category.COMPANY_QUESTION, message)

    category = match.group(1).strip().lower().replace("-", "_").replace(" ", "_")
    rewritten = _QUESTION_LINE.search(text[match.end() :])
    question = rewritten.group(1).strip().strip('"').strip() if rewritten else ""

    try:
        verdict = ClassifierVerdict(category=category, question=question)
    except ValidationError:
        return Classification(Category.COMPANY_QUESTION, message)

    query = message

    # Long enough to be a question, and about the same size as what it came from:
    # a rewrite that runs to several times the original is the model answering
    # rather than restating, and answering is the generator's job.
    if (
        verdict.question
        and 8 <= len(verdict.question) <= max(len(message) * 4, 400)
        and _ends_a_sentence(verdict.question)
    ):
        query = verdict.question

    return Classification(Category(verdict.category), query)


# A question ends in punctuation, or in a closing mark after it. Anything else is a
# sentence that stopped, and a rewrite that stopped is worse than no rewrite at
# all: retrieval cannot match "What else does the" against anything, and the
# generator handed four loosely-related passages will answer *those* confidently.
# The classifier runs on a reasoning model that spends its output budget thinking
# before it writes, so a cut-off line is a real failure mode rather than a
# hypothetical one — and the fallback is the message as it was sent, which is what
# happened before rewrites existed.
_SENTENCE_END = re.compile(r"[.!?…][\"')\]]*$")


def _ends_a_sentence(text: str) -> bool:
    return bool(_SENTENCE_END.search(text.strip()))