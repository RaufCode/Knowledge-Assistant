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