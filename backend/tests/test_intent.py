"""Which of the five paths a message takes, decided before retrieval.

The categories matter because they are not variations on one answer — they are
different answers, and getting one wrong is a bug a person can see:

- a remark that is not a request ("there is no question") routed as a question
  comes back as "not found in the documents", which claims a gap in the corpus
  over a sentence that asked for nothing
- the same remark routed as out-of-scope is refused, which claims even more: that
  there is no policy on the subject, and sends the reader looking for one
- a follow-up retrieved as written ("anything else?") comes back as "not found",
  because it names no document
- an off-topic question retrieved and refused comes back as "not found", claiming
  a gap in the corpus that is not there

`not_found` is therefore produced by exactly one path, and these tests pin that as
much as they pin the routing: anything that is not a genuine in-scope question
coming back with that frame is the bug this whole arrangement exists to prevent.

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
    MODEL_CATEGORIES,
    Category,
    build_classifier_prompt,
    parse_classification,
)
from app.rag.retrieval import CONFIDENCE_MAX


def recording_retriever(questions: list[str]):
    """A retriever that records what it was asked, so a caller can be caught."""

    class _Retriever:
        def retrieve(self, question: str):
            questions.append(question)
            return []

    return _Retriever()


def assistant_answering(replies: list[str], nodes=None) -> Assistant:
    """An assistant whose model answers `replies` in order, and nothing else.

    The classification call comes first, so for a message that no rule decides on
    its own the first scripted reply is what the classifier is given.
    """
    assistant = Assistant.__new__(Assistant)
    assistant.retriever = recording_retriever([])
    assistant.asked: list[str] = []
    scripted = list(replies)

    def complete(user_prompt: str, system_prompt: str = "", max_tokens=None) -> str:
        assistant.asked.append(user_prompt)
        return scripted.pop(0) if scripted else scripted.append("") or ""

    def stream(user_prompt: str, system_prompt: str = "", max_tokens=None):
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
            (classification_reply("COMPANY_QUESTION", "How many sick days?"), Category.COMPANY_QUESTION),
            (classification_reply("FOLLOW_UP", "What else does it cover?"), Category.FOLLOW_UP),
            (classification_reply("OUT_OF_SCOPE", "How many presidents?"), Category.OUT_OF_SCOPE),
            (classification_reply("CONVERSATIONAL", "there is no question"), Category.CONVERSATIONAL),
            # Spelled the way the model often spells them, which has to survive the
            # same schema as the canonical spelling.
            (classification_reply("follow up", "What else?"), Category.FOLLOW_UP),
            (classification_reply("OUT OF SCOPE", "Tell me a joke"), Category.OUT_OF_SCOPE),
        ]:
            with self.subTest(reply=reply):
                self.assertIs(parse_classification(reply, "anything").category, expected)

    def test_the_model_is_offered_the_guard_as_a_backstop(self):
        # Name patterns are bypassed by rephrasing, so the model is offered
        # RESTRICTED as well: the rules run first and cannot be talked out of, and
        # the model decides the phrasings nobody thought of.
        self.assertIn(Category.RESTRICTED.value, MODEL_CATEGORIES)
        self.assertIn(Category.EXPANSION.value, MODEL_CATEGORIES)
        self.assertEqual(len(MODEL_CATEGORIES), 6)

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
        for reply in [
            "",
            "I am not sure.",
            "CATEGORY: SOMETHING_ELSE\nQUESTION: x",
            "CATEGORY:\nQUESTION: x",
            "CATEGORY: maybe\nQUESTION: x",
        ]:
            with self.subTest(reply=reply):
                result = parse_classification(reply, "How many sick days do I get?")
                self.assertIs(result.category, Category.COMPANY_QUESTION)
                self.assertEqual(result.query, "How many sick days do I get?")

    def test_a_missing_rewrite_keeps_the_original_message(self):
        result = parse_classification("CATEGORY: FOLLOW_UP", "and if I'm part-time?")

        self.assertIs(result.category, Category.FOLLOW_UP)
        self.assertEqual(result.query, "and if I'm part-time?")

    def test_a_rewrite_that_stopped_mid_sentence_is_not_used(self):
        # The classifier is a reasoning model with an output budget, and a reply
        # that ran out mid-line leaves a fragment. Retrieving that fragment matches
        # nothing, and the generator left with whatever was nearest answers it
        # confidently — so the message is kept instead.
        result = parse_classification(
            "CATEGORY: FOLLOW_UP\nQUESTION: What else does the",
            "anything else I should know?",
        )

        self.assertIs(result.category, Category.FOLLOW_UP)
        self.assertEqual(result.query, "anything else I should know?")

    def test_a_rewrite_that_ends_a_sentence_is_used(self):
        for rewrite, expected in [
            ("What else does the Code of Conduct document cover?", "What else does the Code of Conduct document cover?"),
            ("What else does the Code of Conduct document cover.", "What else does the Code of Conduct document cover."),
            # A quoted rewrite is cleaned before it is read, which is what makes the
            # trailing quote in the third case land outside the sentence.
            ('What else does the leave policy say?"', "What else does the leave policy say?"),
        ]:
            with self.subTest(rewrite=rewrite):
                result = parse_classification(
                    f"CATEGORY: FOLLOW_UP\nQUESTION: {rewrite}", "anything else?"
                )
                self.assertEqual(result.query, expected)


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

    def test_the_rules_say_out_of_scope_needs_a_request(self):
        # The instruction the bug turned on: a statement that asks for nothing has
        # to be told apart from a request that happens to be unrelated.
        from app.rag.guard import CLASSIFIER_SYSTEM_PROMPT

        self.assertIn("OUT_OF_SCOPE requires an actual request", CLASSIFIER_SYSTEM_PROMPT)
        self.assertIn("never by punctuation", CLASSIFIER_SYSTEM_PROMPT)
        self.assertIn("CONVERSATIONAL — anything that is not a request", CLASSIFIER_SYSTEM_PROMPT)


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

        self.assertEqual(done["kind"], "out_of_scope")
        self.assertEqual(done["status"], "out-of-scope")
        self.assertFalse(done["answered"])
        self.assertEqual(done["sources"], [])
        self.assertEqual(done["answer"], OUT_OF_SCOPE_MSG)
        self.assertNotIn("hr@acmetech.example", done["answer"])
        self.assertNotIn("HR", done["answer"])
        # Nothing was retrieved: there is no answer to be found here, and reading
        # chunks to conclude that is what produced the wrong answer before.
        self.assertEqual(asked, [])

    def test_a_conversation_is_never_a_failed_search(self):
        # The reported bug: a message that is not a request came back wearing the
        # "not found in company documents" frame and its rephrasing hint.
        asked: list[str] = []
        assistant = assistant_answering(
            [
                classification_reply("CONVERSATIONAL", "there is no question"),
                "You're right, no question yet. Whenever you're ready, ask me anything.",
            ]
        )
        assistant.retriever = recording_retriever(asked)

        events = list(
            assistant.ask_stream(
                "there is no question",
                [("user", "Hey"), ("assistant", "Hello! Ask me anything.")],
            )
        )

        done = events[-1]
        self.assertEqual(done["kind"], "conversational")
        # The frame is the whole point, so it is asserted as an absence rather than
        # by checking one wording: nothing here may claim the documents came up
        # short, and nothing may route the reader to HR for a missing policy.
        self.assertNotIn("documents", done["answer"])
        self.assertNotIn("HR", done["answer"])
        self.assertEqual(done["sources"], [])
        self.assertIsNone(done["confidence"])
        self.assertEqual(asked, [])
        # Streamed like an answer, so the exchange feels the same either way.
        self.assertEqual(
            [event["type"] for event in events], ["status", "delta", "done"]
        )

    def test_an_acknowledgement_neither_retrieves_nor_reaches_the_classifier(self):
        asked: list[str] = []
        assistant = assistant_answering([])
        assistant.retriever = recording_retriever(asked)

        done = list(assistant.ask_stream("ok"))[-1]

        self.assertEqual(done["kind"], "conversational")
        self.assertEqual(asked, [])
        # Exactly one model call, and it is the reply itself. A second one would
        # have been the classifier, which the rules made unnecessary: the point of
        # the fast path is that "ok" costs a reply and not a round trip on top of it.
        self.assertEqual(len(assistant.asked), 1)

    def test_a_personal_record_question_is_refused_without_retrieval(self):
        asked: list[str] = []
        assistant = assistant_answering([])
        assistant.retriever = recording_retriever(asked)

        done = list(assistant.ask_stream("how many leave days do I have left?"))[-1]

        self.assertEqual(done["kind"], "restricted")
        self.assertEqual(asked, [])

    def test_an_in_scope_question_retrieves_the_message_unchanged(self):
        asked: list[str] = []
        assistant = assistant_answering([classification_reply("COMPANY_QUESTION", "How many sick days?")])
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

        events = list(assistant.ask_stream("How many sick days do I get?"))

        self.assertEqual(asked, ["How many sick days do I get?"])
        self.assertEqual(events[-1]["kind"], "answer")
        self.assertEqual(events[-1]["confidence"], CONFIDENCE_MAX)

    def test_a_topic_shifting_follow_up_retrieves_the_rewritten_question(self):
        asked: list[str] = []
        assistant = assistant_answering(
            [
                classification_reply(
                    "FOLLOW_UP", "What does the Code of Conduct say about contractors?"
                ),
                "Contractors are held to the same standard.",
            ]
        )
        assistant.retrieval = type(
            "Retrieval",
            (),
            {
                "retrieve": staticmethod(
                    lambda q: asked.append(q) or [_candidate("Contractors are held to the same standard.")]
                )
            },
        )()

        history = [
            ("user", "What does the Code of Conduct say about behaviour?"),
            ("assistant", "Communicate respectfully, be accountable."),
        ]
        events = list(assistant.ask_stream("what about contractors?", history))

        # Retrieval got the standalone question, not the follow-up's wording.
        self.assertEqual(
            asked, ["What does the Code of Conduct say about contractors?"]
        )
        self.assertEqual(events[-1]["kind"], "answer")
        self.assertTrue(events[-1]["answered"])
        # And the generator was given the thread, so the answer continues it
        # rather than restating the previous turn. The question it answers is the
        # rewritten one, which is the point: "what about contractors?" names no
        # document, and the previous question is what it was about.
        self.assertIn("What does the Code of Conduct say about behaviour?", assistant.asked[-1])
        self.assertIn(
            "Question: What does the Code of Conduct say about contractors?",
            assistant.asked[-1],
        )

    def test_only_a_real_question_with_no_support_is_not_found(self):
        # One path may say the documents do not cover this, and it is the path that
        # has actually read them.
        for category, message, replies in [
            ("OUT_OF_SCOPE", "tell me a joke", [""] * 2),
            ("CONVERSATIONAL", "I was just saying hi", ["Sure, whenever you're ready."]),
            ("COMPANY_QUESTION", "What is the dental policy?", ["NOT_FOUND"]),
            ("FOLLOW_UP", "anything else?", ["NOT_FOUND"]),
        ]:
            asked: list[str] = []
            assistant = assistant_answering(
                [classification_reply(category, message), *replies]
            )
            assistant.retrieval = type(
                "Retrieval", (), {"retrieve": staticmethod(lambda q: asked.append(q) or [])}
            )()

            done = list(assistant.ask_stream(message, [("user", "What does the leave policy say?")]))[-1]

            with self.subTest(category=category):
                expected = "not_found" if category in {"COMPANY_QUESTION", "FOLLOW_UP"} else category.lower()
                self.assertEqual(done["kind"], expected)
                if expected != "not_found":
                    self.assertNotEqual(done["kind"], "not_found")

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
        self.assertNotEqual(done["kind"], "out_of_scope")
        self.assertEqual(done["kind"], "not_found")

    def test_a_caller_may_pass_its_own_classification_in(self):
        # The route classifies once and uses the result twice: for the reply, and
        # for whether the conversation is worth naming. Asking again would be a
        # second model call for a decision already made.
        from app.rag.guard import Classification

        asked: list[str] = []
        assistant = assistant_answering([])
        assistant.retrieval = type(
            "Retrieval", (), {"retrieve": staticmethod(lambda q: asked.append(q) or [])}
        )()

        done = list(
            assistant.ask_stream(
                "how many presidents has Ghana had?",
                [],
                Classification(Category.OUT_OF_SCOPE, "how many presidents has Ghana had?"),
            )
        )[-1]

        self.assertEqual(done["kind"], "out_of_scope")
        self.assertEqual(assistant.asked, [])


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