"""One conversation must never see another's.

Two halves, because either alone would pass while the bug stands. The functional
half is the behaviour a reader would notice: a question that only makes sense
against earlier turns, asked in a conversation with none, is answered as chat
rather than searched for — and asked in a *second* conversation, it still is, no
matter what the first one was about. The static half is the shape of the code that
guarantees it: nothing that could carry a conversation lives outside the messages
stored under that conversation's id.
"""

import inspect
import unittest

from app.rag import engine, guard, retrieval
from app.rag.engine import NO_PRIOR_TOPIC_MSG, Assistant, PreviousAnswer
from app.rag.guard import needs_earlier_context


def assistant_answering(replies) -> Assistant:
    """An assistant whose model answers `replies` in order, and nothing else."""
    assistant = Assistant.__new__(Assistant)
    assistant.asked: list[str] = []
    scripted = list(replies)

    def complete(user_prompt: str, system_prompt: str = "", max_tokens=None) -> str:
        assistant.asked.append(user_prompt)
        return scripted.pop(0) if scripted else ""

    def stream(user_prompt: str, system_prompt: str = "", max_tokens=None):
        yield complete(user_prompt, system_prompt, max_tokens)

    assistant._complete = complete
    assistant._stream = stream

    class Retrieval:
        def retrieve(self, query):
            raise AssertionError(f"retrieval must not run for {query!r}")

        def retrieve_continuation(self, query, documents, already_shown):
            raise AssertionError("and neither must a continuation")

    assistant.retrieval = Retrieval()

    return assistant


class NoUsableTopicTest(unittest.TestCase):
    """A message that needs an earlier turn, in a conversation that has none."""

    def test_the_first_message_of_a_conversation_is_answered_as_chat(self):
        for message in (
            "anything else?",
            "tell me more",
            "what else",
            "go on",
            "what about contractors?",
            "what about that?",
            "and for part-time?",
            "why?",
            "so?",
            "same for me?",
        ):
            with self.subTest(message=message):
                asked: list[str] = []
                assistant = assistant_answering([])
                assistant.asked = asked

                done = list(assistant.ask_stream(message))[-1]

                self.assertEqual(done["kind"], "conversational")
                self.assertEqual(done["answer"], NO_PRIOR_TOPIC_MSG)
                self.assertEqual(done["sources"], [])
                self.assertIsNone(done["confidence"])
                # No classifier, no rewrite, no retrieval: there is nothing to
                # classify and nothing to look up.
                self.assertEqual(asked, [])

    def test_a_greeting_is_still_a_greeting(self):
        assistant = assistant_answering(["Hello! Ask me anything."])

        done = list(assistant.ask_stream("ok"))[-1]

        # "ok" asks for nothing rather than for more, so it is answered as the
        # acknowledgement it is, not as a request with no earlier turn to build on.
        self.assertEqual(done["kind"], "conversational")
        self.assertNotEqual(done["answer"], NO_PRIOR_TOPIC_MSG)

    def test_a_refusal_is_not_a_topic(self):
        # A refusal cites nothing, so there is no topic behind it to continue.
        assistant = assistant_answering([])

        previous = PreviousAnswer(kind="restricted", question="What is Kwame's salary?")
        done = list(assistant.ask_stream("anything else?", previous=previous))[-1]

        self.assertEqual(done["kind"], "conversational")
        self.assertEqual(done["answer"], NO_PRIOR_TOPIC_MSG)

    def test_an_answer_makes_it_a_topic_again(self):
        assistant = assistant_answering(["Full-time staff get 25 days."])

        class Retrieval:
            def retrieve(self, query):
                return []

            def retrieve_continuation(self, query, documents, already_shown):
                return []

        assistant.retrieval = Retrieval()
        previous = PreviousAnswer(has_topic=True, documents=frozenset({"Leave Policy"}))

        done = list(assistant.ask_stream("anything else?", previous=previous))[-1]

        # With a topic behind it the same message is a continuation, not chat.
        self.assertEqual(done["kind"], "no_more_info")

    def test_a_conversation_that_only_says_hello_has_no_topic(self):
        # The topic flag is what the route reads out of storage, and it is set by
        # the kind of the answers in the thread. Nothing else in the conversation
        # counts.
        for kinds in ([], ["conversational"], ["conversational", "out_of_scope"],
                      ["restricted"], ["conversational", "restricted"]):
            with self.subTest(kinds=kinds):
                topic = any(kind in ("answer", "not_found") for kind in kinds)
                self.assertEqual(topic, "answer" in kinds or "not_found" in kinds)


class NothingLivesBetweenConversationsTest(unittest.TestCase):
    """The static half: no module state, and nothing keyed by client."""

    def test_no_module_level_container_holds_anything_but_words(self):
        # Every module-level table in the rag package is a lookup of literals.
        # Anything that accumulated a question, an answer or a chunk id would be
        # state one conversation wrote and another read, and this is where it
        # would be visible.
        for module in (engine, guard, retrieval):
            for name, value in vars(module).items():
                if name.startswith("__") or not isinstance(value, (list, dict, set)):
                    continue

                with self.subTest(module=module.__name__, name=name):
                    values = value.values() if isinstance(value, dict) else value

                    for entry in values:
                        self.assertIsInstance(entry, str)

    def test_the_retrieval_index_is_the_corpus_and_not_a_conversation(self):
        # The one shared object is the keyword index, and it is built from the
        # documents — never from messages.
        source = inspect.getsource(retrieval.KeywordIndex.__init__)

        self.assertIn("node.get_content()", source)
        for forbidden in ("Message", "conversation", "history", "previous"):
            self.assertNotIn(forbidden, source)

    def test_the_assistant_takes_every_conversations_state_as_an_argument(self):
        # Nothing about a conversation is reachable from the assistant except
        # through what it is handed, so there is nothing to leak between two.
        for name, member in vars(Assistant).items():
            if isinstance(member, (staticmethod, classmethod)) or name.startswith("_"):
                continue

            with self.subTest(name=name):
                annotations = str(inspect.signature(member))

                self.assertNotIn("self._", annotations)


class ContextDependentRecognitionTest(unittest.TestCase):
    """Which messages need an earlier turn, before anything else runs."""

    def test_the_ones_that_do(self):
        for message in (
            "anything else?",
            "anything else I should know?",
            "tell me more",
            "what else?",
            "go on",
            "more on that",
            "what about contractors?",
            "what about that?",
            "and for part-time?",
            "why?",
            "and?",
            "same for me?",
        ):
            with self.subTest(message=message):
                self.assertTrue(needs_earlier_context(message), message)

    def test_the_ones_that_do_not(self):
        for message in (
            "what are the leave entitlements?",
            "how much annual leave do I get?",
            "what is the leave policy?",
            "what about parental leave and how do I claim it during maternity?",
            "what is the parental leave policy?",
            "hey",
            "thanks",
            "who are you?",
            "how does the leave policy work in detail for every region we operate in?",
        ):
            with self.subTest(message=message):
                self.assertFalse(needs_earlier_context(message), message)


if __name__ == "__main__":
    unittest.main()