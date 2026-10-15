"""The confidentiality guard: what it refuses, and what it must not.

Two halves, and both are bugs if they move:

- A request for a specific person's private data is refused, whether the person is
  the asker or a colleague. It used to depend on retrieval finding something about
  that person, which it never does — the corpus holds policies, not payroll — so
  the refusal arrived as "not found in the company documents" instead, claiming a
  gap in the corpus and sending the reader to HR over a question HR would not
  answer either.
- A question about how the company's rules work is *not* refused, even when it
  contains the same nouns. A previous bug refused a plain compensation paraphrase,
  and a false refusal of an answerable question is the worse of the two errors:
  one costs a privacy boundary, the other costs the reader their answer.

No model and no network: the rules are exercised directly, and the classifier's
part is exercised through an assistant whose `_complete` is a scripted stub.
"""

import unittest

from app.rag.engine import PERSONAL_MSG, Assistant, PreviousAnswer
from app.rag.guard import (
    MODEL_CATEGORIES,
    Category,
    is_restricted_request,
    parse_classification,
)


def recording_retriever(questions: list[str]):
    """A retriever that records being asked, so "did this reach retrieval?" is pinned."""

    class _Retriever:
        def retrieve(self, question: str):
            questions.append(question)
            return []

    return _Retriever()


def assistant_answering(replies, nodes=None) -> Assistant:
    """An assistant whose model answers `replies` in order, and nothing else."""
    assistant = Assistant.__new__(Assistant)
    assistant.retriever = recording_retriever([])
    assistant.asked: list[str] = []
    scripted = list(replies)

    def complete(user_prompt: str, system_prompt: str = "", max_tokens=None) -> str:
        assistant.asked.append(user_prompt)
        return scripted.pop(0) if scripted else ""

    def stream(user_prompt: str, system_prompt: str = "", max_tokens=None):
        yield complete(user_prompt, system_prompt, max_tokens)

    assistant._complete = complete
    assistant._stream = stream
    assistant.retrieval = type(
        "Retrieval", (), {"retrieve": staticmethod(lambda q: nodes or [])}
    )()

    return assistant


def classification_reply(category: str, question: str) -> str:
    return f"CATEGORY: {category}\nQUESTION: {question}"


class RestrictedRuleTest(unittest.TestCase):
    """The rule layer: the phrasings worth refusing without asking anybody."""

    def test_a_named_persons_record_is_refused(self):
        for text in [
            "What is Ama Konadu's salary?",
            "what is kofi mensah's salary",
            "What is Kwame's bonus?",
            "How much is my colleague's bonus?",
            "What is her home address?",
            "What is my manager's appraisal?",
        ]:
            with self.subTest(text=text):
                self.assertTrue(is_restricted_request(text), text)

    def test_a_person_named_by_pronoun_or_role_is_refused(self):
        for text in [
            "his payslip",
            "her performance review",
            "their termination process",
            "did he get a bonus last quarter",
            "what rating did my colleague get",
            "is my colleague on a performance improvement plan?",
        ]:
            with self.subTest(text=text):
                self.assertTrue(is_restricted_request(text), text)

    def test_a_named_person_receiving_something_is_refused(self):
        # The record noun is often missing: this is the shape most of these
        # questions actually arrive in.
        for text in [
            "Does Ama get paid more than me?",
            "how much does Kwame earn",
            "has Kwame been terminated",
            "why was Kofi suspended",
            "did Ama resign",
        ]:
            with self.subTest(text=text):
                self.assertTrue(is_restricted_request(text), text)

    def test_a_passive_about_someone_is_refused(self):
        for text in [
            "who is being investigated",
            "was she terminated last year",
            "is there a grievance against my colleague",
            "why is she on sick leave",
            "what is Kwame's medical record",
        ]:
            with self.subTest(text=text):
                self.assertTrue(is_restricted_request(text), text)

    def test_the_askers_own_records_are_still_refused(self):
        for text in [
            "what is my salary",
            "what is my payslip",
            "how many leave days do I have left",
            "how many sick days do I have remaining",
            "what is my tax situation",
        ]:
            with self.subTest(text=text):
                self.assertTrue(is_restricted_request(text), text)


class PolicyLevelTest(unittest.TestCase):
    """What must stay answerable, because the guard is about people, not rules."""

    def test_questions_about_how_the_rules_work_are_not_refused(self):
        for text in [
            "how is salary determined",
            "when is salary paid",
            "can I receive my salary before the due date",
            "what are the leave entitlements",
            "how do I request a salary review",
            "what does the compensation policy cover",
            "how does the company's salary review process work",
            "how does bonus accrual work",
            "what is the policy on sick pay",
            "who approves a bonus",
            "how is performance reviewed",
            "what is the disciplinary procedure",
            "how do I report misconduct at work",
            "how much notice do I get",
            "who handles disciplinary cases",
        ]:
            with self.subTest(text=text):
                self.assertFalse(is_restricted_request(text), text)

    def test_a_company_is_not_a_person(self):
        # The possessive shape is identical, and reading "the company's salary" as
        # a person's salary would refuse the compensation policy itself.
        for text in [
            "how does the company's salary policy work",
            "what is the organisation's disciplinary process",
            "what does the department's leave policy cover",
        ]:
            with self.subTest(text=text):
                self.assertFalse(is_restricted_request(text), text)

    def test_a_statement_about_a_scheme_is_not_a_statement_about_a_person(self):
        for text in [
            "are employees paid monthly",
            "is there a bonus scheme",
            "they are on annual leave",
            "what is in the Code of Conduct about sick pay",
            "the bonus is awarded to all colleagues each December",
        ]:
            with self.subTest(text=text):
                self.assertFalse(is_restricted_request(text), text)

    def test_an_ordinary_policy_question_is_not_refused(self):
        # The regression this whole file is careful about: refusing a normal
        # question is worse for the reader than missing one.
        for text in [
            "what are the company expectations for employees",
            "how much annual leave do I get per year",
            "what are the HR contact details",
            "how do I set up VPN access",
            "what does the onboarding policy cover",
        ]:
            with self.subTest(text=text):
                self.assertFalse(is_restricted_request(text), text)


class GuardBeforeRetrievalTest(unittest.TestCase):
    """The refusal must not depend on what retrieval found."""

    def test_a_colleagues_salary_never_reaches_retrieval(self):
        asked: list[str] = []
        assistant = assistant_answering([])
        assistant.retrieval = type(
            "Retrieval", (), {"retrieve": staticmethod(lambda q: asked.append(q) or [])}
        )()

        done = list(assistant.ask_stream("What is Ama Konadu's salary?"))[-1]

        self.assertEqual(done["kind"], "restricted")
        self.assertEqual(done["answer"], PERSONAL_MSG)
        self.assertEqual(asked, [])
        self.assertEqual(done["sources"], [])
        self.assertIsNone(done["confidence"])
        # And no model call at all: the rules caught it.
        self.assertEqual(assistant.asked, [])

    def test_the_refusal_confirms_nothing_about_the_person(self):
        assistant = assistant_answering([])
        assistant.retrieval = type(
            "Retrieval", (), {"retrieve": staticmethod(lambda q: [])}
        )()

        done = list(assistant.ask_stream("what is Kwame's bonus?"))[-1]

        # No existence, no absence, and nothing from the documents.
        for needle in ("no record", "does not exist", "we have no", "documents"):
            with self.subTest(needle=needle):
                self.assertNotIn(needle, done["answer"].lower())
        self.assertIn("hr@acmetech.example", done["answer"])

    def test_a_rewritten_follow_up_is_guarded_too(self):
        # The message looks harmless and the query does not: "and his bonus?" is
        # rewritten into a clean-looking question about a person, and a guard that
        # only ever saw the original wording would let that one through.
        asked: list[str] = []
        assistant = assistant_answering(
            [classification_reply("FOLLOW_UP", "What is Kwame Mensah's bonus?")]
        )
        assistant.retrieval = type(
            "Retrieval", (), {"retrieve": staticmethod(lambda q: asked.append(q) or [])}
        )()

        history = [
            ("user", "What is the compensation policy?"),
            ("assistant", "The policy sets bands and review dates."),
        ]
        done = list(assistant.ask_stream("and his bonus?", history))[-1]

        self.assertEqual(done["kind"], "restricted")
        self.assertEqual(asked, [])

    def test_a_follow_up_to_a_refusal_is_a_refusal(self):
        assistant = assistant_answering([classification_reply("FOLLOW_UP", "And for part-timers?")])
        assistant.retrieval = type(
            "Retrieval", (), {"retrieve": staticmethod(lambda q: [])}
        )()

        previous = PreviousAnswer(kind="restricted", question="What is Kwame's salary?")
        done = list(
            assistant.ask_stream("and what about his bonus?", [], previous=previous)
        )[-1]

        self.assertEqual(done["kind"], "restricted")

    def test_an_expansion_after_a_refusal_stays_a_refusal(self):
        assistant = assistant_answering([])
        assistant.retrieval = type(
            "Retrieval", (), {"retrieve": staticmethod(lambda q: [])}
        )()

        previous = PreviousAnswer(kind="restricted", question="What is Kwame's salary?")
        done = list(assistant.ask_stream("anything else?", [], previous=previous))[-1]

        # Even though the fast path read it as an expansion: there are no passages
        # behind a refusal, and the reader is not being offered "that covers
        # everything" about a topic they were never told.
        self.assertEqual(done["kind"], "restricted")

    def test_a_fresh_question_after_a_refusal_is_not_one(self):
        asked: list[str] = []
        assistant = assistant_answering([classification_reply("COMPANY_QUESTION", "What is the leave policy?")])
        assistant.retrieval = type(
            "Retrieval", (), {"retrieve": staticmethod(lambda q: asked.append(q) or [])}
        )()

        previous = PreviousAnswer(kind="restricted", question="What is Kwame's salary?")
        done = list(
            assistant.ask_stream("What is the leave policy?", [], previous=previous)
        )[-1]

        self.assertNotEqual(done["kind"], "restricted")


class GuardBackstopTest(unittest.TestCase):
    """The model is the half the patterns cannot be."""

    def test_a_rephrasing_the_rules_miss_is_caught_by_the_model(self):
        # No possessive, no capitalised name before a record noun, no known verb:
        # "how much does Kofi bank" is the same request in different words, and the
        # rules deliberately do not try to catch it. This is what the classifier's
        # RESTRICTED exists for.
        self.assertFalse(is_restricted_request("how much does Kofi bank"))

        assistant = assistant_answering(
            [classification_reply("RESTRICTED", "How much does Kofi bank?")]
        )
        assistant.retrieval = type(
            "Retrieval", (), {"retrieve": staticmethod(lambda q: [])}
        )()

        done = list(assistant.ask_stream("how much does Kofi bank?"))[-1]

        self.assertEqual(done["kind"], "restricted")

    def test_the_model_cannot_make_a_policy_question_restricted_by_its_rewrite(self):
        # The rewrite is guarded, not just the message: a model that rewrites a
        # policy question into "What is Ama's salary?" is caught by the same rule.
        assistant = assistant_answering(
            [classification_reply("FOLLOW_UP", "What is the salary review process?")]
        )
        assistant.retrieval = type(
            "Retrieval", (), {"retrieve": staticmethod(lambda q: [])}
        )()

        done = list(
            assistant.ask_stream("and mine?", [("user", "How is salary determined?")])
        )[-1]

        self.assertNotEqual(done["kind"], "restricted")

    def test_an_unreadable_classifier_reply_still_retrieves(self):
        assistant = assistant_answering(["CATEGORY: NONSENSE\nQUESTION: x"])
        assistant.retrieval = type(
            "Retrieval", (), {"retrieve": staticmethod(lambda q: [])}
        )()

        done = list(assistant.ask_stream("What is the leave policy?"))[-1]

        # Never a refusal by default: a classifier quirk must not refuse an
        # answerable question, and the guard's own rules have already had their say.
        self.assertNotEqual(done["kind"], "restricted")

    def test_restricted_is_among_the_categories_the_model_may_choose(self):
        self.assertIn(Category.RESTRICTED.value, MODEL_CATEGORIES)


class ParseRestrictedTest(unittest.TestCase):
    def test_the_restricted_category_is_read(self):
        result = parse_classification(
            classification_reply("RESTRICTED", "What is Kofi's salary?"),
            "what is the salary of a colleague?",
        )

        self.assertIs(result.category, Category.RESTRICTED)

    def test_an_unknown_restricted_spelling_falls_back_to_a_question(self):
        # Same rule as every other unreadable verdict: retrieve rather than refuse.
        result = parse_classification("CATEGORY: PRIVATE\nQUESTION: x", "What is Kofi's salary?")

        self.assertIs(result.category, Category.COMPANY_QUESTION)


if __name__ == "__main__":
    unittest.main()