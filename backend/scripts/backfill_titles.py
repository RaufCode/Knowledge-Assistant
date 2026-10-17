"""Names the conversations that were never named, without asking anybody.

Conversations created before a conversation was named by its first message are
sitting in the database under whatever they were left with: null, or the literal
placeholder "New conversation" the client shows for a conversation with no name. In
a list of conversations those rows are unreadable — they are the ones somebody
cannot find the answer they already gave.

This gives them a name from the first message they hold, by the same rules the
messages themselves use (`rule_title` below), and nothing else. There is no model
call: a migration that reaches a paid API once per row is not a migration, it is a
bill waiting to happen — and a rule-based name is the better answer anyway for the
rows that are a greeting, a thank-you or a keyboard slip, which is most of them.
A conversation whose first message was a real question is left alone, because the
name it wants is a short description of the question and a truncated question typed
into a sidebar row is not a title.

Idempotent, and safe to run twice, on deploy, or on a laptop:

- only conversations with no name of their own are touched, so a run after a run
  changes nothing;
- a reader's own rename is a name of its own and is never touched either;
- it writes one field on rows it selected and nothing else, so it cannot leave a
  half-applied conversation behind.

    python -m scripts.backfill_titles            # report what would change
    python -m scripts.backfill_titles --apply    # write it

Run from `backend/` with the same environment the app runs with: it opens the same
database and reads the same corpus vocabulary the guard uses, because "was that a
real message?" is the same question either way asks.
"""

import argparse
import logging
import sys

from sqlalchemy import or_, select

from app.database import Conversation, Message, init_db
from app.rag.guard import (
    is_greeting,
    is_obvious_conversational,
    is_restricted_request,
    is_unintelligible,
)

logger = logging.getLogger("backfill_titles")

# What the client shows for a conversation that has no name. It is a label rather
# than a name, and a row holding one is a row this script exists to fix.
PLACEHOLDER = "New conversation"

# The four names decided by rule, and the only ones this script can give.
GREETING_TITLE = "Greeting"
QUICK_CHAT_TITLE = "Quick chat"
UNCLEAR_TITLE = "Unclear message"
RESTRICTED_TITLE = "Restricted request"


def untitled(session) -> list[tuple[str, str]]:
    """Every `(conversation id, first user message)` that has no name of its own.

    The first message is picked by the database rather than in Python, because the
    order is `created_at` and two messages of the same conversation can share a
    timestamp: the tie is broken here, once, where it can be seen.
    """
    first_message = (
        select(Message.content)
        .where(
            Message.conversation_id == Conversation.id,
            Message.role == "user",
        )
        .order_by(Message.created_at.asc(), Message.id.asc())
        .limit(1)
        # Without this the subquery folds itself into the outer query and looks for
        # messages that are already in the result, which is the wrong question.
        .correlate(Conversation)
        .scalar_subquery()
    )

    rows = session.execute(
        select(Conversation.id, first_message.label("first_message"))
        .where(
            or_(Conversation.title.is_(None), Conversation.title == PLACEHOLDER),
            first_message.is_not(None),
        )
        .order_by(Conversation.created_at.asc())
    ).all()

    return [(row[0], row[1]) for row in rows]


def rule_title(message: str, vocabulary: frozenset[str]) -> str | None:
    """What this first message would have been called, or None if it needs the model.

    None is a real answer here rather than a failure: it is most of the rows in an
    established deployment, and naming those "Quick chat" because the rule had
    nothing better would be worse than leaving them visible.
    """
    if is_unintelligible(message, vocabulary):
        return UNCLEAR_TITLE

    if is_greeting(message):
        return GREETING_TITLE

    if is_restricted_request(message):
        return RESTRICTED_TITLE

    if is_obvious_conversational(message):
        return QUICK_CHAT_TITLE

    return None


def apply_title(session, conversation_id: str, title: str) -> bool:
    """Puts a name on a conversation that still has none. False if it now has one.

    Re-read rather than trusted, so a rename made while this runs wins: the row is
    re-fetched and the write is skipped if it has a name now.
    """
    conversation = session.get(Conversation, conversation_id)

    if conversation is None or conversation.title is not None:
        return False

    conversation.title = title
    session.commit()

    return True


def vocabulary() -> frozenset[str]:
    """The indexed documents' own words, if the index can be built.

    Empty when there is no key or no network, which makes the unreadable check
    stricter rather than wrong: without it, a keyboard accident whose word happens to
    appear in the corpus reads as a message and is called "Quick chat" rather than
    "Unclear message". Nothing is lost that a person cannot fix by renaming a row.
    """
    try:
        from app.rag.ingest import build_index
        from app.rag.retrieval import KeywordIndex

        return KeywordIndex(build_index().docstore.docs.values()).vocabulary
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "could not build the index; using the built-in words only: %s", exc
        )

        return frozenset()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Name untitled conversations.")
    parser.add_argument(
        "--apply",
        action="store_true",
        help="write the names. Without it, only report what would change.",
    )
    arguments = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    init_db()

    from app.database import SessionLocal

    session = SessionLocal()

    try:
        rows = untitled(session)

        if not rows:
            logger.info("every conversation that has messages already has a name")

            return 0

        words = vocabulary()
        named = 0
        skipped = 0

        for conversation_id, message in rows:
            title = rule_title(message, words)

            if title is None:
                skipped += 1

                continue

            named += 1
            written = apply_title(session, conversation_id, title) if arguments.apply else False
            logger.info(
                "%s  %-16s  %-6s <- %r",
                conversation_id[:8],
                title,
                "written" if written else "would write",
                message[:60],
            )

        logger.info(
            "%d named, %d left unnamed because they were a real question", named, skipped
        )

        if named and not arguments.apply:
            logger.info("pass --apply to write them")

        return 0
    finally:
        session.close()


if __name__ == "__main__":
    sys.exit(main())