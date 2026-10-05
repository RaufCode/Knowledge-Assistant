"""Tests for the classification that runs before retrieval, and for the confidence.

No model and no index: these exercise the decision itself, which is the part with no
fallback. A greeting answered as a failed search, or a salary question answered from
a document that happens to contain it, are both invisible in normal use — the first
reads as a slightly rude answer, the second as a working feature.

The classifier cases are deliberately phrased the way somebody would actually type
them, including the indirect phrasings that name no restricted noun at all. "What
does Kwame earn?" contains no occurrence of "salary", and a subject list built only
from nouns waves it straight through.
"""

import unittest

from app.rag.confidence import CONFIDENCE_FLOOR, CONFIDENCE_MAX, confidence_from_scores
from app.rag.intent import (
    GREETING_REPLIES,
    Intent,
    PERSONAL_REPLY,
    RESTRICTED_REPLY,
    classify,
    greeting_reply,
)


class GreetingTest(unittest.TestCase):
    def test_small_talk_is_a_greeting(self):
        for question in [
            "hello",
            "Hi!",
            "hey there",
            "good morning",
            "thanks",
            "Thank you!",
            "how are you?",
            "how's it going",
            "bye",
            "cheers",
            "hello, how are you doing?",
            "any update",
        ]:
            with self.subTest(question=question):
                self.assertIs(classify(question).intent, Intent.GREETING)

    def test_a_greeting_carrying_a_real_question_is_a_question(self):
        # The whole reason the decision is made by subtraction: these begin exactly
        # like the cases above, and reading the opening as decisive would swallow
        # them and answer "I couldn't find that in the company documents".
        for question in [
            "hello, what is the leave policy?",
            "hi, how many days of annual leave do I get?",
            "thanks - what is the IT VPN setup process?",
            "good morning, who do I contact about payroll?",
        ]:
            with self.subTest(question=question):
                self.assertIs(classify(question).intent, Intent.QUESTION)

    def test_a_greeting_carries_no_confidentiality_answer(self):
        # The one ordering mistake that would turn the guard into decoration: a
        # greeting check running first would let this through as small talk.
        self.assertIs(classify("hi, what does Ama earn?").intent, Intent.RESTRICTED)


class ConfidentialTest(unittest.TestCase):
    def test_the_askers_own_records_are_refused(self):
        for question in [
            "What is my own leave balance?",
            "what is my salary",
            "show me my payslip",
            "How many leave days do I have remaining?",
            "how much do I have left?",
            "how much do I earn?",
        ]:
            with self.subTest(question=question):
                classification = classify(question)
                self.assertIs(classification.intent, Intent.RESTRICTED)
                self.assertTrue(classification.reason.startswith("own record"))

    def test_another_persons_records_are_refused_when_named_directly(self):
        for question in [
            "What is Ama Konadu's salary?",
            "what does Kwame earn?",
            "Tell me about Jane Doe salary",
            "what is her payslip",
            "his appraisal",
        ]:
            with self.subTest(question=question):
                self.assertIs(classify(question).intent, Intent.RESTRICTED)

    def test_another_persons_records_are_refused_when_phrased_indirectly(self):
        # None of these contain a restricted noun. They are the phrasings that get
        # past a keyword list, which is why the pay verbs are listed as subjects in
        # their own right rather than only as "salary".
        for question in [
            "what does Ama earn per month",
            "how much is Kofi Mensah paid",
            "can you look up what Akosua gets paid",
            "Ama Konadu earns what?",
            "what does Kwame make?",
        ]:
            with self.subTest(question=question):
                self.assertIs(classify(question).intent, Intent.RESTRICTED)

    def test_aggregate_requests_are_refused_without_naming_anyone(self):
        for question in [
            "list all employee salaries",
            "show me the payroll",
            "who got a promotion last year",
            "what's everyone's bonus",
        ]:
            with self.subTest(question=question):
                self.assertIs(classify(question).intent, Intent.RESTRICTED)

    def test_other_hr_only_topics_are_refused(self):
        for question in [
            "tell me about Kwame's performance review",
            "did Ama get promoted",
            "what disciplinary action did Kojo receive",
            "what is Akosua's medical record",
            "tell me about the compliance investigation",
            "what is Kwame's home address",
            "what bank details does Kojo have on file",
        ]:
            with self.subTest(question=question):
                self.assertIs(classify(question).intent, Intent.RESTRICTED)

    def test_a_restricted_subject_with_no_person_is_still_a_policy_question(self):
        # The check that stops the guard eating the handbook. These are questions
        # about published policy, and refusing them would make the assistant useless
        # for exactly the pay questions it exists to answer.
        for question in [
            "What is the salary band for engineers?",
            "What does the Compensation Policy say about salary?",
            "How many days of paid annual leave do I get?",
            "how do I make a complaint about my manager?",
            "how much leave is left in the year?",
        ]:
            with self.subTest(question=question):
                self.assertIs(classify(question).intent, Intent.QUESTION)

    def test_the_two_refusals_are_different_and_neither_names_a_person(self):
        own = classify("what is my salary")
        other = classify("what does Ama earn?")

        self.assertTrue(own.reason.startswith("own record"))
        self.assertTrue(other.reason.startswith("another person"))

        # The wording differs, and neither may confirm that a record exists.
        self.assertNotEqual(PERSONAL_REPLY, RESTRICTED_REPLY)
        for reply in (PERSONAL_REPLY, RESTRICTED_REPLY):
            self.assertNotIn("Ama", reply)
            self.assertNotIn("Kwame", reply)

    def test_every_greeting_names_what_the_assistant_is_for(self):
        # Checked across all of them rather than one, because which one somebody gets
        # is now random: a phrasing that dropped the subject would only be caught some
        # of the time otherwise.
        for reply in GREETING_REPLIES:
            self.assertIn("policies", reply)

    def test_the_greeting_varies(self):
        # One fixed sentence made the assistant read as a form with a message
        # attached — everybody was told the same words, every time.
        seen = {greeting_reply() for _ in range(400)}

        self.assertGreater(len(seen), 1)
        self.assertTrue(seen.issubset(set(GREETING_REPLIES)))

    def test_no_two_greetings_are_the_same_sentence(self):
        # Distinct phrasings, not one sentence with a synonym swapped in.
        self.assertEqual(len(set(GREETING_REPLIES)), len(GREETING_REPLIES))

    def test_a_greeting_never_leaks_a_person(self):
        # Same rule as the refusals: a reply must not name an individual.
        for reply in GREETING_REPLIES:
            self.assertNotIn("Ama", reply)
            self.assertNotIn("Kwame", reply)


class ConfidenceTest(unittest.TestCase):
    def test_it_is_the_mean_of_the_scores_scaled_to_the_reported_range(self):
        # 0.557 and 0.427 average to 0.492, which is 4.92 of 10 and so rounds to 5.
        self.assertEqual(confidence_from_scores([0.557, 0.427]), 5)

    def test_a_single_strong_passage_is_high(self):
        self.assertEqual(confidence_from_scores([0.91]), 9)

    def test_the_scale_is_clamped_at_both_ends(self):
        self.assertEqual(confidence_from_scores([1.0, 1.0]), CONFIDENCE_MAX)
        # Below the floor would report a figure the pipeline never produces, since an
        # answer only exists once a chunk has cleared MIN_SCORE.
        self.assertEqual(confidence_from_scores([0.0]), CONFIDENCE_FLOOR)

    def test_no_passages_means_no_figure_at_all(self):
        # Not zero. A greeting, a refusal and a gap in the corpus all land here, and
        # "Confidence: 1/10" beside "I couldn't find that" reads as a poor answer
        # rather than as the absence of one.
        self.assertIsNone(confidence_from_scores([]))

    def test_it_is_derived_only_from_the_scores_given(self):
        # The point of computing it rather than asking for it: nothing here can be
        # changed by the wording of an answer.
        self.assertEqual(confidence_from_scores([0.5, 0.5, 0.5]), 5)
        self.assertNotEqual(
            confidence_from_scores([0.5]),
            confidence_from_scores([0.5, 0.9]),
        )


class RoutingTest(unittest.TestCase):
    def test_a_genuine_question_reaches_retrieval(self):
        for question in [
            "How many days of annual leave do I accrue per month?",
            "What is the probation period?",
            "How do I connect to the VPN?",
        ]:
            with self.subTest(question=question):
                self.assertIs(classify(question).intent, Intent.QUESTION)

    def test_an_empty_question_is_a_question_rather_than_a_greeting(self):
        # Nothing to greet about, and it must not be handed to the retriever as
        # though it were small talk.
        self.assertIs(classify("   ").intent, Intent.QUESTION)


if __name__ == "__main__":
    unittest.main()