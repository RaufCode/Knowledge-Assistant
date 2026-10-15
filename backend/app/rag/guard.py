"""Which kind of message this is, decided before anything is looked up.

Every message reaches retrieval down exactly one of these paths, and the six mean
genuinely different things, which is why they are told apart rather than collapsed
into "a question or not a question":

- CONVERSATIONAL: not a request for information at all. Greetings, thanks,
  goodbyes, acknowledgements, reactions, comments or corrections about the chat
  itself ("there is no question", "that's not what I asked"), and questions about
  the assistant ("who are you?"). Answered from the conversation, with no
  retrieval: there is nothing to look up.
- COMPANY_QUESTION: a self-contained request for company information. The
  ordinary path, and the only one that reads documents.
- FOLLOW_UP: an in-scope request that shifts or narrows the topic of the turns
  before it ("what about contractors?", "and if I'm part-time?"). Retrieved as
  the standalone question it resolves to.
- EXPANSION: a request for more of what has already been answered, naming no new
  topic ("anything else?", "tell me more", "go on"). Continued from the passages
  the previous answer was drawn from, rather than retrieved as written: "anything
  else" names no document, which is exactly how it used to end as a false "not
  found".
- OUT_OF_SCOPE: a real request for information or help that has nothing to do
  with the company. Answered with what the assistant is for.
- RESTRICTED: a request for private information about a specific individual. The
  confidentiality guard, and it is decided *before* retrieval, because a refusal
  must not depend on whether the corpus happens to hold something about the
  person. See the guard section below for what it covers and what it must not.

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

Two of the six are decided by pattern, without a model call: the obvious
conversational openers, the obvious expansions, and personal-record questions.
The rest go to the model with the recent turns in hand: a follow-up is defined by
the conversation it follows, an out-of-scope request can be phrased in any of a
hundred ways, and the confidentiality guard's rule patterns are trivially bypassed
by rephrasing — so the model is its backstop, not its replacement.
"""

import re
from collections.abc import Sequence
from dataclasses import dataclass
from enum import Enum
from typing import Literal

from pydantic import BaseModel, ConfigDict, ValidationError


# =============================================================================
# The confidentiality guard
# =============================================================================
# One place, editable, for what this assistant refuses and why. Everything below
# is a decision about policy rather than about code, so it is written as a list
# somebody can read and change without touching the routing around it.
#
# What is refused: private information about a specific individual — the asker's
# own records or a named or otherwise identified third party's — in these
# categories:
#
#   * salary, pay, bonus, payslip, or any other figure about compensation
#   * performance reviews, ratings, or improvement plans
#   * disciplinary, grievance or investigation records
#   * health, the reason for leave, or personal and family circumstances
#   * an individual's contact details where they are not an official contact
#   * termination or redundancy status
#
# What is *not* refused, and this is the half that is easy to get wrong: questions
# about how the company's rules work. "How is salary determined", "when is salary
# paid", "can I receive my salary before the due date", "what are the leave
# entitlements", "how do I request a salary review" and "what does the
# compensation policy cover" are all ordinary policy questions and must stay
# answerable. A previous bug refused a plain compensation paraphrase, so the
# asymmetry here is deliberate: the patterns are written to be sure of a refusal,
# the exceptions to be easy to trigger, and anything left over goes to the model
# with the same rule stated in its prompt.

# The private records themselves, as one fragment the patterns below share. Only
# ever used *attached to a person* — "her payslip", "Ama's bonus" — which is what
# keeps "the compensation policy" and "his compensation" apart.
#
# It carries its own `(?i:...)`, because the patterns it goes into must stay
# case-sensitive: a person's name is recognised by being capitalised, and a
# case-insensitive `[A-Z]` matches every word in the sentence.
_RECORD = (
    r"salar(?:y|ies)|payroll|paycheque|payslips?|pay|bonus|bonuses|"
    r"remuneration|compensation|appraisal|appraisals|performance reviews?|"
    r"ratings?|performance improvement plans?|pips?|disciplinary|discipline|"
    r"misconduct|grievances?|medical records?|health records?|diagnosis|illness|"
    r"sick leave|family (?:situation|circumstances)|"
    r"personal (?:circumstances|details|information|number|phone|email|address)|"
    r"home address|phone number|termination|dismissal|layoff|redundancy|"
    r"investigations?|leave balance|leave record|leave history|"
    # The same records in the form a passive takes them: "is being investigated",
    # "has been terminated".
    r"investigat\w*|terminat\w*|dismiss\w*|suspend\w*|redundan\w*|sacked|"
    r"resign\w*|apprais\w*"
)

_RECORD_CI = rf"(?i:(?:{_RECORD}))"

# A person, named. Two restrictions, both earned:
#
# - Two characters minimum, because the English pronoun "I" is capitalised too,
#   and a one-letter name would make every "do I get" and "can I receive" look
#   like somebody else's records.
# - Not an interrogative or a determiner, because "What is the salary review
#   process?" is a capitalised word followed by "is" and a record noun, and reads
#   as precisely what it is not: a person called What.
# - Not a word in a document title. "the Code of Conduct" and "the Security Policy"
#   are the corpus's own headings, and a capitalised word in one of those is not a
#   colleague: the two lookbehinds are what keeps "what does the Security Policy
#   say about salaries" out of the guard.
_NAME = (
    r"(?<!the )(?<!of )"
    r"(?!(?i:what|whats|who|whom|whose|which|when|where|why|how|is|are|was|do|"
    r"does|did|can|could|should|will|would|may|might|must|my|our|the|a|an|i|we|"
    r"they|he|she|his|her|their|there|here)\b)"
    r"(?!(?i:policy|policies|section|sections|code|codes|conduct|act|acts|scheme|"
    r"schemes|guide|guides|handbook|procedure|procedures|notice|schedule|standard|"
    r"standards|framework|regulation|regulations|appendix|form|forms|register|"
    r"records?|report|reports|summary|summaries|overview|details?|rules?)\b)"
    r"[A-Z][\w'-]+"
    r"(?:\s+[A-Z][\w'-]+)*"
)

# The words that make a sentence a request rather than a statement about a scheme.
# Used by the one pattern that matches a record and a person with no grammatical
# relationship between them, which is otherwise wide enough to read "the bonus is
# awarded to all colleagues each December" as a request about a colleague.
_ASKS = (
    r"(?:what|whats|what's|who|whom|whose|which|how much|how many|how|does|do|"
    r"did|is|are|was|were|can|could|will|would|tell me|show me|give me|any idea)"
)

# The words that stand in for a person when they are not named: a role, or a
# pronoun. Deliberately excludes the plurals — "all employees", "bonus is awarded
# to every colleague" are statements about a scheme, not about a person.
_ROLE = (
    r"colleague|co-?worker|teammate|classmate|manager|supervisor|boss|intern|"
    r"line\s?manager|team\s?lead"
)

# The person a record belongs to, where the sentence gives no clue which of them
# it is. The boundary after the role words is what keeps "a bonus scheme for
# interns" out of it.
_PERSON_AT_END = rf"(?:(?:{_ROLE})\b|\b{_NAME}\b|\b(?:he|she|they)\b)"

# Organisational possessors, which look exactly like a named person's possessive
# and are not one. Without this, "the company's salary policy" would be read as a
# request about a person's salary.
_ORGANISATION = (
    r"company|companies|organisation|organizations?|business|team|department|"
    r"division|group|firm|acme"
)

# Somebody else's records, in the shapes they are actually asked in:
#
#   "Ama's salary", "my colleague's bonus", "Kwame Mensah's payslip"
#   "his bonus", "her performance review"
#   "Does Ama get paid more than me?", "how much does Kwame earn"
#   "is Kofi on a PIP", "Kwame is being investigated", "was she terminated"
#   "who is being investigated", "what rating did my colleague get"
#   "what is kofi mensah's salary" — names arrive lowercased too
THIRD_PARTY_PATTERNS = [
    # A possessive after a capitalised name: "Ama's salary", "Kwame Mensah's bonus".
    rf"\b{_NAME}'s\s+{_RECORD_CI}\b",
    # The same with lower-case words before it: "kofi mensah's salary". Every word
    # of the possessive is checked against the organisational list, not only the
    # first: otherwise "how does the company's salary review work" is read as a
    # request about a person called "the".
    rf"(?i:\b(?!{_ORGANISATION}\b)[a-z][a-z'-]*"
    rf"(?:\s+(?!{_ORGANISATION}\b)[a-z][a-z'-]*)*'s)\s+{_RECORD_CI}\b",
    # A possessive standing in for a person by role or pronoun: "her manager's bonus".
    rf"(?i:\b(?:{_ROLE}|his|her|their|my colleague's|my manager's|my boss's)'s)\s+{_RECORD_CI}\b",
    # A pronoun attached to the record: "his bonus", "their payslip".
    rf"(?i:\b(?:his|her|their)\s+{_RECORD_CI})\b",
    # A named person and a verb of receiving, which is how a question asks about
    # money without naming the record: "Does Ama get paid more than me?",
    # "how much does Kwame earn".
    rf"\b(?:does|did|do|will|has|have)?\s*{_NAME}\s+"
    rf"(?i:earn|earns|earned|get|gets|got|getting|receive|receives|received)\b",
    # A person and a pronoun and a verb, for the same request when the person is
    # not named: "did he get a bonus last quarter".
    rf"(?i:\b(?:he|she|they|someone|somebody|anyone|anybody|the\s+(?:{_ROLE}|"
    rf"employee|person|new joiner|new hire))\b[^?!]{{0,40}}"
    rf"(?i:earn|earns|earned|get|gets|got|receive|receives|received|draw|draws)\b)",
    # A named person described as being on a plan or under investigation:
    # "Kofi is on a PIP", "is Kofi under investigation".
    rf"\b{_NAME}\s+(?i:is|are|was|were|be|been)\s+(?i:on|in|under|being)\s+"
    rf"(?i:an?|the)?\s*{_RECORD_CI}\b",
    # ... and the same with the copula first: "is Kofi on a PIP?".
    rf"(?i:\b(?:is|are|was|were)\s+){_NAME}\s+(?i:on|in|under|being)\s+"
    rf"(?i:an?|the)?\s*{_RECORD_CI}\b",
    # A person or a pronoun placed on one of those records: "is my colleague on a
    # performance improvement plan?", "she is under investigation".
    rf"(?i:\b(?:{_ROLE}|his|her|their|my\s+(?:{_ROLE}|manager|boss|employee))\b)"
    rf"\s+(?i:is|are|was|were|has been|have been|been|being)?\s*"
    rf"(?i:on|in|under)\s+(?i:an?|the)?\s*{_RECORD_CI}\b",
    # A named person with the record as its predicate, in either word order:
    # "Kwame is a disciplinary case", "why was Kofi suspended", "has Kwame been
    # terminated".
    rf"\b{_NAME}\s+(?i:is|are|was|were|has been|have been|been|being)?\s*"
    rf"(?i:an?|the)?\s*{_RECORD_CI}\b",
    rf"(?i:\b(?:is|are|was|were|has|have)\s+){_NAME}\s+"
    rf"(?i:an?|the\s+|been\s+)?{_RECORD_CI}\b",
    # A bare pronoun as the subject of one of those states: "he is on a disciplinary
    # process", "she on sick leave".
    rf"(?i:\b(?:he|she|they)\b)\s+(?i:is|are|was|were|been|being)?\s*"
    rf"(?i:on|in|under)\s+(?i:an?|the)?\s*{_RECORD_CI}\b",
    # ... and the same with the copula first: "why is she on sick leave?".
    rf"(?i:\b(?:is|are|was|were|has been|have been)\s+(?:{_ROLE}|his|her|their|"
    rf"my\s+(?:{_ROLE}|manager|boss|employee))\b)\s+"
    rf"(?i:(?:is|are|was|were|been|being)\s+)?(?i:on|in|under)\s+(?i:an?|the)?\s*{_RECORD_CI}\b",
    # A record noun and the person it belongs to, with no grammatical relationship
    # between them: "what rating did my colleague get", "the bonus Kwame received".
    # A request is required, so a statement about a scheme — "the bonus is awarded
    # to all colleagues each December" — is not read as a request about one.
    rf"(?i:{_ASKS})\b[^?!]{{0,60}}{_RECORD_CI}\b[^?!]{{0,40}}{_PERSON_AT_END}"
    rf"|{_RECORD_CI}\b[^?!]{{0,40}}{_PERSON_AT_END}[^?!]{{0,24}}(?i:{_ASKS})"
    # ... and the person mentioned before the record, closely enough to be about
    # it: "what did his manager say about the bonus". Sixteen characters is the
    # budget, because a longer gap means a document title has come between them —
    # "the Code of Conduct", "the Security Policy" — and a capitalised word in a
    # title is not a colleague.
    rf"|(?i:{_ASKS})\b[^?!]{{0,40}}{_PERSON_AT_END}[^?!]{{0,16}}{_RECORD_CI}\b",
    # A passive about a person, where the subject is an open question:
    # "who is being investigated".
    rf"(?i:\b(?:who|which\s+(?:employee|colleague|person))\b[^?!]{{0,24}}"
    rf"\b(?:investigat\w*|terminat\w*|dismiss\w*|suspend\w*|redundan\w*)\b)",
    # ... and the same about a pronoun: "was she terminated last year".
    rf"(?i:\b(?:he|she|they)\b[^?!]{{0,24}}"
    rf"\b(?:investigat\w*|terminat\w*|dismiss\w*|suspend\w*|redundan\w*)\b)",
]

# The asker's own records, split by whether the policy exception can apply to them.
#
# A figure or a document about them ("my salary") can be asked about in a
# policy-shaped way — "when is my salary paid" — so those may be excepted. A leave
# balance cannot: there is no reading of "how many leave days do I have left" that
# is a question about the rules, so those stay refused whatever else is around them.
OWN_RECORD_PATTERNS = [
    r"\bmy\b(\s+\w+){0,2}\s+(salary|pay\s?slip|appraisal|balance|tax)\b",
]

OWN_BALANCE_PATTERNS = [
    r"\b(days|leave)\b.*\b(do i have|have i got|i have)\b.*\b(left|remaining)\b",
    r"\bhow (much|many)\b.*\b(do i have|have i got)\b.*\b(left|remaining)\b",
]

# Every own-record request, exactly as it was before the third-party rules existed.
PERSONAL_PATTERNS = OWN_RECORD_PATTERNS + OWN_BALANCE_PATTERNS

# Questions about how the rules work. Deliberately generous, and applied only to
# the asker's own figures: a policy-shaped question is far likelier to be an
# ordinary question that happens to contain a record noun ("when is my salary
# paid") than an attempt to get at somebody's figures.
POLICY_QUESTION_PATTERNS = [
    r"\bhow\b",
    r"\bwhen\b",
    r"\bwhy\b",
    r"\bwhere\b",
    r"\b(?:policy|policies|process|procedure|procedures|criteria|"
    r"guidelines?|entitlements?|eligib\w+|requirements?)\b",
    r"\b(?:can|may|am|should|do|would|could)\s+(?:i|we|an employee|a new joiner)\b",
    r"\b(?:paid|payday|payment|payments|received|receive|before|after|due|"
    r"schedule|scheduled|review|reviews|appeal|apply|application|process)\b",
]

# A request to *see* the figure, rather than to ask how the rules work. It
# overrides the policy markers, because "can I see my salary" and "can I receive my
# salary before the due date" are the same shape and opposite questions: the first
# is a request for a person's data, the second is a question about the payroll
# calendar. "paid" and "receive" are left out of it for the same reason — in this
# question they name the process, not the data.
ACCESS_PATTERNS = [
    r"\b(?:see|view|read|access|reveal|disclose|show me|tell me|know|look up|"
    r"find out|what(?:'s| is)|how much)\b",
]

_PAYMENT_MARKERS = [r"\b(?:paid|payday|payment|payments|receive|received)\b"]

# Compiled once, and without `re.I`: the capitalisation is the signal. A broken
# pattern here fails at import rather than on somebody's first question about a
# colleague.
THIRD_PARTY_RE = tuple(re.compile(pattern) for pattern in THIRD_PARTY_PATTERNS)


def _matches_any(text: str, patterns: Sequence[str]) -> bool:
    return any(re.search(pattern, text, re.I) for pattern in patterns)


def is_restricted_request(text: str) -> bool:
    """Whether this asks for private information about a specific individual.

    A refusal, so the order is the logic: a question about a *named other person*
    is refused whatever else it says, and a question about the asker's own records
    is refused unless it is plainly about the company's rules.

    The rule layer is the sure half and the cheap one. It catches possessives in
    both cases, pronouns, roles, named people receiving something, and passives
    about a person, with no model call. It cannot catch every rephrasing — "how
    much does Kofi bank" is the same request — which is why the classifier asks the
    model as well: the rules are what must never be talked out of, and the model is
    what decides the phrasings nobody thought of.
    """
    if not text.strip():
        return False

    # About somebody else. First and unconditional: a policy marker in the same
    # sentence ("how much should Ama's salary be?") describes the question's shape,
    # not its subject, and the subject is a person.
    if any(pattern.search(text) for pattern in THIRD_PARTY_RE):
        return True

    q = " ".join(text.lower().split())

    # A leave balance has no policy reading at all, so it is refused outright.
    if _matches_any(q, OWN_BALANCE_PATTERNS):
        return True

    # Anything else about the asker's own records.
    if not _matches_any(q, OWN_RECORD_PATTERNS):
        return False

    # A record noun plus a request to see it is a request for the data, however
    # politely it is put.
    if _matches_any(q, ACCESS_PATTERNS) and not _matches_any(q, _PAYMENT_MARKERS):
        return True

    return not _matches_any(q, POLICY_QUESTION_PATTERNS)


class Category(str, Enum):
    """What a message turned out to be. The path it takes from here."""

    CONVERSATIONAL = "conversational"
    COMPANY_QUESTION = "company_question"
    FOLLOW_UP = "follow_up"
    EXPANSION = "expansion"
    OUT_OF_SCOPE = "out_of_scope"
    RESTRICTED = "restricted"


# The six the model chooses between.
#
# RESTRICTED is here even though the guard's own patterns decide most of it,
# because name patterns are bypassable by rephrasing and a guard that only catches
# the phrasings somebody thought of is not a guard. The rules run first and
# without a model call; the model is the backstop for everything they miss. What
# the model cannot do is talk a rule out of a refusal, because the rules are
# checked before it is called.
MODEL_CATEGORIES: tuple[str, ...] = (
    Category.CONVERSATIONAL.value,
    Category.COMPANY_QUESTION.value,
    Category.FOLLOW_UP.value,
    Category.EXPANSION.value,
    Category.OUT_OF_SCOPE.value,
    Category.RESTRICTED.value,
)


@dataclass(frozen=True)
class Classification:
    """A category, and for a follow-up the standalone question it resolves to.

    `query` is what gets retrieved and generated against. For a question it is the
    message itself; for a follow-up it is the follow-up rewritten so it stands on
    its own — "what about contractors?" asked after a question about the Code of
    Conduct becomes a question about contractors and the Code of Conduct.

    The rewrite is also what the confidentiality guard is re-applied to. A message
    that reads as harmless on its own — "and his bonus?" — can be rewritten into a
    clean-looking question about a person, and a guard that only ever saw the
    original wording would refuse the obvious case and miss the rewritten one.

    An expansion has no query worth retrieving: it names no subject, and what it
    wants is more of the passages the previous answer was drawn from. So its query
    is the message as sent, and it never reaches the retrieval path at all.
    """

    category: Category
    query: str


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


# Asking for more of what has just been answered, with no subject of its own.
# Exactly matching and length-bounded, for the same reason the conversational set
# is: "what else" on its own is an expansion, while "what else does the leave
# policy say?" is a new question about a named document and must not be captured
# by it.
EXPANSION_PHRASES = {
    "anything else",
    "anything else?",
    "anything else please",
    "anything else i should know",
    "anything else i need to know",
    "anything else worth knowing",
    "what else",
    "what else?",
    "what else is there",
    "what else do you know",
    "what else does it say",
    "what else does that say",
    "what else then",
    "tell me more",
    "tell me more about that",
    "tell me more please",
    "say more",
    "go on",
    "go on then",
    "continue",
    "more",
    "more please",
    "more, please",
    "and",
    "and?",
    "so what else",
    "is there anything else",
    "is there more",
}


def is_expansion(text: str) -> bool:
    """Whether this asks for more of the answer just given, naming no new topic.

    The fast path only. "Anything else should I know about contractors?" is also an
    expansion to a person reading it, and reaches the classifier, which sees the
    conversation and can tell the difference.
    """
    cleaned = normalise(text)

    if not cleaned or len(cleaned) > MAX_CONVERSATIONAL_LENGTH:
        return False

    return cleaned in EXPANSION_PHRASES


def classify_by_rules(message: str) -> Category | None:
    """The category these rules decide on their own, or None to ask the model.

    The confidentiality guard is checked first because it is a refusal on grounds
    of what the data is, and it has to win over any reading of the message's shape
    — "thanks, but what is my leave balance?" is a restricted request.

    An expansion is returned here too, and the caller downgrades it to a follow-up
    when there is no previous answer to continue from: "anything else?" as the
    first message of a conversation has nothing to expand, and retrieving it as
    written would find nothing in any document.
    """
    if is_restricted_request(message):
        return Category.RESTRICTED

    if is_obvious_conversational(message):
        return Category.CONVERSATIONAL

    if is_expansion(message):
        return Category.EXPANSION

    return None


# What the model is asked for, and the words it answers with. Kept here rather
# than in the engine so the whole decision — patterns, categories, prompt and
# parsing — is one readable unit, and so the classification can be tested without
# a client, a key or a network.
CLASSIFIER_SYSTEM_PROMPT = """You route messages for an internal knowledge \
assistant that answers questions about one company's policies, processes and \
workplace rules.

Reply with one line and nothing else, in exactly this form:
CATEGORY: <one of the six below>
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
- FOLLOW_UP — an in-scope request that shifts or narrows the topic of the turns \
before it ("what about for contractors?", "and if I'm part-time?", "does that \
apply to me too?"). It is in scope, but it cannot be retrieved as written because \
the words in it name no document.
- EXPANSION — an in-scope request for more of what has already been answered, \
naming no new topic ("anything else?", "what else?", "tell me more", "go on", \
"anything else I should know?"). The difference from FOLLOW_UP is the subject: a \
follow-up brings a new subject, an expansion brings none, so it is continued from \
the passages the last answer was drawn from rather than searched for.
- OUT_OF_SCOPE — a real request for information or help that has nothing to do \
with the company: general knowledge, current events, weather, other \
organisations, personal favours. Not a follow-up to something in scope.
- RESTRICTED — a request for private information about a specific individual, \
whether the asker or somebody else: salary, pay, bonus, payslip or any other \
figure about compensation; performance reviews, ratings or improvement plans; \
disciplinary, grievance or investigation records; health, the reason for leave, \
or personal and family circumstances; an individual's contact details where they \
are not an official company contact; termination or redundancy status. Also \
RESTRICTED when a follow-up carries a restricted question forward ("and his \
bonus?" after a refusal about someone's salary).

RESTRICTED is about a person's private data, never about the company's rules. \
Questions about how the rules work are COMPANY_QUESTION and must not be \
RESTRICTED, including when they contain the same words: "how is salary \
determined", "when is salary paid", "can I receive my salary before the due \
date", "what are the leave entitlements", "how do I request a salary review" and \
"what does the compensation policy cover" are all ordinary policy questions.

Judge by intent, never by punctuation or by topic. No question mark does not mean \
there is no question, and a question mark does not mean there is a company \
question. OUT_OF_SCOPE requires an actual request: a message that asks for \
nothing can never be OUT_OF_SCOPE.

QUESTION is the message as a complete, standalone question, with any reference to \
the conversation replaced by what it refers to. For COMPANY_QUESTION it is the \
message itself, lightly cleaned. For FOLLOW_UP it must name the topic in the words \
the conversation used, so "what about contractors?" after a question about the \
Code of Conduct becomes "What does the Code of Conduct say about contractors?"; \
do not invent a document title, because retrieval has nothing to match one \
against. For EXPANSION, OUT_OF_SCOPE, RESTRICTED and CONVERSATIONAL, repeat the \
message unchanged."""


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
        "expansion",
        "out_of_scope",
        "restricted",
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

    The same reasoning decides what a rewrite is allowed to do. An expansion is
    read as one whatever the model wrote, because it is continued from the previous
    answer's own passages rather than searched for, and a rewrite could only make
    it worse.
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

    if verdict.category == Category.EXPANSION.value:
        # Nothing to rewrite. An expansion asks for more of what was answered, and
        # its own words are the whole of what it has to say.
        return Classification(Category.EXPANSION, message)

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