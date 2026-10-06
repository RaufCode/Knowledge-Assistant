"""Which of the five paths a message takes, decided before retrieval.

The categories matter because they are not variations on one answer — they are
different answers, and getting one wrong is a bug a person can see:

- a greeting retrieved from the documents comes back as "not found"
- a follow-up retrieved as written ("anything else?") comes back as "not found",
  because it names no document
- an off-topic question retrieved and refused comes back as "not found", claiming
  a gap in the corpus that is not there

No model and no network: the classifier is exercised through the two functions
that decide what it decides, and through an assistant whose `_complete` is a
scripted stub. The one thing deliberately not stubbed is retrieval, which is
replaced by something that records being called, because "did this reach
retrieval" is most of what is being asserted.
"""

import unittest

from app.rag.engine import (
    OUT_OF_SCOPE_MSG,
    Assistant,
    LlmUnavailable,
)
from app.rag.guard import (
    Category,
    build_classifier_prompt,
    parse_classification,
)


def recording_retriever(questions: list[str]):
    """A retriever that records what it was asked, so a caller can be caught."""

    class _Retriever:
        def retrieve(self, question: str):
            questions.append(question)
            return []

    return _Retriever()


def assistant_answering(replies: list[str], nodes=None) -> Assistant:
    """An assistant whose model answers `replies` in order, and nothing else.

    The classification call comes first, so for a message that is neither a
    greeting nor a personal-record question the first scripted reply is what the
    classifier is given.
    """
    assistant = Assistant.__new__(Assistant)
    assistant.retriever = recording_retriever([])
    assistant.asked: list[str] = []
    scripted = list(replies)

    def complete(user_prompt: str, system_prompt: str = "", max_tokens=None) -> str:
        assistant.asked.append(user_prompt)
        return scripted.pop(0) if scripted else scripted.append("") or ""

    def stream(user_prompt: str, system_prompt: str = ""):
        yield complete(user_prompt, system_prompt)

    assistant._complete = complete
    assistant._stream = stream
    assistant.retrieval = type("Retrieval", (), {"retrieve": staticmethod(lambda q: nodes or [])})()

    return assistant


def classification_reply(category: str, question: str) -> str:
    return f"CATEGORY: {category}\nQUESTION: {question}"


class ParseClassificationTest(unittest.TestCase):
    def test_reads_each_category_the_model_can_choose(self):
        for reply, expected in [
            (classification_reply("QUESTION", "How many sick days?"), Category.QUESTION),
            (classification_reply("FOLLOW_UP", "What else does it cover?"), Category.FOLLOW_UP),
            (classification_reply("OUT_OF_SCOPE", "How many presidents?"), Category.OUT_OF_SCOPE),
            (classification_reply("GREETING", "hello"), Category.GREETING),
        ]:
            with self.subTest(reply=reply):
                self.assertIs(parse_classification(reply, "anything").category, expected)

    def test_follow_up_keeps_the_rewritten_question(self):
        result = parse_classification(
            classification_reply(
                "FOLLOW_UP",
                "What else does the Code of Conduct document cover?",
            ),
            "anything else I should know?",
        )

        self.assertIs(result.category, Category.FOLLOW_UP)
        # The rewritten question is the whole point: retrieval cannot match
        # "anything else I should know?" against any document.
        self.assertEqual(result.query, "What else does the Code of Conduct document cover?")

    def test_reasoning_before_the_answer_is_skipped(self):
        reply = (
            "Let me consider whether this refers to the previous turn.\n"
            "CATEGORY: FOLLOW_UP\n"
            "QUESTION: What else does the leave policy say?"
        )

        result = parse_classification(reply, "and my sick leave?")

        self.assertIs(result.category, Category.FOLLOW_UP)
        self.assertEqual(result.query, "What else does the leave policy say?")

    def test_an_unusable_reply_is_treated_as_an_in_scope_question(self):
        # Every route out of here retrieves. Guessing `out_of_scope` on a reply
        # this code could not read would turn a model quirk into refused answers,
        # which is far worse than the extra search it costs.
        for reply in ["", "I am not sure.", "CATEGORY: SOMETHING_ELSE\nQUESTION: x"]:
            with self.subTest(reply=reply):
                result = parse_classification(reply, "How many sick days do I get?")
                self.assertIs(result.category, Category.QUESTION)
                self.assertEqual(result.query, "How many sick days do I get?")

    def test_a_missing_rewrite_keeps_the_original_message(self):
        result = parse_classification("CATEGORY: FOLLOW_UP", "and if I'm part-time?")

        self.assertIs(result.category, Category.FOLLOW_UP)
        self.assertEqual(result.query, "and if I'm part-time?")


class ClassifierPromptTest(unittest.TestCase):
    def test_history_is_included_oldest_first(self):
        prompt = build_classifier_prompt(
            "and if I'm part-time?",
            [
                ("user", "What does the leave policy say?"),
                ("assistant", "Full-time staff get 25 days."),
            ],
        )

        self.assertLess(prompt.index("What does the leave policy say?"), prompt.index("Full-time staff get 25 days."))
        self.assertLess(prompt.index("Full-time staff get 25 days."), prompt.index("and if I'm part-time?"))
        self.assertIn("Employee:", prompt)
        self.assertIn("Assistant:", prompt)

    def test_the_first_message_says_so(self):
        prompt = build_classifier_prompt("How many sick days do I get?", [])

        self.assertIn("first message", prompt)
        self.assertIn("How many sick days do I get?", prompt)


class RoutingTest(unittest.TestCase):
    """Each category, and what it does and does not reach."""

    def test_out_of_scope_never_retrieves_and_never_names_hr(self):
        asked: list[str] = []
        assistant = assistant_answering(
            [classification_reply("OUT_OF_SCOPE", "how many presidents has Ghana had?")]
        )
        assistant.retriever = recording_retriever(asked)

        done = list(
            assistant.ask_stream("how many presidents has Ghana had?", [("user", "hi")])
        )[-1]

        self.assertEqual(done["status"], "out-of-scope")
        self.assertFalse(done["answered"])
        self.assertEqual(done["sources"], [])
        self.assertEqual(done["answer"], OUT_OF_SCOPE_MSG)
        self.assertNotIn("hr@acmetech.example", done["answer"])
        self.assertNotIn("HR", done["answer"])
        # Nothing was retrieved: there is no answer to be found here, and reading
        # chunks to conclude that is what produced the wrong answer before.
        self.assertEqual(asked, [])

    def test_a_greeting_is_answered_without_the_classifier_or_retrieval(self):
        asked: list[str] = []
        assistant = assistant_answering([])
        assistant.retriever = recording_retriever(asked)

        events = list(assistant.ask_stream("hello"))

        self.assertEqual(events[-1]["status"], "greeting")
        # One prompt, and it is the greeting's own — not a classification call.
        self.assertEqual(len(assistant.asked), 1)
        self.assertEqual(asked, [])

    def test_a_personal_record_question_is_refused_without_retrieval(self):
        asked: list[str] = []
        assistant = assistant_answering([])
        assistant.retriever = recording_retriever(asked)

        done = list(assistant.ask_stream("how many leave days do I have left?"))[-1]

        self.assertEqual(done["status"], "restricted")
        self.assertEqual(asked, [])

    def test_an_in_scope_question_retrieves_the_message_unchanged(self):
        asked: list[str] = []
        assistant = assistant_answering([classification_reply("QUESTION", "How many sick days?")])
        assistant.retrieval = type(
            "Retrieval",
            (),
            {
                "retrieve": staticmethod(
                    lambda q: asked.append(q) or [
                        _candidate("Full-time staff may take 12 days of sick leave per year.")
                    ]
                )
            },
        )()

        list(assistant.ask_stream("How many sick days do I get?"))

        self.assertEqual(asked, ["How many sick days do I get?"])

    def test_a_follow_up_retrieves_the_rewritten_question(self):
        asked: list[str] = []
        assistant = assistant_answering(
            [
                classification_reply(
                    "FOLLOW_UP", "What else does the Code of Conduct document cover?"
                )
            ]
        )
        assistant.retrieval = type(
            "Retrieval",
            (),
            {
                "retrieve": staticmethod(
                    lambda q: asked.append(q) or [_candidate("Retaliation is prohibited.")]
                )
            },
        )()

        history = [
            ("user", "What does the Code of Conduct say about behaviour?"),
            ("assistant", "Communicate respectfully, be accountable."),
        ]
        events = list(assistant.ask_stream("anything else I should know?", history))

        # Retrieval got the standalone question, not the follow-up's wording.
        self.assertEqual(asked, ["What else does the Code of Conduct document cover?"])
        self.assertTrue(events[-1]["answered"])
        # And the generator was given the thread, so the answer continues it
        # rather than restating the previous turn. The question it answers is the
        # rewritten one, which is the point: "anything else I should know?" names
        # no document, and the previous question is what it was about.
        self.assertIn("What does the Code of Conduct say about behaviour?", assistant.asked[-1])
        self.assertIn("Question: What else does the Code of Conduct document cover?", assistant.asked[-1])

    def test_an_unreachable_classifier_degrades_to_the_ordinary_path(self):
        assistant = Assistant.__new__(Assistant)
        assistant.retriever = recording_retriever([])

        def broken(*args, **kwargs):
            raise LlmUnavailable("down")

        assistant._complete = broken
        assistant._stream = broken
        assistant.retrieval = type(
            "Retrieval", (), {"retrieve": staticmethod(lambda q: [])}
        )()

        done = list(assistant.ask_stream("How many sick days do I get?"))[-1]

        # Not an out-of-scope refusal: during an outage every question would be
        # told it was never in scope, which is a worse failure than the one the
        # classifier exists to prevent.
        self.assertNotEqual(done["status"], "out-of-scope")
        self.assertEqual(done["status"], "not-found")


def _candidate(text: str):
    """A retrieved chunk, as the retriever would produce one."""

    class _Node:
        node_id = text[:12]
        metadata = {"policy_title": "Leave Policy", "section": "Sick Leave"}
        score = 0.9

        def get_content(self, metadata_mode=None):
            return text

    class _Candidate:
        node = _Node()
        fused = 0.02
        similarity = 0.9
        keyword = None

    return _Candidate()


if __name__ == "__main__":
    unittest.main()
