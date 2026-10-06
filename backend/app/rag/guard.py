"""Which of five things a message is, decided before anything is looked up.

Every message reaches retrieval down exactly one of these paths, and the four the
user asked about mean genuinely different things, which is why they are told apart
rather than collapsed into "a question or not a question":

- GREETING: small talk. Nothing to look up, so nothing is.
- PERSONAL: a question about the asker's own records, which is not the assistant's
  to answer whatever it is in scope for.
- QUESTION: a self-contained question about the company. The ordinary path.
- FOLLOW_UP: a short, context-dependent message that only means something against
  the turns before it. Retrieved as the standalone question it resolves to.
- OUT_OF_SCOPE: not about the company at all. Answered with what the assistant is
  for, because "I could not find that in the documents" claims a gap in the corpus
  that is not there.

Greeting and personal are decided by pattern, without a model call: both are
recognisable from the message alone, both are exact-match judgements where a model
can only introduce a way to be wrong, and a greeting in particular must not depend
on the model being reachable. The other three cannot — a follow-up is defined by
the conversation it is following, and an out-of-scope question can be phrased in
any of a hundred ways — so those go to the model with the recent turns in hand.
"""

import re
from collections.abc import Sequence
from dataclasses import dataclass
from enum import Enum

PERSONAL_PATTERNS = [
    r"\bmy\b(\s+\w+){0,2}\s+(salary|pay\s?slip|appraisal|balance|tax)\b",
    r"\b(days|leave)\b.*\b(do i have|have i got|i have)\b.*\b(left|remaining)\b",
    r"\bhow (much|many)\b.*\b(do i have|have i got)\b.*\b(left|remaining)\b",
]


class Category(str, Enum):
    """What a message turned out to be. The path it takes from here."""

    GREETING = "greeting"
    PERSONAL = "personal"
    QUESTION = "question"
    FOLLOW_UP = "follow_up"
    OUT_OF_SCOPE = "out_of_scope"


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


# Small talk on its own. Anything carrying a question alongside the greeting is
# a question and is not matched: answering that with a greeting would be
# refusing to do the actual job.
GREETING_WORDS = {
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
    "bye",
    "byeee",
    "goodbye",
    "good bye",
    "see you",
    "see you later",
    "see ya",
    "talk to you later",
    "thanks",
    "thank you",
    "thankyou",
    "thx",
    "thanks a lot",
    "thank you so much",
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
    "who are you",
    "what are you",
    "what can you do",
    "what do you do",
    "how can you help",
    "help",
    "help me",
    "please help",
}

# Words that may follow a greeting without making it a question.
GREETING_ADDRESSEES = {
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

# Upper bound on a normalised greeting, so sentences never qualify.
MAX_GREETING_LENGTH = 32


def is_greeting(text: str) -> bool:
    """Whether this message is small talk and nothing else.

    Case, surrounding whitespace and trailing punctuation are ignored, and
    stretched letters are folded, because none of those change what the
    message is.
    """
    cleaned = re.sub(r"\s+", " ", text.strip().lower())
    cleaned = re.sub(r"(.)\1{2,}", r"\1\1", cleaned)
    cleaned = re.sub(r"[!?.\u2026,;:'\"]+$", "", cleaned).strip()

    if not cleaned or len(cleaned) > MAX_GREETING_LENGTH:
        return False

    if cleaned in GREETING_WORDS:
        return True

    head, _, tail = cleaned.rpartition(" ")

    return bool(tail) and head in GREETING_WORDS and tail in GREETING_ADDRESSEES


# What the model is asked for, and the words it answers with. Kept here rather
# than in the engine so the whole decision — patterns, categories, prompt and
# parsing — is one readable unit, and so the classification can be tested without
# a client, a key or a network.
CLASSIFIER_SYSTEM_PROMPT = """You route messages for an internal knowledge assistant \
that answers questions about one company's policies, processes and workplace rules.

Reply with one line and nothing else, in exactly this form:
CATEGORY: <one of the four below>
QUESTION: <the message rewritten as a standalone question>

CATEGORY is:
- QUESTION — a self-contained question about the company. Also anything unclear:
  when you are unsure, prefer this. It is the only category that retrieves, so a
  wrong guess here costs a search, while a wrong guess elsewhere costs an answer.
- FOLLOW_UP — the message only means something because of the turns before it
  ("anything else I should know?", "tell me more about that", "what about for
  contractors?", "and if I'm part-time?"). It is in scope, but it cannot be
  retrieved as written because the words in it name no document.
- OUT_OF_SCOPE — nothing to do with the company: general knowledge, current events,
  weather, other organisations, personal favours. Not a follow-up to something
  in scope.
- GREETING — greetings, thanks, or a question about the assistant itself.

QUESTION is the message as a complete, standalone question, with any reference to
the conversation replaced by what it refers to. For a QUESTION it is the message
itself, lightly cleaned. For a FOLLOW_UP it must name the topic, so "anything else
I should know?" after a question about the Code of Conduct becomes "What else does
the Code of Conduct document cover?". For OUT_OF_SCOPE or GREETING, repeat the
message unchanged."""


def build_classifier_prompt(message: str, history: Sequence[tuple[str, str]]) -> str:
    """The classifier's user message: the recent turns, then the message.

    The history is what makes a follow-up recognisable at all — "and if I'm
    part-time?" is a complete, self-contained, in-scope question on its own and
    only a follow-up because of what came before. Oldest turn first, so it reads
    as a conversation, and truncated per turn because a long earlier answer is
    enough context to identify the topic and enough tokens to crowd out the
    message being classified.
    """
    if not history:
        return f"Conversation so far: (this is the first message)\n\nMessage: {message}"

    turns = "\n".join(
        f"{'Employee' if role == 'user' else 'Assistant'}: {' '.join(text.split())[:400]}"
        for role, text in history
    )

    return f"Conversation so far:\n{turns}\n\nMessage: {message}"


# The classifier answers on one line, and a reasoning model wraps whatever it
# thinks onto lines of its own before that. The first line carrying a marker is
# therefore the answer; everything before it is discarded.
_CATEGORY_LINE = re.compile(r"category\s*:\s*(question|follow[_\- ]?up|out[_\- ]of[_\- ]scope|greeting)", re.I)
_QUESTION_LINE = re.compile(r"question\s*:\s*(.+)", re.I)

_CATEGORY_WORDS = {
    "question": Category.QUESTION,
    "follow_up": Category.FOLLOW_UP,
    "follow-up": Category.FOLLOW_UP,
    "out_of_scope": Category.OUT_OF_SCOPE,
    "out-of-scope": Category.OUT_OF_SCOPE,
    "greeting": Category.GREETING,
}


def parse_classification(reply: str, message: str) -> Classification:
    """What the classifier decided, from however it phrased it.

    Every route out of here is the safe one. A reply that names no category, or
    one this code does not know, is read as `QUESTION`: that retrieves and lets the
    corpus decide, which is what happened before classification existed. A reply
    that is missing the rewritten question keeps the original message, so a
    follow-up would be retrieved as written and come back as a genuine not-found —
    the old behaviour, not a new failure. Both are deliberately wrong-looking
    answers rather than a wrong-looking refusal: guessing a category wrongly sends
    an in-scope question down the out-of-scope path, which loses an answer the
    documents had.
    """
    text = reply or ""
    match = _CATEGORY_LINE.search(text)

    if match is None:
        return Classification(Category.QUESTION, message)

    category = _CATEGORY_WORDS.get(match.group(1).lower().replace(" ", "_"))

    if category is None:
        return Classification(Category.QUESTION, message)

    rewritten = _QUESTION_LINE.search(text[match.end() :])
    query = message

    if rewritten is not None:
        candidate = rewritten.group(1).strip().strip('"').strip()

        # Long enough to be a question, and about the same size as what it came
        # from: a rewrite that runs to several times the original is the model
        # answering rather than restating, and answering is the generator's job.
        if candidate and 8 <= len(candidate) <= max(len(message) * 4, 400):
            query = candidate

    return Classification(category, query)
