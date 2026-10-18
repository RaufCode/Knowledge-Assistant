"""What the assistant is, what it covers, and what it will admit to.

This file is the only description of the assistant's own abilities in the codebase,
and three paths read it rather than restate it:

- "who are you?" and "what can you do?" are answered from an approved entry here,
  verbatim, because a generated answer to a question about capabilities is a promise
  nobody checked, and the failure is a feature that does not exist described as
  though it does.
- The prompt for every other conversational reply quotes the same brief, so small
  talk stays inside what this assistant actually does.
- A question about the assistant that no rule recognised is offered to the model as
  a *choice between the entry ids below*. The model picks which entry applies and is
  then given that entry's approved words. It never writes the answer, so it cannot
  invent one — not about privacy, not about retention, not about languages.

That last point is the reason this is a table rather than a paragraph. Every fact the
assistant states about itself is an entry somebody wrote and can check, and the set of
ids the model may choose from is closed. Where a fact is not known, the entry says so
with a `TODO` marker rather than guessing: an honest "I don't know that" is a better
answer to "is this private?" than a reassuring sentence nobody verified.

Nothing here is derived from the index at runtime. The corpus can change without this
file changing, and a description that moved with it would be one more thing that
could describe abilities the documents do not support.
"""

from dataclasses import dataclass

from app.config import settings

ASSISTANT_NAME = "Internal Knowledge Assistant"

COMPANY_NAME = "Acme Technologies"

# What the documents cover, as a person would describe it. Deliberately coarse:
# these are topics to recognise, not a catalogue to quote, and a reply that names
# a document the reader then cannot find is worse than one that names the area.
COVERED_TOPICS = (
    "company policies, processes and workplace rules",
    "onboarding and your first weeks",
    "leave, working hours and benefits",
    "pay, compensation and payroll in general",
    "the code of conduct and workplace behaviour",
    "security, compliance and IT setup",
    "who to contact, including HR",
)


def _topic_list() -> str:
    """`COVERED_TOPICS` as one readable sentence's worth of prose."""
    head, *rest = COVERED_TOPICS

    if not rest:
        return head

    return f"{head}, {', '.join(rest[:-1])} and {rest[-1]}"


# What the assistant says it is, when asked. One paragraph, two sentences of it.
CAPABILITIES_REPLY = (
    f"I'm the {ASSISTANT_NAME} for {COMPANY_NAME}. I answer questions about "
    f"{_topic_list()}, using the company documents and citing where each answer "
    f"came from. If the documents do not cover something I'll say so rather than "
    f"guess, and I don't share individual records such as anyone's salary or "
    f"leave balance."
)

# The same description in the shape the conversational prompt quotes it in.
CAPABILITIES_BRIEF = (
    f"You are the {ASSISTANT_NAME} for {COMPANY_NAME}. You answer questions about "
    f"{_topic_list()}. You answer from the company documents and cite the source "
    f"of each answer. You do not share individual records such as anyone's salary "
    f"or leave balance."
)


# What a conversational reply falls back to when the model cannot be reached. Static
# rather than absent: an outage should not turn "there is no question" into an
# error, and it has to acknowledge what the reader actually said.
#
# Not a substitute for answering a question, and never reached by one — a direct
# question about the assistant is answered from the FAQ above, so this cannot become
# the reply to "do you understand Chinese?".
CONVERSATIONAL_FALLBACK = (
    "Sounds like there is no question just yet. Whenever you're ready, ask me "
    "anything about company policies, onboarding, leave, IT setup and similar "
    "topics."
)


# =============================================================================
# The FAQ
# =============================================================================
# One entry per thing a reader can ask *about the assistant*, each with the id the
# model may name, the phrases that reach it by rule, and the answer that is then
# read out unchanged.
#
# `triggers` are matched as phrases inside the normalised message, not as the whole
# of it, so "so do you remember me between conversations?" is recognised the same as
# "do you remember me". That is the difference between the rules catching the
# question and the reader getting the conversational dodge: a question that is not on
# the list still reaches the model, but the model may only answer from this table, so
# "I'm not sure about that one" is the worst case rather than an invitation to
# improvise.


@dataclass(frozen=True)
class FaqEntry:
    """One approved answer, and what reaches it."""

    id: str
    triggers: tuple[str, ...]
    answer: str
    # What the model is told this entry covers, so it can choose between them without
    # being shown the answer it is not allowed to write.
    subject: str = ""
    # Set where the fact behind this entry is not established. The marker is here and
    # deliberately not in `answer`: it is a note to whoever edits this file, while the
    # answer is read to a person, who is told the honest thing ("I don't know") rather
    # than shown a development marker. An entry may only carry one once the fact is
    # known, and the test suite fails if one is added without a reason.
    todo: str = ""


# Where a fact is not established, this is the marker. It is read back by the suite,
# so an entry cannot quietly lose its honesty and start asserting something nobody
# checked — the failure mode this whole file exists to prevent.
TODO = "TODO"


# -- who it is -----------------------------------------------------------------
IDENTITY = FaqEntry(
    id="identity",
    subject="what the assistant is and what it is for",
    triggers=(
        "who are you",
        "who r u",
        "what are you",
        "what is this",
        "what is this chat",
        "what can you do",
        "what can you help with",
        "what do you do",
        "what are you for",
        "what are you here for",
        "what can i ask you",
        "what can i ask",
        "introduce yourself",
        "tell me about yourself",
    ),
    answer=CAPABILITIES_REPLY,
)

# -- what it covers ------------------------------------------------------------
TOPICS = FaqEntry(
    id="topics",
    subject="which subjects the documents cover",
    triggers=(
        "what topics",
        "what do you cover",
        "what do you know about",
        "what kind of questions",
        "what questions can i ask",
        "what are you able to answer",
        "what can you answer",
        "which documents",
        "what documents do you have",
        "what do you have",
        "where do you get your information",
        "where does the information come from",
        "what information do you have",
        "help",
        "help me",
        "please help",
        "how can you help",
        "can you help",
        "can you help me",
    ),
    answer=(
        f"I answer questions about {_topic_list()}. I answer from the company "
        f"documents and I tell you which ones when I do."
    ),
)

# -- how answers are made ------------------------------------------------------
SOURCES = FaqEntry(
    id="sources",
    subject="how an answer is produced and how it is cited",
    triggers=(
        "how do you work",
        "how does this work",
        "how does that work",
        "how do you do that",
        "how do you answer",
        "how do you produce an answer",
        "how is an answer produced",
        "where does an answer come from",
        "where do answers come from",
        "how do you cite",
        "how do you know this",
        "how do you know that",
        "why should i trust you",
        "where did you get that",
    ),
    answer=(
        f"I answer from {COMPANY_NAME}'s own internal documents — the handbook, "
        f"the policies and the guides uploaded for me. I do not use the internet "
        f"and I do not use anything else. Each answer shows the passages it was "
        f"drawn from, so you can check what I said against the source."
    ),
)

# -- the confidence figure -----------------------------------------------------
CONFIDENCE = FaqEntry(
    id="confidence",
    subject="what the confidence score means",
    triggers=(
        "what does the confidence",
        "confidence score",
        "confidence mean",
        "what is the confidence",
        "how confident",
        "how accurate are you",
        "how reliable are you",
        "are you accurate",
        "do you hallucinate",
        "can you make things up",
        "how accurate",
    ),
    answer=(
        "The confidence figure out of ten is about the documents, not about how "
        "certain I feel. It says how closely the passages I found matched your "
        "question: high means I found something that plainly answers it, low means "
        "the best I could find was a poor match. It is not a measure of whether the "
        "answer is right. The passages behind it are shown so you can judge that "
        "yourself."
    ),
)

# -- what it will not do -------------------------------------------------------
LIMITS = FaqEntry(
    id="limits",
    subject="what the assistant cannot do",
    triggers=(
        "can you access the internet",
        "can you browse",
        "do you have internet",
        "do you search the web",
        "can you search online",
        "what can you not do",
        "what can't you do",
        "what are you unable to do",
        "what can you not help with",
        "what can't you help with",
        "what are your limits",
        "what are your limitations",
        "do you only use",
        "are you limited to",
    ),
    answer=(
        "I read one thing: the company documents uploaded for me. I have no access "
        "to the internet, to live systems, or to anything outside those documents, "
        "so if the answer is not in them I cannot find it and I will tell you so "
        "rather than guess."
    ),
)

# -- personal records ----------------------------------------------------------
# The refusal path already handles "show me my payslip". This entry is for the
# *question about the ability*, which arrives as small talk and would otherwise be
# answered with a dodge or with an invented assurance.
PERSONAL_RECORDS = FaqEntry(
    id="personal_records",
    subject="access to individual records such as payslips and leave balances",
    triggers=(
        "do you have access to",
        "can you see my",
        "can you see my records",
        "can you access my",
        "can you look up my",
        "do you have my",
        "do you know my",
        "can you tell me my",
        "my personal details",
        "my personal record",
        "my personal records",
        "my payslip",
        "my payslips",
        "my leave balance",
        "my salary",
        "individual records",
        "personal records",
        "access to records",
        "privacy",
    ),
    answer=(
        "No. I cannot see anyone's individual records — not leave balances, not "
        "salaries, not payslips, not appraisals — and I will not share one person's "
        "details with another. Your own are on the HR self-service portal on the "
        f"intranet, or contact HR at {settings.hr_contact}."
    ),
)

# -- who to contact ------------------------------------------------------------
CONTACT = FaqEntry(
    id="contact",
    subject="who to contact, including HR",
    triggers=(
        "who do i contact",
        "who should i contact",
        "who can i talk to",
        "who do i talk to",
        "who do i email",
        "who do i call",
        "how do i contact",
        "how do i reach",
        "contact hr",
        "contact details",
        "contact number",
        "phone number",
        "email address",
        "who is hr",
        "where do i go",
        "what do i do if",
    ),
    answer=(
        f"For anything about policies, onboarding, leave, pay or your own records, "
        f"contact HR at {settings.hr_contact}. For IT and VPN problems it is the IT "
        f"Service Desk, and for security incidents there is a 24/7 hotline; both are "
        f"in the HR contact directory document, and I can look that up for you."
    ),
)

# -- languages -----------------------------------------------------------------
# Observed, not assumed. The configured model was asked the same questions in
# Chinese and French and followed them correctly — it identified the subject of
# "公司的请假政策是什么？" and answered a French question accurately against context
# given to it — but the *documents* are English only. A question in another language
# retrieves nothing, and the model's own answer to that was to report that the
# documents did not cover the topic: a confident false not-found produced entirely by
# the language of the question. So what is claimed here is comprehension, and the
# limitation is stated where it bites. No fluency is claimed, because none was
# measured: it was never asked to hold a long exchange in either language.
LANGUAGES = FaqEntry(
    id="languages",
    subject="which languages the assistant can be used in",
    triggers=(
        "do you speak",
        "do you understand",
        "can you speak",
        "can you read",
        "can you understand",
        "can you write",
        "can you reply in",
        "can you answer in",
        "do you work in",
        "what language",
        "which language",
        "languages",
        "in english",
        "in french",
        "in chinese",
        "in spanish",
        "in portuguese",
        "in german",
        "in twi",
        "in pidgin",
        "in arabic",
        "in russian",
        "in japanese",
        "language support",
        "other languages",
        "another language",
    ),
    answer=(
        "I work in English, and the company documents are in English. I can follow "
        "a question written in another language and answer it in English, but I may "
        "not find the right document from a question that is not in English — so for "
        "anything important, ask me in English and I will get it right."
    ),
)

# -- memory across conversations -----------------------------------------------
# TODO: nobody has established what this deployment does with a conversation once it
# is closed. What is known is narrower and is what this says: a reply sees the thread
# it is in, and nothing else.
MEMORY = FaqEntry(
    id="memory",
    subject="whether earlier conversations are remembered",
    triggers=(
        "do you remember me",
        "do you remember",
        "remember our chats",
        "remember our conversation",
        "remember our conversations",
        "remember my name",
        "do you know me",
        "have we spoken",
        "have i spoken",
        "last time we",
        "in our last chat",
        "in the last chat",
        "we spoke before",
        "do you keep notes",
        "do you save",
        "do you store",
    ),
    todo=(
        f"{TODO}: nobody has established what this deployment does with a "
        "conversation once it is closed, or whether anything identifies the reader "
        "across two of them. Replace the sentence below with what is actually true "
        "when that has been checked."
    ),
    answer=(
        "Within one conversation I can see everything we have said, so \"that\" and "
        "\"the one above\" work. I don't know whether anything carries over into a "
        "new conversation — that hasn't been confirmed, and I'd rather tell you "
        "that than guess. Each conversation starts from its own first message."
    ),
)

# -- privacy and retention -----------------------------------------------------
# TODO: no review of retention, visibility or logging has been done for this
# deployment. The honest entry is the unknown one; anything else here would be a
# claim about data handling that nobody has checked, made by the one component whose
# own behaviour cannot be checked from inside it.
PRIVACY = FaqEntry(
    id="privacy",
    subject="whether conversations are private and how long they are kept",
    triggers=(
        "is this private",
        "is my data private",
        "is my question private",
        "is my data safe",
        "is my data secure",
        "is this secure",
        "is this confidential",
        "who can see",
        "who can read",
        "who has access to this",
        "do you share my",
        "do you share this",
        "do you send",
        "where is my data",
        "where do you store",
        "how long do you keep",
        "how long do you store",
        "how long is this kept",
        "do you log",
        "are my messages saved",
        "are my messages stored",
        "is this encrypted",
    ),
    todo=(
        f"{TODO}: no review of retention, visibility or logging has been done for "
        "this deployment. What is true of the reader's own account is the HR "
        "self-service portal and the contacts in the directory document; what is true "
        "of these conversations is not established, and the answer below must not "
        "claim otherwise until someone has checked."
    ),
    answer=(
        "I can't answer that with confidence. Whether these conversations are "
        "private, who can see them and how long they are kept are things I haven't "
        "been told, and I'm not going to invent an assurance about your data. Treat "
        "a chat here as company confidential and contact "
        f"{settings.hr_email} if that matters for what you write."
    ),
)

ASSISTANT_FAQ: tuple[FaqEntry, ...] = (
    IDENTITY,
    TOPICS,
    SOURCES,
    CONFIDENCE,
    LIMITS,
    PERSONAL_RECORDS,
    CONTACT,
    LANGUAGES,
    MEMORY,
    PRIVACY,
)

# The closed set the model may choose from. Order is the order the entries are
# offered in, and it is the order a human reading them would expect: what it is,
# what it covers, how it answers, then the edges.
FAQ_IDS: tuple[str, ...] = tuple(entry.id for entry in ASSISTANT_FAQ)

_FAQ_BY_ID: dict[str, FaqEntry] = {entry.id: entry for entry in ASSISTANT_FAQ}


def faq_entry(entry_id: str) -> FaqEntry | None:
    """The entry with this id, or None for an id this deployment does not have.

    The lookup a validated model reply goes through, which is what makes the set
    closed: an id that is not in here has no answer to read out, so a model that
    invents one produces the "not sure" reply rather than a fabricated fact.
    """
    return _FAQ_BY_ID.get(entry_id)


def faq_catalogue() -> str:
    """The entries as the model sees them: ids and subjects, never the answers."""
    return "\n".join(f"{entry.id} — {entry.subject}" for entry in ASSISTANT_FAQ)


# A direct question that the rules did not recognise, and which must never be
# answered with "let me know what you need".
#
# This is the reply that replaces a dodge. It says what it does not know, and then
# says what it can do — because a reader who asked a real question and was told "I'm
# not sure about that one" with nothing else has been left with nowhere to go.
NOT_SURE_REPLY = (
    "I'm not sure about that one. I can help with questions about company policies, "
    "onboarding, leave and IT setup."
)


# What a message in another script is answered with, and what a reader who has just
# been told their language did not survive transmission is told first.
#
# The correction exists because the transmission is not in the assistant's control:
# a Chinese sentence typed through a keyboard or a form that only accepts certain
# characters arrives as Latin letters, and answering it as though it were a real
# Latin-alphabet question produces a confident wrong answer. Saying plainly that it
# arrived as random letters is more useful than a wrong answer, and it costs one
# sentence.
ARRIVED_AS_LETTERS = "That came through as random letters rather than {language},"


def script_correction(language: str) -> str:
    """What to say first when the reader's text did not survive transmission.

    `language` is the name *the reader used* — "Chinese" from "that is chinese" —
    rather than one guessed from the letters in front of us, because the guess is
    the thing that is usually wrong here and the reader has just told us.
    """
    return ARRIVED_AS_LETTERS.format(language=language)


# =============================================================================
# Replies that are chosen rather than written
# =============================================================================
# A greeting, a thank-you, an acknowledgement and a laugh are all the same kind of
# turn — a message that asks for nothing — and none of them has anything to be
# answered from. They are answered from the pool below rather than from the model,
# for three reasons that all point the same way:
#
# - It cannot be wrong. A generated reply to "hey" is a fresh set of words each
#   time, and a model asked to be warm will eventually write "let me know if you
#   need anything else", which is a sign-off on a conversation that has not begun.
# - It costs nothing. A greeting is the common case on a first visit, and spending a
#   model call on it puts the round trip in front of the reply for no information.
# - It can be read once and known to be right, which is what makes a suite able to
#   pin it.
#
# Ten in a row rotates through the pool and never says the same thing twice in the
# same breath. None of them is a sign-off and none ends the conversation.

# The one reply that says what the assistant is for, offered once per conversation
# and never again: a reply that repeats its invitation every turn is a sign-off with
# extra steps.
PLEASANTRY_INVITATION = (
    "Hello. Ask me about company policies, onboarding, leave or IT setup whenever "
    "you're ready."
)

# How a later turn in the same conversation is answered: present, brief, and not
# repeating what the first one already said.
#
# `PLEASANTRY_REPLIES[3]` is "Hello there. What would you like to know?" and is the
# closest thing here to a dodge — which is why no direct question is allowed to reach
# this pool at all. `test_a_direct_question_is_never_answered_with_a_dodge` pins that,
# because the pool is the one place in the codebase that can produce the exact reply
# this behaviour was written to eliminate.
PLEASANTRY_REPLIES = (
    "Hi there. Ask me anything about the company whenever you're ready.",
    "Hello. I'm here when you have a question.",
    "Hi. Whenever you're ready, ask me about the policies.",
    "Hello there. What would you like to know?",
    "Hi. Ask me about anything in the company handbook.",
)

# What identifies the invitation in a stored reply, so the next turn can tell it has
# already been made. Part of the message text rather than a separate column, so a
# conversation says this without the backend keeping any state about it.
INVITATION_MARKER = "Ask me about company policies"

# What a message nobody can read is answered with, and why it is not the not-found
# reply: nothing was asked of the documents, so nothing can be said about what they
# cover. Nobody is blamed, and nothing here asks the reader to leave.
UNREADABLE_REPLIES = (
    "I couldn't quite make that out. Did your keyboard slip? Try again whenever "
    "you're ready, I'm here.",
    "That one got past me. Say it another way and I'll take a look.",
)

# The second one in a row says the same thing twice, which is the point: it stops
# trying to be clever and starts being useful. The two examples are questions the
# documents answer, so the reader is shown the shape of a message this reads rather
# than told to try harder.
UNREADABLE_SECOND = 'Still not catching it. You could try something like "{first}" or "{second}".'

# The third and every one after it. Short, and deliberately not escalating: somebody
# typing into a box at the wrong moment is not a problem to be solved, and the
# assistant should still sound like it is there.
UNREADABLE_THIRD = "No rush. I'm here whenever you want to ask about company policies."

# Questions the documents answer, offered as examples. They are the areas the corpus
# covers and nothing finer, so an example can never send anybody after a document
# that does not exist.
SAMPLE_QUESTIONS = (
    "What is the leave policy?",
    "How do I set up the VPN?",
    "How do I report a phishing email?",
    "What does the Code of Conduct cover?",
)

# How each reply in `UNREADABLE_REPLIES` starts, so a stored reply can be read back
# as one. The counter that decides which reply comes next is built out of this
# conversation's own messages, and this is how it recognises its own work.
UNREADABLE_OPENINGS = ("I couldn't quite make that out", "That one got past me", "Still not catching it", "No rush.")


def pleasantry_reply(reply_count: int, invitation_given: bool) -> str:
    """What to answer a greeting, a thank-you or a laugh with.

    The invitation goes first and only once: it is what tells somebody what this is
    for, and repeating it every turn is the sign-off this pool exists not to be.
    `reply_count` is how many replies this conversation has already had, which is
    what rotates the rest — and it is read from the conversation rather than
    remembered, so a reload does not restart the rotation.
    """
    if not invitation_given and reply_count == 0:
        return PLEASANTRY_INVITATION

    return PLEASANTRY_REPLIES[reply_count % len(PLEASANTRY_REPLIES)]


def unreadable_reply(streak: int, seen: int) -> str:
    """What to answer a message that could not be read.

    `streak` is how many unreadable replies this conversation has given in a row,
    which chooses how much help to offer: the first says it did not catch it, the
    second shows two questions the documents answer, and the third stops trying.
    `seen` is how many there have been in the conversation altogether, which is what
    rotates the first two rather than answering every keyboard slip identically.

    Nothing here is the not-found reply, the out-of-scope reply or the HR contact.
    A message nobody can read asked nothing of the corpus, and claiming it found
    nothing would be reporting a gap where there was no question.
    """
    if streak <= 1:
        return UNREADABLE_REPLIES[seen % len(UNREADABLE_REPLIES)]

    if streak == 2:
        return UNREADABLE_SECOND.format(
            first=SAMPLE_QUESTIONS[seen % len(SAMPLE_QUESTIONS)],
            second=SAMPLE_QUESTIONS[(seen + 1) % len(SAMPLE_QUESTIONS)],
        )

    return UNREADABLE_THIRD


def is_unreadable_reply(text: str) -> bool:
    """Whether a stored reply is one of these.

    How the streak is counted across a reload: the conversation's own messages say
    what has already been answered, so nothing has to be remembered between
    requests to know how many of these are already behind the reader.
    """
    cleaned = " ".join((text or "").split())

    return cleaned.startswith(UNREADABLE_OPENINGS)


def gives_the_invitation(text: str) -> bool:
    """Whether a stored reply already said what the assistant is for."""
    return INVITATION_MARKER in (text or "")