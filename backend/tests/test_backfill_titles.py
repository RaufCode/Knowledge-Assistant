"""Naming the conversations that were never named.

Conversations created before a conversation was named by its first message are in
the database with no name, or with the client placeholder, and in a list of
conversations those are the rows somebody cannot find their own answer in. The
script that fixes them is deliberately rule-based and deliberately partial, and
these are the two properties worth pinning:

- it never guesses. A conversation whose first message was a real question keeps its
  placeholder, because a truncated question in a sidebar row is not a title;
- running it twice changes nothing the first run did not, and a reader's own rename
  is never touched.

It runs against a throwaway SQLite database rather than the configured one, because
a migration that can write to the wrong database is not one to test against the
right one.
"""

import tempfile
import unittest
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base, Conversation, Message
from scripts.backfill_titles import PLACEHOLDER, apply_title, rule_title, untitled

VOCABULARY = frozenset({"vpn", "leave", "policy", "expectations"})


class RuleTitleTest(unittest.TestCase):
    """What each first message is named, without a model in sight."""

    def test_the_four_names_that_are_rules(self):
        cases = {
            "Hey": "Greeting",
            "good morning": "Greeting",
            "thanks": "Quick chat",
            "ok": "Quick chat",
            "lol": "Quick chat",
            "vdghgjkhh": "Unclear message",
            "asdfgh": "Unclear message",
            "What is Kwame's salary?": "Restricted request",
        }

        for message, expected in cases.items():
            with self.subTest(message=message):
                self.assertEqual(rule_title(message, VOCABULARY), expected)

    def test_a_real_question_is_left_for_a_person_to_name(self):
        # The name it wants is a description of the question, and there is no rule
        # that writes one. Naming it "Quick chat" would be a lie about a
        # conversation somebody will come back for.
        for message in [
            "What is the leave policy?",
            "How do I set up the VPN?",
            "How do I raise a grievance?",
        ]:
            with self.subTest(message=message):
                self.assertIsNone(rule_title(message, VOCABULARY))


class BackfillTest(unittest.TestCase):
    """The script, against a database of its own."""

    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)

        self.engine = create_engine(f"sqlite:///{Path(self.directory.name) / 'backfill.db'}")
        Base.metadata.create_all(self.engine)
        self.addCleanup(self.engine.dispose)

        self.session = sessionmaker(bind=self.engine, autoflush=False)()
        self.addCleanup(self.session.close)

    def conversation(self, identifier: str, first: str, title=None, first_id: str | None = None):
        self.session.add(
            Conversation(
                id=identifier,
                client_id="client-1",
                user_id="user-1",
                title=title,
            )
        )
        self.session.add(
            Message(
                id=first_id or f"{identifier}-1",
                conversation_id=identifier,
                role="user",
                content=first,
            )
        )
        self.session.commit()

    def title_of(self, identifier: str):
        return self.session.get(Conversation, identifier).title

    def test_it_finds_only_the_conversations_with_no_name_of_their_own(self):
        self.conversation("greeted", "Hey")
        self.conversation("named", "Hey", title="Leave, carefully")
        self.conversation("placeholder", "Hey", title=PLACEHOLDER)
        self.conversation("renamed", "Hey", title="My own name")

        found = dict(untitled(self.session))

        # The named one and the reader's own rename are not this script's business.
        self.assertEqual(sorted(found), ["greeted", "placeholder"])

    def test_it_uses_the_first_message_and_not_the_latest(self):
        self.conversation("later", "Hey")
        self.session.add(
            Message(
                id="later-2",
                conversation_id="later",
                role="user",
                content="How do I set up the VPN?",
            )
        )
        self.session.commit()

        # A conversation is named by its first message, so a later question in it
        # changes nothing about what it is called.
        self.assertEqual(untitled(self.session), [("later", "Hey")])

    def test_running_it_twice_changes_nothing_the_second_time(self):
        self.conversation("a", "Hey")
        self.conversation("b", "thanks")

        first = {identifier: rule_title(message, VOCABULARY) for identifier, message in untitled(self.session)}

        for identifier, title in first.items():
            self.assertTrue(apply_title(self.session, identifier, title))

        self.assertEqual(untitled(self.session), [])
        self.assertEqual(self.title_of("a"), "Greeting")

    def test_a_rename_made_in_the_meantime_is_not_overwritten(self):
        self.conversation("a", "Hey")

        self.session.get(Conversation, "a").title = "Mine"
        self.session.commit()

        self.assertFalse(apply_title(self.session, "a", "Greeting"))
        self.assertEqual(self.title_of("a"), "Mine")

    def test_a_conversation_with_no_messages_is_not_named(self):
        self.session.add(
            Conversation(id="empty", client_id="client-1", user_id="user-1", title=None)
        )
        self.session.commit()

        # There is no first message to name it from, and inventing one would be
        # naming a conversation nobody has said anything in.
        self.assertEqual(untitled(self.session), [])


if __name__ == "__main__":
    unittest.main()