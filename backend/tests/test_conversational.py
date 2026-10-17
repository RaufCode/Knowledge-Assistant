"""Messages that are not requests for information, answered without retrieval.

Greetings, acknowledgements, reactions and remarks about the conversation itself
all reach this path, and none of them reaches the documents. That is the whole of
it: there is nothing to look up, and looking anyway is how "there is no question"
came back as "not found in the company documents".
"""

import unittest
from dataclasses import replace

from app.rag.capabilities import (
    CAPABILITIES_BRIEF,
    CAPABILITIES_REPLY,
    CONVERSATIONAL_FALLBACK,
    PLEASANTRY_INVITATION,
    PLEASANTRY_REPLIES,
)
from app.rag.engine import (
    CONVERSATIONAL_SYSTEM_PROMPT,
    Assistant,
    LlmUnavailable,
    PreviousAnswer,
)
from app.rag.guard import (
    Category,
    Classification,
    asks_about_capabilities,
    is_obvious_conversational,
)


class ConversationalFastPathTest(unittest.TestCase):
    """The rule check, which is what keeps a greeting off the model's latency."""

    def test_greetings_acknowledgements_and_reactions_match(self):
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
            "cheers",
            "ok",
            "OK.",
            "got it",
            "makes sense",
            "sure thing",
            "will do",
            "lol",
            "haha",
            "wow",
            "ok!",
        ]:
            with self.subTest(text=text):
                self.assertTrue(is_obvious_conversational(text), text)

    def test_questions_about_the_assistant_match(self):
        for text in ["who are you?", "what can you do?", "what do you do?", "how do you work?"]:
            with self.subTest(text=text):
                self.assertTrue(is_obvious_conversational(text), text)
                self.assertTrue(asks_about_capabilities(text), text)

    def test_requests_are_not_matched(self):
        # The rule check is deliberately narrow. A remark about the conversation
        # asks for nothing either, and is left to the classifier rather than
        # guessed at here — but nothing here may swallow a request.
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
            "what can you do about my leave request?",
            "how many presidents has Ghana had?",
            "there is no question",
            "that's not what I asked",
        ]:
            with self.subTest(text=text):
                self.assertFalse(is_obvious_conversational(text), text)


class ConversationalShortCircuitTest(unittest.TestCase):
    """A conversational reply never reaches retrieval: no index, no scores."""

    def assistant_answering(self, replies) -> Assistant:
        """An assistant whose model answers `replies` in order.

        A string is taken as one reply. A list is what a message the rules cannot
        decide needs: the classifier call comes first, so the first entry is what
        the classifier is given.
        """
        scripted = [replies] if isinstance(replies, str) else list(replies)
        assistant = Assistant.__new__(Assistant)
        assistant.prompts: list[str] = []

        def retrieve(question: str):  # pragma: no cover
            raise AssertionError(f"retrieval must not run for {question!r}")

        def complete(user_prompt: str, system_prompt: str = "", max_tokens=None) -> str:
            assistant.prompts.append(user_prompt)
            return scripted.pop(0) if scripted else ""

        def stream(user_prompt: str, system_prompt: str = "", max_tokens=None):
            yield complete(user_prompt, system_prompt, max_tokens)

        assistant.retriever = type("Retriever", (), {"retrieve": retrieve})()
        assistant._complete = complete  # noqa: SLF001
        assistant._stream = stream  # noqa: SLF001

        return assistant

    @staticmethod
    def conversational(message: str) -> Classification:
        """The classification a model returns for a remark about the exchange.

        Passed in explicitly where the subject is the reply rather than the
        routing: `test_intent.py` is where the classifier's own decision is pinned,
        including for this exact message.
        """
        return Classification(Category.CONVERSATIONAL, message)

    def test_stream_answers_without_retrieval_or_a_model_call(self):
        assistant = self.assistant_answering("a generated reply nobody should see")

        events = list(assistant.ask_stream("  hello!  "))

        self.assertEqual([event["type"] for event in events][0], "status")
        self.assertEqual([event["type"] for event in events][-1], "done")
        done = events[-1]
        self.assertEqual(done["kind"], "conversational")
        # From the pool rather than from the model. A greeting is the common case on
        # a first visit, and a generated reply to one is a fresh set of words each
        # time — including, eventually, a sign-off on a conversation that has not
        # started. The scripted reply is here to prove it is not used.
        self.assertEqual(done["answer"], PLEASANTRY_INVITATION)
        self.assertNotEqual(done["answer"], "a generated reply nobody should see")
        self.assertEqual(assistant.prompts, [])
        # Nothing to be confident about and nothing to cite: this was not built
        # from a single passage.
        self.assertIsNone(done["confidence"])
        self.assertEqual(done["sources"], [])

    def test_ten_greetings_in_a_row_never_invite_a_reply_twice(self):
        assistant = self.assistant_answering(["unused"] * 10)
        conversation = PreviousAnswer()

        replies = []

        for turn in range(10):
            previous = replace(conversation, assistant_replies=turn)
            replies.append(
                list(assistant.ask_stream("hello", previous=previous))[-1]["answer"]
            )

        # One introduction, then rotation. A reply that keeps asking whether it can
        # help is a sign-off with extra steps, and ten of them is a conversation
        # that sounds like it wants to end.
        self.assertEqual(replies.count(PLEASANTRY_INVITATION), 1)
        self.assertEqual(replies[0], PLEASANTRY_INVITATION)
        self.assertEqual(assistant.prompts, [])
        self.assertTrue(all(reply in PLEASANTRY_REPLIES for reply in replies[1:]))
        self.assertGreater(len(set(replies[1:])), 1)

    def test_a_remark_about_the_exchange_is_answered_as_a_reply_not_a_refusal(self):
        assistant = self.assistant_answering(
            [
                "CATEGORY: CONVERSATIONAL\nQUESTION: there is no question",
                "You're right, no question yet. Whenever you're ready, ask me anything.",
            ]
        )

        events = list(
            assistant.ask_stream(
                "there is no question",
                [("user", "Hey"), ("assistant", "Hello! Ask me anything.")],
            )
        )
        done = events[-1]

        self.assertEqual(done["kind"], "conversational")
        self.assertIn("no question yet", done["answer"])
        # The frame the bug report showed is absent as an absence, not as a wording.
        self.assertNotIn("documents", done["answer"])
        self.assertNotIn("HR", done["answer"])

    def test_the_reply_is_given_the_conversation(self):
        assistant = self.assistant_answering(
            [
                "CATEGORY: CONVERSATIONAL\nQUESTION: there is no question",
                "You're right, no question yet.",
            ]
        )

        list(
            assistant.ask_stream(
                "there is no question",
                [("user", "Hey"), ("assistant", "Hello! Ask me anything.")],
            )
        )

        # The prompt carries the exchange, because "you're right, no question yet"
        # is only a reply to having been greeted — and a model shown "there is no
        # question" alone can only either refuse it or invent a question.
        prompt = assistant.prompts[-1]
        self.assertIn("Hey", prompt)
        self.assertIn("Hello! Ask me anything.", prompt)
        self.assertLess(prompt.index("Hey"), prompt.index("there is no question"))

    def test_the_streamed_and_unstreamed_paths_say_the_same_thing(self):
        assistant = self.assistant_answering("Good to hear from you.")

        result = assistant.ask("hello")
        streamed = list(assistant.ask_stream("hello"))[-1]

        self.assertEqual(result["answer"], streamed["answer"])
        self.assertEqual(result["kind"], "conversational")
        self.assertEqual(result["answer"], PLEASANTRY_INVITATION)

    def test_capabilities_are_answered_from_the_config_not_the_model(self):
        assistant = self.assistant_answering("I can do anything you like.")

        done = list(assistant.ask_stream("what can you do?"))[-1]

        # A model asked what it can do describes whatever reads best, so this one
        # is never asked.
        self.assertEqual(done["answer"], CAPABILITIES_REPLY)
        self.assertIn("company documents", CAPABILITIES_REPLY)
        self.assertNotEqual(done["answer"], "I can do anything you like.")
        self.assertEqual(assistant.prompts, [])

    def test_model_outage_still_replies(self):
        assistant = Assistant.__new__(Assistant)
        assistant.retriever = None

        def broken(*args, **kwargs):
            raise LlmUnavailable("down")

        assistant._complete = broken  # noqa: SLF001
        assistant._stream = broken  # noqa: SLF001

        events = list(
            assistant.ask_stream(
                "there is no question",
                classification=self.conversational("there is no question"),
            )
        )
        done = events[-1]

        self.assertEqual(done["type"], "done")
        self.assertEqual(done["kind"], "conversational")
        self.assertEqual(done["answer"], CONVERSATIONAL_FALLBACK)
        # And the fallback does not dress itself as a gap in the corpus either.
        self.assertNotIn("documents", done["answer"])

    def test_a_reply_cut_off_mid_sentence_ends_on_the_last_whole_one(self):
        assistant = Assistant.__new__(Assistant)
        assistant.retriever = None

        def half(*args, **kwargs):
            yield "You're right, no question yet. Whenever you're ready, ask me"
            raise LlmUnavailable("dropped")

        assistant._stream = half  # noqa: SLF001

        done = list(
            assistant.ask_stream(
                "there is no question",
                classification=self.conversational("there is no question"),
            )
        )[-1]

        self.assertEqual(done["answer"], "You're right, no question yet.")


class ConversationalPromptTest(unittest.TestCase):
    """The guardrails the reply is generated under."""

    def test_it_cannot_state_a_company_fact(self):
        self.assertIn("Never state a company fact", CONVERSATIONAL_SYSTEM_PROMPT)

    def test_it_cannot_claim_something_is_missing_from_the_documents(self):
        # The exact failure this path exists to stop: a reply that tells the reader
        # the documents do not cover what they never asked about.
        self.assertIn("Never say that something is not in the documents", CONVERSATIONAL_SYSTEM_PROMPT)
        self.assertIn("never mention documents", CONVERSATIONAL_SYSTEM_PROMPT)

    def test_it_cannot_promise_more_than_the_configured_abilities(self):
        self.assertIn("Never promise anything beyond the abilities described above", CONVERSATIONAL_SYSTEM_PROMPT)
        self.assertIn(CAPABILITIES_BRIEF, CONVERSATIONAL_SYSTEM_PROMPT)


if __name__ == "__main__":
    unittest.main()