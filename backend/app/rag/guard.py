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

import difflib
import re
from collections.abc import Sequence
from dataclasses import dataclass
from enum import Enum
from typing import Literal

from pydantic import BaseModel, ConfigDict, ValidationError

# A word, as these rules read one: letters and digits, nothing else. Case is kept,
# because capitalisation is evidence in both directions here — an acronym exempts a
# message and a name in the middle of one does the same.
#
# An apostrophe is a boundary: "what's" is two words and one letter, not one word
# that is in neither dictionary.
_WORD = re.compile(r"[a-zA-Z0-9]+")

# Emoji, and the skin-tone and joiner sequences that hang off them. Broad on
# purpose: a run of emoji is a laugh, and a miss here reads as "no emoji" and sends
# an emoji-only message to the spelling check instead.
EMOJI_RUN = re.compile(
    "["
    "\U0001f000-\U0001faff"
    "☀-➿"
    "⬀-⯿"
    "️"
    "‍"
    "]+"
)


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

    `elaboration` is the flag that splits the continuation reader in two. It carries
    no new category — an elaboration is still an expansion as far as the wire is
    concerned, and still produces `kind=answer` — but it is read differently: the
    subject is the previous answer's subject, so the passages that answer already
    quoted are included rather than held back. Set by rule, never by the classifier:
    see `is_elaboration`.
    """

    category: Category
    query: str
    elaboration: bool = False


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

# The greetings themselves, as a set apart from the rest of the conversational
# vocabulary.
#
# Split out because a conversation whose first message is a greeting is *named*
# differently from one whose first message is a thank-you or a laugh, and both are
# answered the same way. "thanks" and "hey" are the same kind of turn and not the
# same kind of conversation to look at in a list a week later.
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
    "morning",
    "afternoon",
    "evening",
}

# Laughter, and the reactions typed as one.
#
# Kept apart from `CONVERSATIONAL_WORDS` because of *where* it is checked. Laughter
# is spelled with the same few letters over and over — "hhhhh", "hahaha", "lolvl",
# "kkk" — which is exactly what the unintelligible rule looks for, so a laugh that
# reached it would be told it could not be understood. It is therefore recognised
# first, and recognised for what it is: somebody finding something funny, or
# pressing a key repeatedly, neither of which is a question about the documents.
#
# Deliberately generous about how it is spelled and never about what follows it:
# "hahaha" is a laugh, "haha so what is the leave policy" is a question that
# happens to open with one.
LAUGHTER_WORDS = {
    "haha",
    "hahaha",
    "hahahaha",
    "hehe",
    "heh",
    "lol",
    "lmao",
    "rofl",
    "hah",
    "hihi",
    "hihihi",
    "hmmmm",
    "hm",
    "lolll",
    "hahahaha",
    "hhhh",
    "hhhhh",
    "hhhhhh",
    "kkk",
    "kkkk",
    "kkkkk",
}

# Laughter that is a letter rather than a word, so only the run itself is checked.
#
# Two of a kind is enough here, because `normalise` folds a longer run down to two
# before this ever sees it: "hhhhh" reaches this as "hh". The gibberish check wants
# the stricter shape and has its own pattern for it.
LAUGHTER_RUN = re.compile(r"^(.)\1+$")

# One key held down: four of the same letter, which is never a word and never a
# laugh either — it is what a hand on the keyboard produces.
HELD_KEY_RUN = re.compile(r"^(.)\1{3,}$")

# Upper bound on a normalised message, so a sentence never qualifies on a word
# inside it. "hello, what is the leave policy?" is a question, and answering it
# with a greeting would be refusing to do the actual job.
MAX_CONVERSATIONAL_LENGTH = 32

# The same bound for a message that only makes sense against earlier turns. Long
# enough for "anything else I should know?" and for "what about contractors?",
# short enough that a real question which happens to mention a topic — "what about
# parental leave and how do I claim it during maternity?" — is left alone.
MAX_CONTEXT_DEPENDENT_LENGTH = 32

# How long a run of one letter has to be before it stops being a laugh and starts
# being a keyboard held down. Four is the shortest run that is never English.
MAX_REPEATED_LETTERS = 4

# Consonants in a row without a vowel breaking them. Four is long enough that no
# ordinary word has it and short enough to catch a burst keyboard.
MAX_CONSONANT_CLUSTER = 4

# Letters long enough for "has no vowel at all" to be evidence. "hmm" is two and is
# a word anyway; "vdghj" is five and is a hand on the keyboard.
MIN_VOWELLESS_LENGTH = 5

# The keyboard rows, in the order the keys sit. A run of four from the middle of a
# row is nobody typing: "asdf", "qwer", "hjkl" and their neighbours are what a hand
# lands on when it lands on the keyboard instead of on the keys it meant.
_KEYBOARD_ROWS = ("qwertyuiop", "asdfghjkl", "zxcvbnm")

# The vowels, and the letter `y`, which stands in for one often enough that
# excluding it invents noise.
VOWELS = frozenset("aeiouy")

# Casual English, Ghanaian English and pidgin, which are ordinary words here and
# which no standard dictionary carries.
#
# Their absence from the word list would otherwise be read as gibberish, which is
# the one thing this check must never do to somebody writing in the language they
# were taught at home: "chale, how do I set up the VPN?" is a question, and a
# question deserves an answer however it is phrased.
CASUAL_WORDS = frozenset(
    """
    abeg abegs abrasive abusua accent accents ache achike adafo adeyemi afa
    agbo ajo akwa ama ankara ase asiawo aye baako baale baze been there better
    beta but haha chale chale check checka chop chops dan dey doo ebe ee fi
    finally fit fok fokusi fre naija naa nope nth oga oge oh okay omo ope
    owo oyaw ori oyin pitch please proper proper Ghana ghanaian pidgin english
    wassup wetted wetin whats whatyeah yawa yawa yawa naa abeg abeg guy
    guys something someone anything someone people person place
    """.split()
)

# Everyday English, kept small on purpose.
#
# This list does one job: it decides that a message *is* English. It never decides
# that a message is a question, and it never needs to be complete — one familiar
# word in a message is enough to spare it, and any real question contains several.
# The vocabulary of the indexed documents is added to it at runtime, so a word the
# company actually uses is recognised even when it is not common English.
#
# What is deliberately not here is any word only a name would be. People are named
# in messages, and a name that no dictionary carries is a person rather than a
# mistyped word.
COMMON_WORDS = frozenset(
    """
    about above access according account across act action activity actual add
    addition address administration advance advice affect after afternoon again
    against age agency agenda agree ahead air all allow almost alone along already
    also always among amount an and another answer any anyone anything apart
    appeal appear apply application approach approve approval april are area
    argument around arrange arrival as ask aspect assessment assistance
    associate association at attend attendance attitude attribute audience
    author authority available avoid away back bad bank base basis be beam
    because become bed before begin beginning behalf behaviour behind being
    believe below benefit benefits beside best better between beyond big bill
    birthday board body bonus book both bottom break bring budget build
    business but buy by call camera can cancel candidate capacity capital
    car card care career carry case cash casual category cause cell centre
    certain chair challenge chance change charge check child choice choose
    circumstance claim class clean clear client clock close club code coffee
    cold collection college colour come commercial commission committee common
    communication company compare complete computer condition conduct conference
    confirm consider console contact contain content context continue contract
    control convention conversation copy cost could count country couple course
    cover create credit crime cultural culture cup current custom customer cut
    daily damage dance danger data date day deal dear death decide decision
    deep default define degree deliver demand department depend describe design
    desk detail develop development device die difference different difficult
    dinner direct direction director discuss discussion display distance
    distribution do doctor document documentation does door down download draft
    draw drive drop drug during duty each early earn earth east easy eat
    economic economy edge edit education effect effort either elect election
    else email employee employer employment end energy engine engineer english
    enjoy enough enter enterprise environment equal equipment error especially
    essay essential establish estate estimate ethics even evening event ever
    every everybody everyone everything evidence exact example exceed excellent
    except exchange executive exercise exist expect expense experience
    experiment expert explain export express extend extra eye face facility
    fact factor fail fair fall false family far fashion fast father fault
    favour favor fear feature federal fee feed feel female few field fight
    figure file fill film final finance financial find fine finger finish
    fire firm first fiscal fit five fix flag flat flight floor flow flower
    fly focus follow food foot football for force foreign forget form former
    forward four frame free french frequency fresh friend from front fuel full
    fun function fund furniture further future gain game garden gas general
    generate get gift girl give glass global go goal good government grade
    grant graph great green ground group grow growth guard guess guest guide
    gun guy hair half hall hand handle happen happy hard hat have he head
    health hear heart heat heavy height hello help hence her here herself hi
    high him himself his history hit hold holiday home hope horse hospital
    hot hotel hour house how however huge human hundred hurt husband i ice idea
    identity if image imagine impact implement import important improve in
    include increase indeed independent index individual industry inform
    information initial injury inside install institution instruction insurance
    intend interest internal international interview into introduce investment
    invite involve iron is issue it item its itself job join joint journey
    judge jump just keep key kick kid kill kind king kitchen knee knew know
    knowledge labour labor lack lady lake land language large last late later
    laugh law lawyer lay layer lead leader learn least leave left leg legal
    length less lesson let letter level library licence license lie life lift
    light like limit line link lip list listen little live loan local location
    lock log long look lose loss lost lot loud love low luck lunch machine
    magazine mail main maintain major make male man manage manager manner many
    map march mark market marriage material matter may maybe me mean measure
    meat mechanism media medical medium meet meeting member memory mention menu
    message metal method middle might mile milk million mind mine minute miss
    mission mistake mix mobile model modern moment money monitor month moral
    more morning most mother motion motor mountain mouse mouth move movement
    movie much music must my myself name narrow nation national natural nature
    near necessary neck need negative neighbour neighbour net network never new
    news newspaper next nice night nine no node noise none nor normal north
    nose not note nothing notice now number object objective obligation observe
    obtain occasion occur ocean of off offer office officer official often oil
    ok okay old on once one online only open operate operation opinion
    opportunity option or orange order ordinary organisation organization
    other others our out outcome outside over own owner pack package page pain
    paint pair paper parent park part particular partner party pass password
    past path patient pattern pay payment peace peak pen people per percent
    perfect perform performance perhaps period permanent permission person
    personal phone photograph phrase physical pick picture piece place plan
    planning plant plastic plate play player please point police policy
    political politics poor popular population port position positive
    possible post pound power practice prefer premium prepare present
    president press pressure pretty prevent previous price primary prime
    principle print prior private prize probably problem procedure process
    produce product production profession professional professor profit
    programme program project property propose protect protocol prove provide
    public publish pull purchase purpose push put quality quarter question
    quick quickly quiet quite quote race radio rain raise range rate rather
    reach read ready real realise realize reason receive recent recognise
    recognize recommend record recover red reduce refer reflect refuse regard
    region register regular regulation relate relationship release relevant
    reliable relief religion rely remain remember remind remote remove
    rent repair repeat replace reply report represent request require research
    reserve resident resolve resource respect respond response responsible
    restaurant result retain retire return reveal revenue review reward rich
    right ring rise risk river road role roll room root round route routine
    row rule run safe safety sail salary sale same sample save say scale
    scene schedule scheme school science score screen script search season
    seat second secret section sector security see seek seem sell send sense
    sentence separate series serious serve service session set settle seven
    several shall shape share sharp she sheet shelf ship shoot short should
    shoulder show side sign signal significant silence similar simple simply
    since sing single sister sit site situation six size skill skin sleep
    slide slow small so social society soft software solution some somebody
    someone something sometimes son song soon sorry sort sound source south
    space speak special specific speech speed spend spirit spot spread staff
    stage stand standard star start state statement station status stay step
    still stock stop store story straight strange strategy street strength
    strong structure student study stuff style subject submit substance succeed
    success such sudden suffer suggest suit summer sun supply support suppose
    sure surface system table take talk tall task tax teach team technical
    technique technology telephone television tell temperature ten term terms
    test text than thank that the their them themselves then theory there
    these they thing think third this those though thought thousand threat
    three through throw thus time today together tomorrow tone tonight too
    tool top total touch tour tourist toward town trade traditional traffic
    train transfer transport travel treat treatment tree trial trip trouble
    truck true trust truth try turn twelve twenty twice two type typical under
    understand union unit university unless until up update upon upper use
    useful usual usually value various very view village visit voice volume
    vote wage wait wake walk wall want war warm warn wash waste watch water
    way we wear weather wedding week weekend welcome well west what whatever
    when where whether which while white who whole whom whose why wide wife
    will win wind window wine wing winter wire wise wish with within without
    woman wonder wood word work worker world worry worth would write writer
    wrong yard yeah year yellow yes yesterday yet you young your yourself zero
    zone
    """.split()
)


def is_greeting(text: str) -> bool:
    """Whether this message opens a conversation rather than continuing one.

    Greetings are conversational like any other pleasantry, and are named apart
    from them: a conversation that began with "Hey" is recognisable in the list as
    one somebody opened rather than one somebody used, and it keeps that name for
    good because a conversation is named once and never renamed.
    """
    cleaned = normalise(text)

    if not cleaned:
        return False

    if cleaned in GREETING_WORDS:
        return True

    head, _, tail = cleaned.rpartition(" ")

    return bool(tail) and head in GREETING_WORDS and tail in CONVERSATIONAL_ADDRESSEES


def is_laughter(text: str) -> bool:
    """Whether this message is a laugh, an emoji, or a key held down.

    Recognised before anything else that could mistake one for nonsense, and never
    reaching retrieval or the model: a laugh is not a request, and answering it as
    an unrecognised message would be telling somebody the assistant could not read
    their own laugh.
    """
    cleaned = normalise(text)

    if not cleaned or len(cleaned) > MAX_CONVERSATIONAL_LENGTH:
        return False

    if cleaned in LAUGHTER_WORDS:
        return True

    # One character repeated and nothing else: "hhhhh", "kkkk", "jjjjj". Any other
    # word in the message means it is a message that happens to contain one.
    if LAUGHTER_RUN.match(cleaned):
        return True

    # Emoji on their own, or a word wrapped in them. This is the only place a
    # message is reduced to its emoji before anything else reads it.
    without_emoji = EMOJI_RUN.sub("", cleaned)

    if without_emoji != cleaned and normalise(without_emoji) in LAUGHTER_WORDS | {""}:
        return True

    return False


# How much of a message has to be made of tokens no word list carries before the
# message is called a keyboard accident.
#
# A ratio rather than a count, and the reason is the defect this replaced: "heyjffdk
# hdj this" carries a real word, and any rule of the form "a familiar word exempts
# the message" read that as a message worth answering. It got a generated reply, so
# the *next* gibberish message in the conversation was answered as though it were
# the first one — the streak never started, and a reader whose keyboard was broken
# got the shrug-and-try-again reply twice in a row instead of the examples.
#
# Sixty per cent is the majority, and the direction of the error is the whole choice:
# a real question contains several ordinary words, so it clears the bar comfortably
# ("what does the leave policy say" is one unknown of four), while anything typed by
# accident is nearly all unknown by construction. A message that sits near the line is
# left to the classifier, which can see the conversation this counting cannot.
MAJORITY_NON_WORD = 0.6


def is_unintelligible(text: str, vocabulary: frozenset[str] = frozenset()) -> bool:
    """Whether this message is a keyboard accident rather than a message.

    The wrong answer is expensive in both directions and the two are not equal:
    calling gibberish unintelligible costs somebody one more try, while calling a
    real question unintelligible refuses to answer a question the documents hold.
    So this says yes only when it is sure, and every exemption below exists to
    make "sure" mean sure. Anything it is not sure about is left to the classifier,
    which can see the conversation this one-word reading cannot.

    Laughter is checked by the caller before this, because a laugh is a run of
    letters too and is not unintelligible.

    `vocabulary` is the indexed documents' own vocabulary, added to the built-in
    one: a word the company actually uses is a real word even when no dictionary
    carries it.
    """
    tokens = _WORD.findall(text)

    if not tokens:
        return False

    known = COMMON_WORDS | CASUAL_WORDS | vocabulary

    # An acronym, a figure or a capitalised name anywhere in the message exempts the
    # whole of it. "SSO login" is a person asking about single sign-on, and reading
    # it as gibberish because two of its three words are not in a dictionary would
    # refuse a question the documents answer. Read with the capitalisation the
    # message was sent with, which is the whole of the evidence.
    if any(_is_exempt(token) for token in tokens):
        return False

    # A capitalised word in the middle of a sentence is a name, and people are
    # named in messages. A sentence's own first word is not evidence of anything,
    # which is why it does not count here.
    if _names_a_person(text):
        return False

    # One word, so there is nothing to weigh it against. "grievance" is in no word
    # list this check knows, and a majority reading of a single word says nothing:
    # it is 100% unknown whatever it is. A lone word is judged by its shape instead,
    # which is what asks the question a spelling check can actually answer.
    if len(tokens) == 1:
        return _is_nonsense(tokens[0].lower())

    unknown = sum(1 for token in tokens if token.lower() not in known)

    # The majority rule, and nothing else. A message that is mostly words this code
    # cannot read is left to the classifier, which can see the conversation this
    # counting cannot: "whats the leav policy" is a question with two typos in it,
    # and answering it with "did your keyboard slip?" would be refusing to answer a
    # question the documents hold.
    #
    # The shape test is deliberately not applied as well. It fires on ordinary words
    # with awkward spelling — "approves" and "period" both read as a keyboard run to
    # it — and while no-token-is-known used to hold it back, a majority rule that
    # lets one real word through must not reintroduce it on that basis.
    return unknown / len(tokens) >= MAJORITY_NON_WORD


def _is_exempt(token: str) -> bool:
    """Whether this token could not be gibberish on its own.

    Two letters, digits, and anything written in capitals. "VPN", "2FA" and "18"
    are not words, and treating them as unreadable would refuse the questions that
    use them — which are the questions this assistant exists to answer.
    """
    if len(token) < 3:
        return True

    if token.isdigit():
        return True

    return token.isupper()


def _names_a_person(text: str) -> bool:
    """Whether the message contains a capitalised word that is not its first.

    A name is not a dictionary word and never will be, so a message carrying one is
    addressed to a person rather than mistyped. Only capitalisation inside the
    sentence counts: "Asdfgh" at the start is a hand on the keyboard, and "Kofi
    Mensah" in the middle of one is not.
    """
    _, _, tail = text.strip().partition(" ")

    return any(word[:1].isupper() for word in tail.split())


def _is_nonsense(token: str) -> bool:
    """Whether this token is the shape of a keyboard accident.

    Four signals, all of them about how the letters sit rather than what they
    spell: no vowel in a long word, a run along a keyboard row, a cluster of
    consonants, and one letter held down.
    """
    if len(token) >= MIN_VOWELLESS_LENGTH and not set(token) & VOWELS:
        return True

    if any(_keyboard_run(row, token) for row in _KEYBOARD_ROWS):
        return True

    if _consonant_cluster(token) >= MAX_CONSONANT_CLUSTER:
        return True

    if HELD_KEY_RUN.match(token) and len(token) >= MAX_REPEATED_LETTERS:
        return True

    return False


def _keyboard_run(row: str, token: str) -> bool:
    """Whether the token contains four keys from the same physical row."""
    run = 0

    for character in token:
        run = run + 1 if character in row else 0

        if run >= 4:
            return True

    return False


def _consonant_cluster(token: str) -> int:
    """The longest run of consonants in the token."""
    longest = 0
    run = 0

    for character in token:
        run = 0 if character in VOWELS else run + 1
        longest = max(longest, run)

    return longest


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

    # Laughter, before the obvious check finishes and long before the gibberish
    # check: "hhhhh" is a run of letters that no word list knows, and reading it as
    # a keyboard accident would answer a laugh with "did your keyboard slip?".
    if is_laughter(text):
        return True

    head, _, tail = cleaned.rpartition(" ")

    return bool(tail) and head in CONVERSATIONAL_WORDS and tail in CONVERSATIONAL_ADDRESSEES


def asks_about_capabilities(text: str) -> bool:
    """Whether this message is a question about what the assistant is and does.

    Superseded by `is_meta_question`, which covers this and the abilities the
    description does not mention. Kept because it is the narrow, exact reading the
    title logic and the tests use, and narrowing is what that logic wants: a thread
    opened by "what can you do?" is small talk, while "what can you do about my
    payslip?" is a refusal and must not be caught by it.
    """
    return normalise(text) in CAPABILITY_QUESTIONS


# =============================================================================
# Questions about the assistant itself
# =============================================================================
# A question the reader is asking *us* rather than the documents. The defect these
# rules exist to close is a reader asking "do you understand Chinese?" and being told
# "I'm happy to help with any questions you have. Just let me know what you need":
# a direct question answered with an invitation to ask one.
#
# The failure has two halves and both are fixed here rather than in the prompt. The
# description of the assistant did not mention languages, so a question about them
# matched nothing and fell through to the conversational path, which has no facts and
# can only improvise; and the conversational path is explicitly barred from stating
# facts about the assistant, so improvising was all it could do. Naming the
# question here routes it to an approved answer instead of to improvisation.
#
# Matched as patterns over the whole message rather than as a set of exact strings,
# because the same question is asked a dozen ways and a list of exact phrasings
# catches only the ones somebody thought of. Every pattern is anchored on something
# the question cannot avoid: it must be addressed *to* the assistant, or be about the
# conversation with it.
#
# The hard part is not catching the questions but not catching the policies, and both
# halves are narrow on purpose. A bare `\blanguages?\b` would claim "what does the
# Code of Conduct say about languages at work?", which is a real question with an
# answer in the corpus; `what is this` has to be the whole of a short message, or it
# claims "what is this policy about?". When a pattern cannot be made safe, the entry
# is left to the model picker instead of to a rule — which still answers it, and does
# so from the same closed table.

# A phrase that names the assistant. Second person, because every one of these
# questions is addressed to somebody.
_ASSISTANT = r"(?:you|u|your|assistant|bot)"

META_PATTERNS = [
    # Identity and abilities.
    r"\bwho\s+(?:are|r)\s+(?:you|u)\b",
    r"\bwhat\s+(?:are|is)\s+(?:you|u)\b",
    r"\bwhat\s+(?:can|do|will|would)\s+(?:you|u)\b",
    r"\bwhat\s+(?:can|do|will|would)\s+(?:the\s+)?(?:assistant|bot|chatbot)\b",
    r"\bintroduce\s+yoursel(?:f|ves)\b",
    r"\bwhat\s+(?:do|can)\s+you\s+know\b",
    r"\bwhat\s+are\s+you\s+(?:for|here\s+for)\b",
    r"\b(?:are|you)\s+(?:you\s+)?(?:an?\s+)?(?:ai|robot|bot|chatbot|human)\b",
    # "what is this" only as the whole of a short message. Elsewhere "what is this
    # policy about?" is a question about a document.
    r"^what(?:'s| is) this\s*[?.!]*$",
    # Languages. The whole reason this exists.
    r"\b(?:do|can|could|will|would)\s+(?:you|u)\s+(?:speak|talk|read|write|understand|"
    r"reply|respond|answer|translate)\b",
    r"\b(?:what|which)\s+language",
    # A language named in a message that also addresses us. Naming a language alone
    # is a policy question far more often than it is a question about us.
    r"\b(?:you|u|your)\b[^.?!]*\bin\s+(?:chinese|french|spanish|german|portuguese|italian|"
    r"dutch|arabic|russian|japanese|hindi|twi|pidgin|english|korean|swahili|yoruba|"
    r"igbo|hausa|amharic|thai|vietnamese|tagalog)\b",
    r"\b(?:in|into)\s+(?:another|other|a\s+different)\s+language\b",
    r"\bother\s+languages?\b",
    r"\blanguage\s+support\b",
    # Memory across conversations.
    r"\b(?:do|can|will|would)\s+(?:you|u)\s+(?:remember|recall)\b",
    r"\b(?:do|can|will)\s+(?:you|u)\s+(?:know|recognise|recognize)\s+me\b",
    r"\b(?:have|had)\s+(?:we|i)\s+(?:spoken|talked|met|chatted)\b",
    r"\b(?:in|during|from)\s+(?:our|the|my|last)\s+(?:last|previous)\s+"
    r"(?:conversation|chat|thread|time)\b",
    r"\b(?:do|does)\s+(?:you|u|this|the\s+assistant)\s+(?:keep|save|store|log|retain)\b",
    # Privacy, retention and sharing.
    r"\b(?:is|are)\s+(?:this|my|our|it)\s+(?:private|confidential|secure|safe|encrypted|anonymous)\b",
    r"\b(?:who|what)\s+can\s+(?:see|read|access|view)\b",
    r"\b(?:do|does)\s+(?:you|u)\s+(?:share|send|store|keep|log|report)\b",
    r"\bwhere\s+(?:is|are)\s+(?:my|our|this)\s+(?:data|messages?|question|conversation|chat)\b",
    r"\bhow\s+long\s+(?:do\s+(?:you|u)|will\s+(?:you|u)|is\s+(?:this|it))\s+"
    r"(?:keep|store|retain|hold|save)\b",
    r"\b(?:are|is)\s+(?:my|our)\s+(?:messages?|data|chats?|questions?|conversations?)\s+"
    r"(?:saved|stored|logged|kept|private|secure)\b",
    # Accuracy and confidence.
    r"\bhow\s+(?:accurate|reliable)\s+are\s+(?:you|u)\b",
    r"\bhow\s+(?:confident|sure|certain)\s+are\s+(?:you|u)\b",
    r"\b(?:do|can|would)\s+(?:you|u)\s+(?:make\s+(?:things|stuff|it)\s+up|hallucinate|guess)\b",
    # What the assistant cannot do.
    r"\bwhat\s+(?:can'?t|cannot|can\s+not|won't|will\s+not)\s+(?:you|u)\b",
    r"\b(?:can|do)\s+(?:you|u)\s+(?:access|reach|browse|look\s+up|search)\s+"
    r"(?:the\s+)?(?:internet|web|outside)\b",
    r"\b(?:do|can)\s+(?:you|u)\s+(?:have\s+(?:internet|web\s+access)|browse)\b",
    r"\byour\s+(?:limits|limitations|capabilities|abilities)\b",
]

# A tuple, like `_KEYBOARD_ROWS` and `_SCRIPT_RE` below: a module-level table of
# fixed patterns, holding nothing that any conversation wrote.
_META_RE = tuple(re.compile(pattern, re.I) for pattern in META_PATTERNS)

# A question about the assistant, as opposed to one that merely mentions a word from
# the same family. The bound is what stops a real company question from being caught
# by a trigger: "what does the Code of Conduct say about languages at work?" is a
# policy question and is longer than this, so it is left alone and retrieved.
MAX_META_LENGTH = 80


def is_meta_question(text: str) -> bool:
    """Whether this message is a question about the assistant rather than the documents.

    Decided before the classifier and without a model call, because the answer to it
    does not depend on the conversation and must not depend on the model being
    reachable: a reader asking "do you speak French?" at the same moment as an outage
    still deserves an honest answer rather than an error.
    """
    cleaned = normalise(text)

    if not cleaned or len(cleaned) > MAX_META_LENGTH:
        return False

    # A question mark is what makes these questions rather than remarks, and every
    # pattern above was written to stand on its own without it so that "do you speak
    # french." and a bare "languages?" are caught too.
    return any(pattern.search(cleaned) for pattern in _META_RE)


# The scripts a message can arrive in, and the language each is named by when the
# assistant has to refer to it. Cyrillic is deliberately not called Russian: it is
# not, and the correction reads better naming the script than guessing a language
# from it.
SCRIPT_RANGES = (
    ("Han", r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]"),
    ("Arabic", r"[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]"),
    ("Cyrillic", r"[\u0400-\u04ff]"),
)

# A tuple, not a generator: `dominant_script` walks this on every message, and a
# generator is exhausted by the first walk — which silently reduced the whole
# function to "is this Han?" for every caller after the first.
_SCRIPT_RE = tuple(
    (name, re.compile(pattern)) for name, pattern in SCRIPT_RANGES
)

# How much of a message has to be in one non-Latin script before the message is
# treated as being written in that script rather than as a Latin sentence with a
# quotation in it. Sixty per cent is deliberately a majority rather than a couple of
# characters: "my password is 密码" is an English message that happens to contain
# something else, and treating it as Chinese would answer the wrong question.
MAJORITY_SCRIPT = 0.6


def dominant_script(text: str) -> str | None:
    """The script most of this message is written in, or None for Latin and below.

    Counts characters rather than words, because a script that a Latin keyboard cannot
    produce arrives as runs of characters and a single word of it is enough to be
    visible. Returns the script's name rather than a language, because the two are
    not the same thing and only the name is defensible.
    """
    letters = [character for character in text if character.isalpha()]

    if not letters:
        return None

    total = len(letters)

    for name, pattern in _SCRIPT_RE:
        if len(pattern.findall(text)) / total >= MAJORITY_SCRIPT:
            return name

    return None


def is_latin_script(text: str) -> bool:
    """Whether this message is readable as ordinary Latin-alphabet text.

    The other half of the script correction: the claim being checked is about the
    *previous* message, and it can only be believed if that message really was Latin
    letters in the first place. A reader who says "that was Chinese" about a message
    that arrived as Chinese characters has not mis-typed anything and must not be
    told it arrived as random letters.
    """
    return not dominant_script(text)


# Asking the assistant to see a language in what it received, which is the shape a
# transmission failure takes: "that is chinese", "was that arabic?", "I wrote that in
# Japanese". The captured word is the language name, used verbatim in the correction.
#
# The verb is allowed on either side of the demonstrative because both orders are how
# people say it, and "was that arabic?" is exactly as much a correction as "that is
# arabic".
SAID_IT_WAS_LANGUAGE_RE = re.compile(
    r"\b(?:that|it|this|the\s+last\s+(?:message|one|question))"
    r"\s+(?:was\s+in|is\s+in|was|is|in)\s+([a-z]+)"
    r"|\b(?:was|is)\s+(?:that|it|this)\s+([a-z]+)\b",
    re.I,
)

# The languages a reader is likely to name. Open-ended on purpose — the correction
# quotes whatever name they used — so this only has to recognise the word as a
# language at all, not to be the complete list of them.
LANGUAGE_WORDS = frozenset(
    """
    chinese mandarin cantonese french spanish german portuguese italian dutch
    arabic russian ukrainian polish czech greek hebrew hindi urdu bengali punjabi
    tamil telugu malayalam kannada marathi gujarati nepali sinhala thai vietnamese
    korean japanese tagalog indonesian malay swahili yoruba igbo hausa twi pidgin
    pidgin english ghanaian amharic somali swedish norwegian danish finnish
    """.split()
)


def claimed_language(text: str) -> str | None:
    """The language a reader says they wrote in, or None if they did not say.

    Read from their own words rather than guessed from the letters in front of us:
    in the case this exists for the letters are the ones that failed to survive, so
    anything inferred from them would be the thing that is already known to be
    wrong.
    """
    match = SAID_IT_WAS_LANGUAGE_RE.search(text)

    if match is None:
        return None

    word = (match.group(1) or match.group(2) or "").lower()

    # Rejected on being an ordinary English word rather than on being absent from a
    # list of languages. "that is good" is not a claim about a language; "that is
    # chineese" is one, misspelled, and a list of correctly spelled names would throw
    # it away — which is the whole failure this exists for. A near-miss on a known
    # language is put right, so the correction quotes a word the reader recognises as
    # their own.
    if len(word) < MIN_LANGUAGE_WORD_LENGTH or not word.isalpha():
        return None

    if word in COMMON_WORDS or word in CASUAL_WORDS:
        return None

    corrected = difflib.get_close_matches(word, LANGUAGE_WORDS, n=1, cutoff=0.8)

    return (corrected[0] if corrected else word).capitalize()


# Short enough to be a word rather than a language name. "that is a" is not a claim
# about anything, and "a" is what the capture reaches there.
MIN_LANGUAGE_WORD_LENGTH = 3


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

    if not cleaned or len(cleaned) > MAX_CONTEXT_DEPENDENT_LENGTH:
        return False

    return cleaned in EXPANSION_PHRASES


# Messages that point at something said earlier rather than naming a subject. Each
# is short, because a long message that mentions a topic is a question about it:
# "what about parental leave and how do I claim it during maternity?" stands on its
# own, and "what about parental leave?" only makes sense against a preceding turn.
#
# "what about" is in here because the phrase is a request to switch subject
# *relative to something*, and in a conversation with nothing in it there is
# nothing to switch from. The length bound is what stops that reading from
# swallowing a real first question about the same subject.
CONTEXT_REFERENCE_PATTERNS = [
    r"\bwhat about\b",
    r"\band about\b",
    r"\bwhat about (?:that|it|this|those|these)\b",
    r"\band (?:for )?(?:part-?time(?:rs)?|contractors|interns|new joiners?|temps?|the same|that|it|them)\b",
    r"\b(?:what|how|why|when|who)\s+(?:about\s+)?(?:that|those|these|it)\b",
    r"\bmore (?:on|about|of)\s+(?:that|it|this|those)\b",
    r"\b(?:same|ditto)\s+(?:for me|question|answer|applies|goes for)\b",
    r"\bwhat else (?:about|on)\s+(?:that|it|this|those)\b",
    r"\b(?:explain|expand on|elaborate on)\s+(?:that|it|this)\b",
    # A bare connective or a question with no subject at all: "and?", "so?",
    # "why?". Written as separate alternatives rather than one pattern of optional
    # parts, because every part being optional matches every word. "ok" is not in
    # this list: it is an acknowledgement, which asks for nothing rather than for
    # more, and answering one with "there is no earlier chat to build on" would be
    # answering a question nobody asked.
    r"^(?:and|so|but|then|next)\s*[?.!]*$",
    r"^(?:and|so|but|then|next)\s+(?:why|how|when|where|who|what)\s*[?.!]*$",
    r"^(?:why|how|when|where|who)\s*[?.!]*$",
]


def needs_earlier_context(text: str) -> bool:
    """Whether this message only means something against earlier turns.

    Broader than an expansion: a subject switch and a bare "why?" need the
    conversation just as much as "anything else?" does. All three are decided here,
    without a model call, because the answer to "do we have anything to continue?"
    does not depend on what the classifier thinks the message is — and when the
    answer is no, there is nothing to classify.
    """
    cleaned = normalise(text)

    if not cleaned or len(cleaned) > MAX_CONTEXT_DEPENDENT_LENGTH:
        return False

    if cleaned in EXPANSION_PHRASES:
        return True

    return any(re.search(pattern, cleaned, re.I) for pattern in CONTEXT_REFERENCE_PATTERNS)


# =============================================================================
# Elaboration: "tell me about those", not "tell me more"
# =============================================================================
# The two are opposites and they were being treated as one. "Anything else?" names
# no subject and wants what the answer has *not* said; "anything about these
# departments?" names a subject it expects the reader to still be holding — the ten
# departments the previous answer just listed — and wants *more about that same
# subject*. Served as an expansion, the second one is excluded from the very passage
# that holds the answer: the previous answer cited "Departments and their roles" and
# displayed it, so the expansion reader held it back and a two-line answer about two
# of ten departments was the best the corpus could produce.
#
# Detected by rule, before the classifier, because the two shapes are fixed vocabulary
# and the classifier cannot be asked to tell them apart reliably from a single
# message. It sees the conversation, not the words, so it would read "anything about
# these departments" as a topic shift like any other.

# A demonstrative pointing back at what was just said. The list is the closed set of
# English ones; anything else is not English.
DEMONSTRATIVES = frozenset({"these", "those", "that", "them", "they", "it"})

# Openers that ask for more *of* something rather than naming a new subject. "explain
# that" and "tell me about them" both carry the subject themselves.
ELABORATION_OPENERS = (
    "tell me about",
    "explain",
    "elaborate on",
    "expand on",
    "go into",
    "more on",
    "more about",
    "what about",
    "anything about",
    "details on",
    "details about",
    "tell me more about",
    "say more about",
    "more detail on",
    "more details on",
)

# A noun is what follows the demonstrative. Proving a word is a noun is not possible
# without a lexicon, so the shape is used instead: a word of at least three letters
# that is not a question word and not a stopword. "these departments", "those
# policies", "explain that process" all match; "what else does that say" does not,
# because nothing follows "that".
_NOUN_LIKE_MIN = 3

_TRAILING_QUESTION_WORDS = frozenset(
    {"say", "says", "said", "mean", "means", "meant", "happen", "happens", "tell",
     "know", "suppose", "think", "exactly", "more", "else"}
)

STOPWORDISH = frozenset(
    """
    a an the and or but of for to in on at by with from as is are was were be been
    being do does did have has had will would can could should about into over under
    """.split()
)


def _demonstrative_is_followed_by_a_noun(text: str) -> bool:
    """Whether a demonstrative here has a noun after it, which is what makes it a subject.

    "about these departments" is a subject. "about these" is a subject the reader
    expects us to have. "what else does that say" has a demonstrative and nothing
    after it, and is the expansion this path must not capture.
    """
    tokens = re.findall(r"[a-z']+", text.lower())

    for index, token in enumerate(tokens[:-1]):
        if token not in DEMONSTRATIVES:
            continue

        follower = tokens[index + 1]

        if (
            len(follower) >= _NOUN_LIKE_MIN
            and follower.isalpha()
            and follower not in STOPWORDISH
            and follower not in _TRAILING_QUESTION_WORDS
        ):
            return True

    return False


def is_elaboration(text: str) -> bool:
    """Whether this asks for more about the subject the last answer was about.

    Two shapes, and both are decided here rather than by the classifier:

    - an opener that asks about something ("tell me about", "explain", "more on",
      "details about"), which carries the subject itself;
    - a demonstrative with a noun after it ("these departments", "that policy").

    The two are checked in that order and the second is deliberately the stricter: a
    bare demonstrative with nothing after it is an expansion, which is what "what else
    does that say" is, and capturing it here would break a path that works.
    """
    cleaned = normalise(text)

    if not cleaned:
        return False

    # An expansion is one of the two by definition — it names no subject — and the
    # two shapes overlap heavily ("tell me more" is an expansion phrase and an
    # elaboration opener). Resolved in favour of the expansion, which is what the
    # phrase list is for.
    if cleaned in EXPANSION_PHRASES:
        return False

    if any(cleaned.startswith(opener) for opener in ELABORATION_OPENERS):
        return True

    return _demonstrative_is_followed_by_a_noun(cleaned)


def classify_by_rules(message: str) -> Category | None:
    """The category these rules decide on their own, or None to ask the model.

    The confidentiality guard is checked first because it is a refusal on grounds of
    what the data is, and it has to win over any reading of the message's shape
    — "thanks, but what is my leave balance?" is a restricted request.

    A question about the assistant comes next, and is a conversational turn: nothing
    is being asked of the documents. It is here rather than in
    `is_obvious_conversational` because it is a much wider set than that function's
    length bound is willing to hold — "do you remember our chats from last month?" is
    thirty-eight characters and is the question this rule exists for.

    An expansion is returned here too, and the caller downgrades it to a follow-up
    when there is no previous answer to continue from: "anything else?" as the
    first message of a conversation has nothing to expand, and retrieving it as
    written would find nothing in any document.
    """
    if is_restricted_request(message):
        return Category.RESTRICTED

    if is_meta_question(message):
        return Category.CONVERSATIONAL

    # A message written in a script a Latin keyboard cannot produce. Not a question
    # the documents can be asked: they are English, the retrieval is on English, and
    # a question in another script retrieves nothing — which the generator then
    # reports as "the documents do not cover this". Measured on this model, a
    # Chinese question about leave came back as a confident claim that the leave
    # policy was not documented. Answered in English from the languages entry
    # instead, which is true and does not invent a gap in the corpus.
    if dominant_script(message):
        return Category.CONVERSATIONAL

    # A claim about the language of the last message. Not a question about the
    # documents under any reading — "that is chinese" names no policy and "that is
    # arabic" names no department — so it belongs with the conversational turns,
    # where it is answered by saying what happened to the text and what that means
    # for the answer.
    if claimed_language(message):
        return Category.CONVERSATIONAL

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