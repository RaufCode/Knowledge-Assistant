"""The citations as they are stored, read back, and read back again.

The `used_chunk_keys` question this answers is a schema question, and the answer is
that no schema change was needed: the passages an answer used are the passages
persisted, each marked `"used": true`, inside the `sources` JSON the column already
holds. So there is no migration, no nullable column and no second head — and three
things have to be true for that to be sufficient rather than merely convenient:

- a stored row reloads with the passages it displayed, in the order it displayed
  them, so a reloaded conversation renders identically to the live one;
- a row written *before* the flag existed still loads, and still holds back what it
  showed, because its citations are treated as used — the fallback the old rows
  depend on;
- `cited_chunk_ids`, which is what "anything else?" excludes on, reads the used
  passages and nothing else.

Tested against a real database rather than by inspecting the objects: the whole
question is what survives a round trip.
"""

import unittest
from uuid import uuid4

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base, Conversation, Message, cited_chunk_ids


def source(document: str, section: str, chunk_id: str, score: float) -> dict:
    return {
        "document": document,
        "section": section,
        "snippet": f"{document} {section}",
        "chunk_id": chunk_id,
        "score": score,
        "used": True,
    }


class StoredCitationsTest(unittest.TestCase):
    """A conversation stored, reloaded, and continued from."""

    def setUp(self) -> None:
        self.engine = create_engine(
            "sqlite://", connect_args={"check_same_thread": False}
        )
        Base.metadata.create_all(self.engine)
        self.db = sessionmaker(bind=self.engine)()
        self.conversation = Conversation(id=uuid4().hex, client_id="test-client")
        self.db.add(self.conversation)
        self.db.commit()

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    def store(self, content: str, kind: str, sources=None) -> Message:
        message = Message(
            id=uuid4().hex,
            conversation_id=self.conversation.id,
            role="assistant",
            content=content,
            kind=kind,
            sources=sources,
        )
        self.db.add(message)
        self.db.commit()

        return message

    def test_a_stored_answer_reloads_with_the_passages_it_showed(self):
        shown = [
            source("Company Overview", "Departments and their roles", "aaa111", 0.42),
            source("Company Overview", "Company size", "bbb222", 0.61),
        ]
        self.store("Ten departments.", "answer", shown)

        reloaded = self.db.get(Message, self.db.query(Message).filter_by(role="assistant").one().id)

        self.assertEqual([s["chunk_id"] for s in reloaded.sources], ["aaa111", "bbb222"])
        # The display order is the stored order, so a reloaded card numbers the
        # passages the same way the live one did.
        self.assertEqual(
            [s["document"] for s in reloaded.sources],
            ["Company Overview", "Company Overview"],
        )

    def test_every_stored_passage_is_marked_as_used(self):
        self.store("Ten departments.", "answer", [
            source("Company Overview", "Departments", "aaa111", 0.42),
        ])

        for stored in self.db.query(Message).filter_by(role="assistant").one().sources:
            with self.subTest(chunk=stored["chunk_id"]):
                self.assertTrue(stored["used"])

    def test_a_row_written_before_the_flag_still_loads_and_is_treated_as_used(self):
        # No migration ran, so every conversation in existence has rows like this.
        # They hold every retrieved passage rather than only the used ones, and the
        # right reading is that they were all displayed — otherwise "anything else?"
        # would re-quote a passage the reader has already read, which is the thing
        # the old rows cannot distinguish and must not get wrong in the other
        # direction.
        legacy = [
            {"document": "Leave Policy", "section": "Annual Leave", "snippet": "25 days",
             "chunk_id": "old111", "score": 0.44},
            {"document": "Leave Policy", "section": "Sick Leave", "snippet": "12 days",
             "chunk_id": "old222", "score": 0.40},
        ]
        self.store("Leave is 25 days.", "answer", legacy)

        reloaded = self.db.query(Message).filter_by(role="assistant").one()

        self.assertEqual(len(reloaded.sources), 2)
        self.assertEqual(cited_chunk_ids(self.db, self.conversation.id), {"old111", "old222"})

    def test_cited_chunk_ids_is_the_used_passages_and_nothing_else(self):
        self.store("Ten departments.", "answer", [
            source("Company Overview", "Departments", "aaa111", 0.42),
        ])

        self.assertEqual(cited_chunk_ids(self.db, self.conversation.id), frozenset({"aaa111"}))

    def test_it_spans_the_whole_conversation_not_only_the_last_answer(self):
        # "Anything else?" three turns later must not re-quote the first answer's
        # passage, and only the whole thread knows which passage that was.
        self.store("First.", "answer", [source("Leave Policy", "Annual", "aaa111", 0.44)])
        self.store("Then a greeting.", "conversational", None)
        self.store("More.", "answer", [source("Leave Policy", "Sick", "bbb222", 0.40)])

        self.assertEqual(
            cited_chunk_ids(self.db, self.conversation.id), frozenset({"aaa111", "bbb222"})
        )

    def test_a_reply_with_no_citations_contributes_nothing(self):
        self.store("Hello.", "conversational", None)
        self.store("Ten.", "answer", [source("Company Overview", "Departments", "aaa111", 0.42)])

        self.assertEqual(cited_chunk_ids(self.db, self.conversation.id), frozenset({"aaa111"}))

    def test_nothing_is_read_across_two_conversations(self):
        other = Conversation(id=uuid4().hex, client_id="test-client")
        self.db.add(other)
        self.db.add(Message(
            id=uuid4().hex, conversation_id=other.id, role="assistant",
            content="Elsewhere.", kind="answer",
            sources=[source("Leave Policy", "Annual", "zzz999", 0.44)],
        ))
        self.db.add(Message(
            id=uuid4().hex, conversation_id=self.conversation.id, role="assistant",
            content="Here.", kind="answer",
            sources=[source("Company Overview", "Departments", "aaa111", 0.42)],
        ))
        self.db.commit()

        self.assertEqual(cited_chunk_ids(self.db, self.conversation.id), frozenset({"aaa111"}))


class EmptyDatabaseTest(unittest.TestCase):
    """No migration exists, so this is the whole of what deploying one involves."""

    def test_the_schema_is_created_from_an_empty_database_with_nothing_else(self):
        engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
        Base.metadata.create_all(engine)

        from sqlalchemy import inspect

        columns = {
            table: {column["name"] for column in inspect(engine).get_columns(table)}
            for table in inspect(engine).get_table_names()
        }

        # The `used` flag is inside the `sources` JSON, not a column, and that is the
        # claim under test: the persisted shape of an answer is unchanged by it.
        self.assertIn("sources", columns["messages"])
        self.assertNotIn("used", columns["messages"])
        self.assertNotIn("used_chunk_keys", columns["messages"])

        engine.dispose()


if __name__ == "__main__":
    unittest.main()