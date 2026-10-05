"""Conversation identity and persistence, at the level of the HTTP contract.

A few things here cost data integrity when they go wrong, so they are pinned:

- One conversation is one row in the sidebar. `POST /api/conversations` is the
  only thing that creates one, and every later message sent with that id is
  appended to the same conversation. A second conversation appearing mid-thread
  is what files messages under the wrong entry in the sidebar.
- A message never creates a conversation. Posting to an id that does not exist
  (or is not yours) is a 404, never a silent new conversation.
- There is no expiry. Conversations are never dropped for getting old, because
  "recent" is about what the user did last, not about some TTL the client has
  to babysit.
- Only the conversation's owner can read, rename or delete it, and the owner is
  the signed-in account — never anything the caller sends. Another account
  guessing an id, or sending a `client_id` that happens to match, gets a 404.

The app's own startup builds a LlamaIndex index over the policy documents, which
needs network access and an embedding key. `TestClient` is used without its
context manager so the lifespan never runs, and `state["assistant"]` is replaced
with a stub, so these tests are offline and need no key.
"""

import json
import tempfile
import time
import unittest
from collections.abc import Iterator
from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app import main
from app.config import settings
from app.database import Base, Conversation, Message, User
from app.dependencies import ACCESS_COOKIE, CSRF_COOKIE
from app.security import create_access_token, hash_password, new_csrf_token

SOURCE = {
    "document": "Leave Policy",
    "section": "Annual Leave",
    "snippet": "Full-time employees are entitled to 21 days.",
    "score": 0.823,
}

CLIENT_A = "1111-aaaa-1111-aaaa-1111"


class StubAssistant:
    """Answers without a model, streaming the answer in two pieces."""

    def ask_stream(self, question: str) -> Iterator[dict]:
        yield {"type": "status", "stage": "writing"}
        yield {"type": "delta", "text": "Answer "}
        yield {"type": "delta", "text": f"to {question}"}
        yield {"type": "done", "answer": f"Answer to {question}", "answered": True, "sources": [SOURCE]}

    def generate_title(self, first_message: str) -> str:
        words = " ".join(first_message.split())[:20]
        return f"About: {words}"


def read_events(body: str) -> list[dict]:
    """The server-sent events in a streamed body, as plain dicts."""
    return [
        json.loads(line[len("data:") :].strip())
        for line in body.splitlines()
        if line.startswith("data:")
    ]


class ConversationTestCase(unittest.TestCase):
    """A client wired to a throwaway SQLite database and a stubbed assistant."""

    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.engine = create_engine(f"sqlite:///{Path(self.directory.name) / 'test.db'}")
        Base.metadata.create_all(self.engine)
        self.sessionmaker = sessionmaker(bind=self.engine, autoflush=False)
        self.db = self.sessionmaker()

        def override_get_db():
            yield self.db
            self.db.close()

        self.addCleanup(self.directory.cleanup)
        self.addCleanup(self.engine.dispose)
        self.addCleanup(self.db.close)

        main.app.dependency_overrides[main.get_db] = override_get_db
        self.addCleanup(main.app.dependency_overrides.clear)

        # Naming a conversation runs on its own thread with a session of its own,
        # so it has to be pointed at the throwaway database too or it would write
        # the conversation's name into the real one. A session per call, because
        # sharing the request's would be two threads on one transaction.
        self.open_db = main.open_db
        main.open_db = self.sessionmaker
        self.addCleanup(self._restore_open_db)

        self.assistant = main.state.get("assistant")
        main.state["assistant"] = StubAssistant()
        self.addCleanup(self._restore_assistant)

        # Not `with TestClient(app) as ...`: entering the context manager is what
        # runs the lifespan, and the lifespan builds an index over the network.
        self.client = TestClient(main.app)

        # Every conversation route is behind the session wall, so this client signs
        # in the way the app does rather than being waved through: a real user row
        # and a real signed access token. `test_auth.py` is where the sign-in flow
        # itself is exercised; this is only here so the conversation tests reach
        # their subject.
        self.auth_secret = settings.auth_secret_key
        self.addCleanup(setattr, settings, "auth_secret_key", self.auth_secret)
        settings.auth_secret_key = "test-secret-key-that-is-definitely-long-enough-000"

        self.user = User(
            id="test-employee",
            email=f"employee@{settings.email_domain}",
            name="Ama Konadu",
            role="employee",
            password_hash=hash_password("correct-horse-1!"),
            is_active=True,
        )
        self.db.add(self.user)
        self.db.commit()

        access_token, _ = create_access_token(self.user.id, self.user.role)
        self.csrf_token = new_csrf_token()

        for name, value in ((ACCESS_COOKIE, access_token), (CSRF_COOKIE, self.csrf_token)):
            self.client.cookies.set(name, value)

    def _restore_open_db(self) -> None:
        main.open_db = self.open_db

    def _restore_assistant(self) -> None:
        if self.assistant is None:
            main.state.pop("assistant", None)
        else:
            main.state["assistant"] = self.assistant

    def csrf_headers(self) -> dict:
        """The double-submit header, which every state-changing route now needs."""
        return {"X-CSRF-Token": self.csrf_token}

    def new_conversation(self, client_id: str = CLIENT_A) -> str:
        """Creates a conversation through the endpoint, as a client would."""
        response = self.client.post(
            "/api/conversations",
            json={"client_id": client_id},
            headers=self.csrf_headers(),
        )
        self.assertEqual(response.status_code, 200, response.text)

        return response.json()["id"]

    def ask(self, conversation_id: str, question: str, client_id: str = CLIENT_A):
        return self.client.post(
            f"/api/conversations/{conversation_id}/messages",
            json={"client_id": client_id, "content": question},
            headers=self.csrf_headers(),
        )

    def conversations_in_db(self) -> list[str]:
        return list(self.db.scalars(select(Conversation.id)).all())

    def messages_in_db(self, conversation_id: str) -> list[Message]:
        return list(
            self.db.scalars(
                select(Message)
                .where(Message.conversation_id == conversation_id)
                .order_by(Message.created_at, Message.id)
            ).all()
        )


class OneConversationPerThreadTest(ConversationTestCase):
    def test_five_messages_share_one_conversation(self):
        conversation_id = self.new_conversation()

        questions = [
            "How much leave do I have?",
            "And what about carryover?",
            "Does it roll over forever?",
            "How do I book it?",
            "Who approves it?",
        ]
        for question in questions:
            response = self.ask(conversation_id, question)
            self.assertEqual(response.status_code, 200, response.text)

        # The bug this pins: one conversation, one sidebar entry, no matter how
        # many messages are in it. Ten rows (a user/assistant pair per question)
        # all under the same conversation, and no second conversation anywhere.
        messages = self.messages_in_db(conversation_id)
        self.assertEqual([m.conversation_id for m in messages], [conversation_id] * 10)
        self.assertEqual([m.role for m in messages], ["user", "assistant"] * 5)
        self.assertEqual(self.conversations_in_db(), [conversation_id])

    def test_a_message_never_creates_a_conversation(self):
        # Sending to an id that does not exist must fail, not silently open a
        # conversation that then owns the message.
        response = self.ask("does-not-exist", "Anything?")

        self.assertEqual(response.status_code, 404, response.text)
        self.assertEqual(self.conversations_in_db(), [])

    def test_the_detail_returns_the_thread_oldest_first(self):
        conversation_id = self.new_conversation()
        for question in ("First?", "Second?", "Third?"):
            self.ask(conversation_id, question)

        detail = self.client.get(
            f"/api/conversations/{conversation_id}", params={"client_id": CLIENT_A}
        ).json()

        self.assertEqual([item["role"] for item in detail["messages"]], ["user", "assistant"] * 3)
        self.assertEqual(
            [item["content"] for item in detail["messages"] if item["role"] == "user"],
            ["First?", "Second?", "Third?"],
        )

    def test_an_abandoned_stream_records_the_question_but_no_answer(self):
        conversation_id = self.new_conversation()

        class BrokenAssistant(StubAssistant):
            def ask_stream(self, question):
                yield {"type": "delta", "text": "Half an ans"}
                raise RuntimeError("connection dropped")

        main.state["assistant"] = BrokenAssistant()

        # Once the response has started there is no status line left to fail with,
        # so the failure travels as the connection ending. The client sees a stream
        # that stopped before its closing event and says the answer was interrupted.
        with self.assertRaises(RuntimeError):
            self.ask(conversation_id, "Anything?")

        # The question itself is recorded before the stream opens, so a follow-up
        # on it makes sense; the half-answer is not, so it can never be read back
        # as though it were the whole one.
        messages = self.messages_in_db(conversation_id)
        self.assertEqual([m.role for m in messages], ["user"])
        self.assertEqual(messages[0].content, "Anything?")


class OwnershipTest(ConversationTestCase):
    def other_client(self) -> TestClient:
        """A second signed-in account, with its own cookies, on the same app."""
        other = User(
            id="test-employee-2",
            email=f"second@{settings.email_domain}",
            name="Kwame Osei",
            role="employee",
            password_hash=hash_password("correct-horse-1!"),
            is_active=True,
        )
        self.db.add(other)
        self.db.commit()

        access_token, _ = create_access_token(other.id, other.role)
        client = TestClient(main.app)

        for name, value in ((ACCESS_COOKIE, access_token), (CSRF_COOKIE, self.csrf_token)):
            client.cookies.set(name, value)

        return client

    def test_another_account_cannot_read_a_conversation_it_does_not_own(self):
        conversation_id = self.new_conversation(CLIENT_A)
        self.ask(conversation_id, "How much leave?")

        response = self.other_client().get(
            f"/api/conversations/{conversation_id}", params={"client_id": CLIENT_A}
        )

        # A missing id and someone else's id answer the same way, so ownership
        # cannot be probed by the shape of the error.
        self.assertEqual(response.status_code, 404, response.text)

    def test_the_same_client_id_does_not_grant_access_to_another_account(self):
        # The exact shape of the leak this replaced. `client_id` is still recorded and
        # still sent by every client, but it decides nothing: both accounts send the
        # same value and each sees only its own threads.
        conversation_id = self.new_conversation(CLIENT_A)
        self.ask(conversation_id, "How much leave?")

        other = self.other_client()

        self.assertEqual(
            other.get(
                f"/api/conversations/{conversation_id}", params={"client_id": CLIENT_A}
            ).status_code,
            404,
        )
        self.assertEqual(
            other.get("/api/conversations", params={"client_id": CLIENT_A}).json(),
            {"conversations": []},
        )

    def test_each_account_sees_only_its_own_conversations(self):
        mine = self.new_conversation(CLIENT_A)
        self.assertEqual(self.ask(mine, "In mine?").status_code, 200)

        other = self.other_client()
        response = other.post(
            "/api/conversations",
            json={"client_id": CLIENT_A},
            headers=self.csrf_headers(),
        )
        self.assertEqual(response.status_code, 200, response.text)
        theirs = response.json()["id"]
        self.assertEqual(
            other.post(
                f"/api/conversations/{theirs}/messages",
                json={"client_id": CLIENT_A, "content": "In theirs?"},
                headers=self.csrf_headers(),
            ).status_code,
            200,
        )

        self.assertEqual(
            [item["id"] for item in self.client.get(
                "/api/conversations", params={"client_id": CLIENT_A}
            ).json()["conversations"]],
            [mine],
        )
        self.assertEqual(
            [item["id"] for item in other.get(
                "/api/conversations", params={"client_id": CLIENT_A}
            ).json()["conversations"]],
            [theirs],
        )

    def test_another_account_cannot_delete_a_conversation_it_does_not_own(self):
        conversation_id = self.new_conversation(CLIENT_A)

        response = self.other_client().delete(
            f"/api/conversations/{conversation_id}",
            params={"client_id": CLIENT_A},
            headers=self.csrf_headers(),
        )

        self.assertEqual(response.status_code, 404, response.text)
        self.assertEqual(self.conversations_in_db(), [conversation_id])

    def test_another_account_cannot_rename_a_conversation_it_does_not_own(self):
        conversation_id = self.new_conversation(CLIENT_A)

        response = self.other_client().patch(
            f"/api/conversations/{conversation_id}",
            json={"client_id": CLIENT_A, "title": "Stolen"},
            headers=self.csrf_headers(),
        )

        self.assertEqual(response.status_code, 404, response.text)


class EmptyConversationTest(ConversationTestCase):
    """A conversation nothing has been said in is not listed.

    The row exists from the moment a conversation is created, so an abandoned one —
    a closed tab, a send that failed, a click on "New conversation" — would otherwise
    sit in the sidebar forever as a thread nobody asked for. It is filtered at the
    source so no client has to decide what counts as real.

    The messages are written straight into the database rather than sent through the
    ask endpoint. What is under test is the list, and the endpoint has its own tests;
    going through it would also start a title job in a background thread that outlives
    the request, which is a race this fixture does not need to enter.
    """

    def say(self, conversation_id: str, content: str = "A real question?") -> None:
        self.db.add(
            Message(
                id=f"m-{conversation_id}",
                conversation_id=conversation_id,
                role="user",
                content=content,
                sources=None,
            )
        )
        self.db.commit()

    def listed_ids(self, client_id: str = CLIENT_A) -> list[str]:
        response = self.client.get("/api/conversations", params={"client_id": client_id})

        self.assertEqual(response.status_code, 200, response.text)

        return [item["id"] for item in response.json()["conversations"]]

    def test_a_conversation_with_no_messages_is_not_listed(self):
        created = self.new_conversation()

        self.assertEqual(self.listed_ids(), [])
        # Still there, and still addressable: it is the list that hides it, not a
        # conversation that was never made. A question sent into it makes it real.
        self.assertIn(created, self.conversations_in_db())

    def test_it_is_listed_once_it_has_a_message(self):
        conversation_id = self.new_conversation()

        self.say(conversation_id)

        self.assertEqual(self.listed_ids(), [conversation_id])

    def test_several_empty_ones_stay_hidden_while_a_real_one_is_listed(self):
        self.new_conversation()
        self.new_conversation()
        real = self.new_conversation()

        self.say(real)

        self.assertEqual(self.listed_ids(), [real])

    def test_an_untitled_conversation_is_still_listed(self):
        # The title is generated beside the answer, so a real conversation can be a
        # question whose answer failed: no title, but not empty either. It belongs in
        # the list, which is why the filter is on messages and not on the title.
        conversation_id = self.new_conversation()

        self.say(conversation_id)

        listed = self.client.get(
            "/api/conversations", params={"client_id": CLIENT_A}
        ).json()["conversations"]

        self.assertEqual(len(listed), 1)
        self.assertIsNone(listed[0]["title"])

    def test_it_is_still_addressable_directly(self):
        # Hidden from the list, not unreachable: a conversation the user has the link
        # for is a conversation they can open.
        conversation_id = self.new_conversation()
        self.say(conversation_id)

        response = self.client.get(
            f"/api/conversations/{conversation_id}", params={"client_id": CLIENT_A}
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(response.json()["messages"]), 1)


class ConversationLifecycleTest(ConversationTestCase):
    def test_the_list_orders_by_most_recent_activity(self):
        first = self.new_conversation()
        second = self.new_conversation()

        # second is newer, so it leads; then asking inside first moves it to the front.
        def listed_ids():
            return [
                item["id"]
                for item in self.client.get(
                    "/api/conversations", params={"client_id": CLIENT_A}
                ).json()["conversations"]
            ]

        # Both are asked in, because an unanswered conversation is not listed at all
        # and there would be no order to compare.
        self.ask(first, "Anything in the first?")
        self.ask(second, "Anything in the second?")

        self.assertEqual(listed_ids(), [second, first])

        self.ask(first, "Back to the first?")

        self.assertEqual(listed_ids(), [first, second])

    def test_rename_replaces_the_generated_title(self):
        conversation_id = self.new_conversation()
        self.ask(conversation_id, "Anything?")

        response = self.client.patch(
            f"/api/conversations/{conversation_id}",
            json={"client_id": CLIENT_A, "title": "Leave questions"},
            headers=self.csrf_headers(),
        )
        self.assertEqual(response.status_code, 200, response.text)

        detail = self.client.get(
            f"/api/conversations/{conversation_id}", params={"client_id": CLIENT_A}
        ).json()
        self.assertEqual(detail["title"], "Leave questions")

        listed = self.client.get(
            "/api/conversations", params={"client_id": CLIENT_A}
        ).json()["conversations"]
        self.assertEqual(listed[0]["title"], "Leave questions")

    def test_delete_removes_the_conversation_and_its_messages(self):
        conversation_id = self.new_conversation()
        self.ask(conversation_id, "Anything?")

        response = self.client.delete(
            f"/api/conversations/{conversation_id}",
            params={"client_id": CLIENT_A},
            headers=self.csrf_headers(),
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.conversations_in_db(), [])
        self.assertEqual(self.messages_in_db(conversation_id), [])


class TitleGenerationTest(ConversationTestCase):
    def test_the_first_exchange_names_the_conversation(self):
        conversation_id = self.new_conversation()

        response = self.ask(conversation_id, "How much leave do I have?")
        self.assertEqual(response.status_code, 200, response.text)

        events = read_events(response.text)

        # The title rides as the final event, after the answer itself, because the
        # answer is delivered first and the title just labels the conversation.
        self.assertEqual(events[-1]["type"], "title")
        title = events[-1]["title"]
        self.assertIn("About:", title)

        detail = self.client.get(
            f"/api/conversations/{conversation_id}", params={"client_id": CLIENT_A}
        ).json()
        self.assertEqual(detail["title"], title)

    def test_generated_title_replaces_the_untitled_placeholder_in_the_list(self):
        conversation_id = self.new_conversation()

        # Nothing is listed yet, so there is no placeholder to show: the conversation
        # joins the list when it has something in it rather than when it is created.
        self.assertEqual(
            self.client.get(
                "/api/conversations", params={"client_id": CLIENT_A}
            ).json()["conversations"],
            [],
        )

        self.ask(conversation_id, "How much leave do I have?")

        listed = self.client.get(
            "/api/conversations", params={"client_id": CLIENT_A}
        ).json()["conversations"]
        self.assertIn("About:", listed[0]["title"])

    def test_a_question_asked_before_the_title_arrives_still_lists_without_one(self):
        # The title is generated beside the answer, so there is a moment when a real
        # conversation has none. It is listed rather than hidden, because it is not
        # empty — which is the distinction the list filter draws.
        conversation_id = self.new_conversation()

        self.ask(conversation_id, "How much leave do I have?")

        listed = self.client.get(
            "/api/conversations", params={"client_id": CLIENT_A}
        ).json()["conversations"]
        self.assertEqual(len(listed), 1)

    def test_a_second_exchange_does_not_regenerate_the_title(self):
        conversation_id = self.new_conversation()

        first = read_events(self.ask(conversation_id, "First?").text)
        self.assertEqual(first[-1]["type"], "title")
        title = first[-1]["title"]

        second = read_events(self.ask(conversation_id, "Second?").text)
        self.assertEqual(
            [event for event in second if event["type"] == "title"],
            [],
        )

        detail = self.client.get(
            f"/api/conversations/{conversation_id}", params={"client_id": CLIENT_A}
        ).json()
        self.assertEqual(detail["title"], title)

    def test_a_title_generation_failure_still_delivers_the_answer(self):
        conversation_id = self.new_conversation()

        class TitleBreakingAssistant(StubAssistant):
            def generate_title(self, first_message: str) -> str:
                raise RuntimeError("model is gone mid-stream")

        main.state["assistant"] = TitleBreakingAssistant()

        response = self.ask(conversation_id, "How much leave?")
        events = read_events(response.text)

        # The answer arrived; only the title event is absent, and the conversation
        # is left unnamed rather than the whole stream dying.
        self.assertEqual(events[-1]["type"], "done")
        detail = self.client.get(
            f"/api/conversations/{conversation_id}", params={"client_id": CLIENT_A}
        ).json()
        self.assertIsNone(detail["title"])

    def test_a_client_that_hangs_up_still_leaves_the_conversation_named(self):
        # The name is written by a thread that does not care whether anyone is
        # still reading, so closing the connection costs nothing. This is what a
        # browser tab closed mid-answer looks like.
        conversation_id = self.new_conversation()

        main.state["assistant"] = StubAssistant()

        with self.client.stream(
            "POST",
            f"/api/conversations/{conversation_id}/messages",
            json={"client_id": CLIENT_A, "content": "How much leave?"},
            headers=self.csrf_headers(),
        ) as response:
            # Read the first chunk, then walk away mid-answer.
            for _ in response.iter_bytes():
                break

        detail = None
        for _ in range(200):
            detail = self.client.get(
                f"/api/conversations/{conversation_id}", params={"client_id": CLIENT_A}
            ).json()
            if detail["title"] is not None:
                break
            time.sleep(0.05)

        # The answer arrived and the conversation ended up named, without the
        # client ever having seen the title event.
        self.assertEqual(detail["title"], "About: How much leave?")


class NoExpiryTest(ConversationTestCase):
    def test_an_old_conversation_is_still_there_and_still_accepts_messages(self):
        conversation_id = self.new_conversation()

        for question in ("First?", "Second?"):
            self.ask(conversation_id, question)

        # Nothing to expire: the conversation is still listed, still its whole
        # length, and still takes follow-ups, with no expiry status anywhere.
        response = self.ask(conversation_id, "Third?")
        self.assertEqual(response.status_code, 200, response.text)

        listed = self.client.get(
            "/api/conversations", params={"client_id": CLIENT_A}
        ).json()["conversations"]
        self.assertEqual([item["id"] for item in listed], [conversation_id])

        detail = self.client.get(
            f"/api/conversations/{conversation_id}", params={"client_id": CLIENT_A}
        ).json()
        self.assertEqual(len(detail["messages"]), 6)


class StreamedAnswerTest(ConversationTestCase):
    def test_the_answer_streams_and_the_citations_come_last(self):
        conversation_id = self.new_conversation()

        response = self.ask(conversation_id, "How much leave?")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.headers["content-type"].startswith("text/event-stream"))

        events = read_events(response.text)

        # Every piece of the answer is its own event, so a client can append them
        # as they land instead of waiting for the finished answer.
        self.assertEqual(
            [event["text"] for event in events if event["type"] == "delta"],
            ["Answer ", "to How much leave?"],
        )

        # The closing answer event is the only one carrying citations: the text
        # can still be replaced by a refusal that cites nothing, so sources sent
        # part way through would be evidence for an answer not yet given.
        done = [event for event in events if event["type"] == "done"]
        self.assertEqual(done[-1]["sources"], [SOURCE])

    def test_the_answer_is_said_to_be_written_before_any_text_arrives(self):
        conversation_id = self.new_conversation()

        response = self.ask(conversation_id, "How much leave?")

        self.assertEqual(read_events(response.text)[0], {"type": "status", "stage": "writing"})


if __name__ == "__main__":
    unittest.main()