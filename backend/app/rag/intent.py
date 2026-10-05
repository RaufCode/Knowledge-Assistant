"""The one classification every question goes through, before any retrieval.

Three things can be asked of this assistant, and they need three different answers:

* small talk, which is not a question about the corpus at all;
* a genuine question, which is the retrieval and grounded generation pipeline;
* a question about something HR or management keeps restricted, which is a notice
  rather than an answer even when the answer is sitting in an indexed document.

They are decided here, once, and the engine routes on the result. That is the point
of the module: `Assistant.ask_stream` reads the classification once and picks a
branch, so there is no question that reaches retrieval without passing here first and
no ordering in which a guard can be forgotten.

**Why rules and not a model call.** A classification that decides whether a
confidentiality guard applies is a poor place to spend a second model call on a
guess. Rules are auditable, cost no latency before the answer the user is actually
waiting for, and cannot be talked into a different answer by the phrasing of the
question — which is precisely the property a guard needs. The model is still asked to
refuse personal-record questions in its system prompt, so the two layers are
independent and either alone would catch the obvious cases.

## Editing the lists below

`RESTRICTED_SUBJECTS`, `ALWAYS_RESTRICTED` and `GREETING_PHRASES` are the whole of
what somebody reviewing this policy has to read. Adding a restricted topic means
adding one regex to `RESTRICTED_SUBJECTS`; there is no other file to touch and no
logic to understand first. Each is written as a regex against a lowercased question,
so anything `re` supports works.

The trade-off to keep in mind when adding one: a subject only needs a *person*
reference alongside it to be restricted, which is what lets "what is the salary band
for engineers" through as a policy question while "what does Ama earn" is not. A
pattern added to `ALWAYS_RESTRICTED` skips that requirement and so catches aggregate
or process framings ("show me the payroll") that no single person reference covers.
"""

import random
import re
from dataclasses import dataclass
from enum import Enum

# --------------------------------------------------------------------------- #
# What HR and management keep restricted.                                          #
# --------------------------------------------------------------------------- #

# Subjects that are confidential when the question is about a particular person.
#
# Deliberately not bare nouns. "Leave" and "salary" on their own are policy
# subjects — the entitlement and the pay bands are things the handbook publishes —
# so each entry here is the individual-record sense of the word. Someone asking
# "how much annual leave do I get?" is asking the policy; someone asking "how many
# days does Ama have left?" is asking about a person, and only the second is listed.
RESTRICTED_SUBJECTS = [
    # Pay, for one person rather than as a published band.
    r"\bsalary\b",
    r"\bpay\s?slip",
    r"\bwage[sd]?\b",
    r"\bcompensation\b",
    r"\bremuneration\b",
    r"\bbonus(?:es)?\b",
    r"\b(?:13th|thirteenth)\s+month\b",
    r"\b(?:salary|compensation|pay)\s+(?:band|range|review|increment|structure)\b",
    r"\bincrease\b.*\bsalary\b|\bsalary\b.*\bincrease\b",
    r"\b(?:tax|pension|ssnits|nssf|provident\s+fund)\b",
    # Pay stated as a verb rather than as a noun. "What does Kwame earn?" and "how
    # much is Kofi paid?" name no salary at all, and a subject list of nouns alone
    # would wave both through — which is the indirect phrasing the guard most needs
    # to catch, since it is the one somebody uses when the obvious word is on a
    # blocklist somewhere.
    #
    # `paid` is matched only after a form of "be", because "paid" also introduces
    # the ordinary policy phrase "paid annual leave", which is a question the
    # handbook answers and this guard must not touch.
    r"\bearn(?:s|ed|ing)?\b",
    r"\b(?:is|are|was|were|be|been|being|gets?|got|getting)\b[^?]{0,30}\bpaid\b",
    r"\bpay\s?checks?\b",
    r"\b(?:how\s+much|what)\b[^?]{0,40}\bmake\b",
    # Performance and conduct, which are HR's alone.
    r"\bappraisal\b",
    r"\bperformance\s+(?:review|rating|score|improvement|plan)\b",
    r"\b(?:disciplinary|discipline|misconduct|grievance|warning\s+letter)\b",
    r"\b(?:promotion|promoted|demotion|demoted|sacked|fired|terminated|resign\w*)\b",
    r"\b(?:probation|contract\s+terms?|employment\s+letter)\b",
    # Health, where an answer is both private and a special-category record.
    r"\b(?:medical|health|illness|diagnosis|sick\s+notes?)\b",
    # Legal, compliance and investigation.
    r"\binvestigation\b",
    r"\b(?:disciplinary|compliance|legal|audit)\s+(?:investigation|case|matter|file)s?\b",
    r"\b(?:police|disciplinary)\s+report\b",
    # Identity and bank details, which no policy document should be leaking either.
    r"\b(?:bank|account)\s+(?:number|details|balance)\b",
    r"\bnational\s+(?:insurance|id|identification)\b",
    # Home and next-of-kin, kept apart from work contact details: the HR directory
    # publishes work email and office location on purpose so people can look each
    # other up, and blocking that would break the reason the directory exists.
    r"\bhome\s+(?:address|phone|number)\b",
    r"\b(?:personal|private|home)\s+(?:phone|number|email)\b",
    r"\bnext\s+of\s+kin\b",
    r"\b(?:blood\s+group|religion|nationality|ethnicity|marital\s+status)\b",
    # Individual leave accounting, as opposed to the published entitlement.
    #
    # Written loosely on purpose, because "leave balance", "leave days remaining"
    # and "days left" are the same request three ways and only the first is a
    # phrase worth pinning down. It stays safe to be loose here because a restricted
    # subject on its own still has to pass the person check below: "how much leave
    # is left in the year" names no person and so remains the policy question it is.
    r"\b(?:leave|days|hours|holiday|vacation)\b[^?]{0,30}\b(?:balance|balances|remaining|left|owed|accrued)\b",
    r"\bhow\s+(?:many|much)\s+leave\s+(?:do|have|did)\b",
    # "How much do I have left?" names no noun at all, so the balance sense has to
    # be recognisable from the grammar instead. Kept narrow by the person check
    # below: it takes a personal pronoun in the same question to count.
    r"\bhow\s+(?:much|many)\b[^?]{0,30}\b(?:do|have|did)\b[^?]{0,20}\b(?:left|remaining|owed)\b",
]

# Framings that are confidential whatever else is in them, because the restricted
# part is the act of producing the list rather than any one person's record.
#
# `payroll` is deliberately absent, having been tried here first: it caught "who do I
# contact about payroll?", which is a question the handbook answers. It stays in
# `RESTRICTED_SUBJECTS`, where the person check catches "show me the payroll" anyway
# and lets the contact question through.
ALWAYS_RESTRICTED = [
    r"\b(?:list|show|give|tell|export|dump|send)\s+(?:me\s+)?(?:all|every|everyone)\b",
    r"\b(?:everyone|everybody|each\s+(?:employee|staff|worker|person))'?s\b",
    r"\bdirectory\b.*\b(?:export|download|full)\b",
    r"\bwho\s+(?:got|received|was\s+given)\s+(?:a\s+)?(?:raise|promotion|bonus|review)\b",
    # Asking for the payroll itself, which is a request for the data rather than a
    # question about the process. "Who do I contact about payroll?" is the handbook
    # answering a question about a department, and it has to stay answerable: the
    # personal pronoun in it is the person asking, not the subject being asked about.
    r"\b(?:show|list|export|send|give|dump|download)\s+(?:me\s+)?(?:the\s+|all\s+)?pay\s?roll\b",
]

# Personal phrasing that answers "is this about a person?" without needing a name.
# Covers the asker's own records as well as anyone else's, which is why "what is my
# salary" is restricted here rather than needing a name to be spotted.
_PERSON_REFERENCE = (
    r"\b(?:my|mine|i|me|my\s+own|our|ours|us)\b"
    r"|\b(?:his|her|their|theirs|he|she|they|him|them)\b"
    r"|\b(?:someone|somebody|anyone|anybody|another\s+(?:employee|staff|person|colleague))\b"
)

# Capitalised words that are organisation or document vocabulary rather than people.
#
# Without this, "What does the Compensation Policy say about salary?" would read
# "Compensation" as a person's name and refuse a question the handbook answers. The
# list is deliberately short: adding a word here exempts it everywhere, so only add
# one that could plausibly appear in a question about a person.
NON_PERSON_WORDS = {
    "a", "an", "and", "any", "are", "as", "at", "be", "but", "by", "can", "company",
    "compensation", "compliance", "conduct", "could", "did", "do", "does", "for",
    "from", "handbook", "has", "have", "he", "her", "his", "hr", "how", "human",
    "i", "if", "in", "internal", "is", "it", "its", "leave", "manager", "monday",
    "my", "new", "not", "of", "on", "onboarding", "or", "our", "payroll", "policy",
    "portal", "the", "their", "there", "these", "they", "this", "those", "to",
    "tuesday", "us", "was", "we", "what", "when", "where", "which", "who", "why",
    "will", "with", "work", "would", "you", "your",
    # Calendar and times, so "Monday" and "January" are not read as names.
    "january", "february", "march", "april", "june", "july", "august",
    "september", "october", "november", "december", "wednesday", "thursday",
    "friday", "saturday", "sunday", "morning", "afternoon", "evening",
    # Openers and pleasantries, which are capitalised at the start of a sentence and
    # would otherwise read as somebody's surname. Without these, "good morning, who
    # do I contact about payroll?" is refused because it appears to name a person
    # called Good.
    "good", "hello", "hey", "hi", "thanks", "thank", "please", "cheers", "bye",
    "goodbye", "regards", "sincerely", "dear", "ok", "okay",
}

# A capitalised word sitting inside a possessive: "Kwame's", "Ama Konadu's".
_POSSESSIVE_NAME = re.compile(r"\b([A-Z][a-z]+)'s\b")

# The greeting responses, kept beside the patterns that recognise them.
#
# Several rather than one. A single fixed sentence made the assistant read as a form
# with a message attached: somebody saying hello was told the same words by everybody,
# every day, which is the opposite of how being greeted should feel. Each one says
# the same two things — what this is, and that a question is welcome — because the
# content matters more than the phrasing, and none of them pretends to know what the
# person wants, because nothing does yet.
GREETING_REPLIES = (
    "Hello! I'm the assistant for questions about company policies, onboarding "
    "and internal processes. What would you like to know?",

    "Hi there. I answer questions about company policies, onboarding and internal "
    "processes — what can I help with?",

    "Hello! Ask me about company policies, onboarding or internal processes.",

    "Hey. Company policies, onboarding and internal processes are what I'm here "
    "for, so what would you like to know?",

    "Good to see you. I can help with company policies, onboarding and internal "
    "processes. What's your question?",

    "Hello! I answer questions about company policies, onboarding and internal "
    "processes. Where would you like to start?",
)


def greeting_reply() -> str:
    """One of the greetings, chosen afresh each time.

    Picked per request rather than once at import, so the choice is not fixed for the
    lifetime of the process — a server that always greeted the same way would look
    exactly like the single fixed reply it replaced, just with more code.
    """
    return random.choice(GREETING_REPLIES)

# The refusal for a restricted question. Says what happened and where to go, and
# never names the individual or the record, so a refusal cannot itself leak the
# fact that a file exists.
RESTRICTED_REPLY = (
    "This question involves confidential information that I'm not able to share. "
    "Please reach out to HR directly for this."
)

# The refusal for the asker's own records. Separate wording because the situation
# is different: this is not somebody else, and there is a place they can go and get
# it themselves. Still never answers with a figure.
PERSONAL_REPLY = (
    "I can only answer general policy questions and I can't access personal "
    "records such as leave balances, salaries or payslips. Please check the HR "
    "self-service portal on the intranet, or contact HR at hr@acmetech.example."
)

# --------------------------------------------------------------------------- #
# Small talk.                                                                   #
# --------------------------------------------------------------------------- #

# Phrases that are entirely conversational. Matched against the question with
# punctuation stripped, so "Thanks!" and "thanks" are the same thing.
GREETING_PHRASES = [
    "hello", "hi", "hey", "hiya", "howdy", "yo", "sup", "greetings",
    "good morning", "good afternoon", "good evening", "good day",
    "how are you", "how are you doing", "how's it going", "hows it going",
    "how have you been", "how are things", "how's everything",
    "i am good", "im good", "i'm good", "i am fine", "im fine", "i'm fine",
    "i am ok", "im ok", "i'm ok", "not bad", "pretty good",
    "thanks", "thank you", "thanks a lot", "thank you very much", "ta", "cheers",
    "bye", "goodbye", "see you", "see you later", "later", "take care",
    "nice to meet you", "good to meet you", "any update", "whats up", "what's up",
]

# Words left over after the phrases above are removed. All conversational filler
# with no question in it, so a message made only of these is small talk too.
GREETING_FILLER = {
    "there", "everyone", "everybody", "all", "ok", "okay", "fine", "good", "great",
    "i", "im", "i'm", "am", "is", "and", "so", "yes", "no", "you", "u", "we",
    "us", "your", "the", "a", "an", "to", "me", "my", "that", "it", "this", "u",
    "cool", "nice", "awesome", "sounds", "thank", "thx", "pls", "please",
}

_WORD_SPLIT = re.compile(r"[^a-z']+")
_APOSTROPHES = re.compile(r"[’‘]")
# Standalone contractions that survive the split, normalised to one spelling.
_CONTRACTIONS = {
    "how's": "hows", "what's": "whats", "where's": "wheres", "who's": "whos",
    "that's": "thats", "it's": "its", "you're": "youre", "we're": "were",
    "he's": "hes", "she's": "shes", "i'm": "im", "i've": "ive", "don't": "dont",
}


class Intent(str, Enum):
    """What a question turned out to be. The engine routes on this and nothing else."""

    GREETING = "greeting"
    QUESTION = "question"
    RESTRICTED = "restricted"


@dataclass(frozen=True)
class Classification:
    """The decision, plus which restricted rule made it.

    The reason is carried rather than discarded because it chooses between two
    different refusals, and because it is what a log line quotes when somebody asks
    why a question was turned away.
    """

    intent: Intent
    reason: str | None = None


def _words(text: str) -> list[str]:
    """A question as lowercase word tokens, with contractions normalised."""
    normalised = _APOSTROPHES.sub("'", text.lower())
    normalised = re.sub(r"[^a-z\s']", " ", normalised)

    return [_CONTRACTIONS.get(token, token) for token in _WORD_SPLIT.split(normalised) if token]


def _mentions_a_person(words: list[str], raw: str) -> bool:
    """Whether the question is about a particular person rather than about policy.

    Three ways it can be, and all three are needed:

    * a personal pronoun or possessive anywhere in it, which is how the asker's own
      records are caught without naming them;
    * a possessive on a capitalised word, "Kwame's", which is the commonest
      indirect form and the one a keyword list on the subject alone would miss;
    * a capitalised word that is not ordinary question vocabulary and not one of the
      organisation's own terms, which is how a name in the middle of a sentence is
      found.
    """
    joined = " ".join(words)

    if re.search(_PERSON_REFERENCE, joined):
        return True

    if _POSSESSIVE_NAME.search(raw):
        return True

    # Checked against the original so the capitalisation survives, and against the
    # joined tokens so a multi-word name still only needs one word to be decisive.
    return any(
        token[:1].isupper() and token.lower() not in NON_PERSON_WORDS
        for token in raw.replace("'", " ").split()
        if token[:1].isalpha()
    )


def _is_restricted(words: list[str], raw: str) -> Classification | None:
    """The restricted verdict, or None when nothing in the question is restricted."""
    joined = " ".join(words)

    for pattern in ALWAYS_RESTRICTED:
        if re.search(pattern, joined):
            return Classification(Intent.RESTRICTED, f"aggregate: {pattern}")

    restricted_subject = next(
        (pattern for pattern in RESTRICTED_SUBJECTS if re.search(pattern, joined)), None
    )

    if restricted_subject is None:
        return None

    # A restricted subject on its own is not enough. "What is the salary band?" is
    # the handbook answering a policy question, and refusing it would make the
    # assistant useless for exactly the pay questions it exists to answer.
    if not _mentions_a_person(words, raw):
        return None

    # Distinguishes "that is mine" from "that is theirs" only so the two refusals
    # can read differently; both are refused, and neither reveals anything.
    own_record = bool(re.search(r"\b(?:my|mine|i|me|my\s+own|our|ours|us)\b", joined))

    return Classification(
        Intent.RESTRICTED,
        f"{'own record' if own_record else 'another person'}: {restricted_subject}",
    )


def _is_greeting(words: list[str]) -> bool:
    """Whether nothing but small talk is left once the phrases are removed.

    Decided by subtraction rather than by asking whether the text starts like a
    greeting, because "hello, what is the leave policy?" starts exactly like one and
    is a real question. Stripping the conversational parts and looking at what is
    left is what tells the two apart: the first is left with nothing, the second
    with the actual question.
    """
    remaining = list(words)

    # Longest phrase first, so "good morning" is removed as a phrase rather than
    # leaving "morning" behind to be read as content.
    for phrase in sorted(GREETING_PHRASES, key=len, reverse=True):
        parts = phrase.split()
        index = 0

        while index + len(parts) <= len(remaining):
            if remaining[index : index + len(parts)] == parts:
                del remaining[index : index + len(parts)]
            else:
                index += 1

    return all(word in GREETING_FILLER for word in remaining)


def classify(question: str) -> Classification:
    """What this question is, decided before anything is retrieved.

    Restricted is checked first and on purpose. A greeting check that ran first
    would let "hi, what does Ama earn?" be answered as small talk, which is the one
    ordering mistake that turns this guard into decoration.

    Nothing here touches the corpus, so a question that legitimately has no matching
    document is still classified as a question. That is the whole reason this runs
    before retrieval: a greeting has no relevant passage by nature, and reading that
    as a failed search is what produced the "I couldn't find that, contact HR"
    answer to somebody saying hello.
    """
    raw = question.strip()
    words = _words(raw)

    if not words:
        return Classification(Intent.QUESTION)

    restricted = _is_restricted(words, raw)

    if restricted is not None:
        return restricted

    if _is_greeting(words):
        return Classification(Intent.GREETING, "small talk")

    return Classification(Intent.QUESTION)