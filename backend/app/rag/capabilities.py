"""What the assistant is and what it covers, in one place.

This is the only description of the assistant's own abilities in the codebase, and
two paths read it rather than restate it:

- "who are you?" and "what can you do?" are answered from it verbatim, because a
  generated answer to a question about capabilities is a promise nobody checked,
  and the failure is a feature that does not exist described as though it does.
- The prompt for every other conversational reply quotes it too, so that small
  talk stays inside what this assistant actually does.

Nothing here is derived from the index at runtime. The corpus can change without
this file changing, and a description that moved with it would be one more thing
that could describe abilities the documents do not support.
"""

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
CONVERSATIONAL_FALLBACK = (
    "Sounds like there is no question just yet. Whenever you're ready, ask me "
    "anything about company policies, onboarding, leave, IT setup and similar "
    "topics."
)


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