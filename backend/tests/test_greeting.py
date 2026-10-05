"""Greetings and casual chat, answered politely without retrieval."""

import unittest

from app.rag.engine import Assistant
from app.rag.guard import is_greeting


class GreetingClassifierTest(unittest.TestCase):
    def test_greetings_and_casual_chat_match(self):
        for text in [
            "hello",
            "Hello!",
            "  HI  ",
            "hey",
            "heyyy?",
            "good morning",
            "Good MORNING...",
            "hello there",
            "hey team",
            "how are you?",
            "what's up",
            "hello assistant",
            "bye",
            "goodbye",
            "see you later",
            "thanks",
            "thank you so much",
            "who are you",
            "what can you do",
            "help",
            "good night",
        ]:
            with self.subTest(text=text):
                self.assertTrue(is_greeting(text), text)

    def test_questions_are_not_greetings(self):
        for text in [
            "",
            "   ",
            "hello, what is the leave policy?",
            "hi, how many leave days do I get?",
            "morning shift allowance?",
            "history",
            "help with my leave request",
            "hey you",
            "good morning team, please approve my leave",
            "How many leaves are in a year",
            "thank you for the leave approval, how do I appeal?",
        ]:
            with self.subTest(text=text):
                self.assertFalse(is_greeting(text), text)


class GreetingShortCircuitTest(unittest.TestCase):
    """A greeting never reaches retrieval: no index, no scores, no model needed."""

    def assistant_answering(self, reply: str) -> Assistant:
        assistant = Assistant.__new__(Assistant)

        def retrieve(question: str):  # pragma: no cover
            raise AssertionError(f"retrieval must not run for {question!r}")

        assistant.retriever = type("Retriever", (), {"retrieve": retrieve})()
        assistant._complete = lambda *args, **kwargs: reply  # noqa: SLF001

        return assistant

    def test_stream_answers_without_retrieval(self):
        assistant = self.assistant_answering("Good morning! I answer policy questions.")

        events = list(assistant.ask_stream("  hello!  "))

        self.assertEqual([event["type"] for event in events], ["status", "delta", "done"])
        done = events[-1]
        self.assertEqual(done["answer"], "Good morning! I answer policy questions.")
        self.assertTrue(done["answered"])
        self.assertEqual(done["status"], "greeting")
        self.assertEqual(done["sources"], [])

    def test_plain_answer_is_unchanged(self):
        assistant = self.assistant_answering("irrelevant")

        result = assistant.ask("hello")

        self.assertEqual(result["answer"], "irrelevant")
        self.assertTrue(result["answered"])
        self.assertEqual(result["status"], "greeting")

    def test_model_outage_still_greets(self):
        from app.rag.engine import LlmUnavailable

        assistant = Assistant.__new__(Assistant)
        assistant.retriever = None

        def broken(*args, **kwargs):
            raise LlmUnavailable("down")

        assistant._complete = broken  # noqa: SLF001

        events = list(assistant.ask_stream("hi"))
        done = events[-1]

        self.assertEqual(done["type"], "done")
        self.assertTrue(done["answered"])
        self.assertIn("Internal Knowledge Assistant", done["answer"])


if __name__ == "__main__":
    unittest.main()
