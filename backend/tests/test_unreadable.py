"""A message nobody can read, and what it is answered with.

The problem this path exists for: "vdghgjkhh" used to be handed to the classifier
like any other message, come back as a question about nothing, and be reported as a
gap in the corpus. That is the worst possible answer to it — it claims the documents
do not cover a word sequence, tells the reader the documents are the problem, and
sends them to HR about their keyboard.

So a message like this is recognised before the classifier, before any rewrite and
before retrieval, and answered from a small pool that gets warmer and more useful
the more of them there are. No model call, no sources, no confidence, and never the
not-found frame: nothing was asked of the documents, so nothing can be said about
what they cover.

The other half of the risk is the opposite mistake, and it is the expensive one: a
false positive refuses to answer a real question. Every exemption below is that
half — acronyms, names, figures, pidgin, and any message with one familiar word in
it — and the tests pin them as carefully as the gibberish itself.

No model and no network: the model is scripted to prove it is not called.
"""

import unittest

from app.rag.capabilities import (
    PLEASANTRY_INVITATION,
    PLEASANTRY_REPLIES,
    SAMPLE_QUESTIONS,
    UNREADABLE_REPLIES,
    UNREADABLE_SECOND,
    UNREADABLE_THIRD,
)
from app.rag.engine import Assistant, PreviousAnswer
from app.rag.guard import is_laughter, is_obvious_conversational, is_unintelligible

GIBBERISH = ["vdghgjkhh", "asdfgh", "qwertyuiop", "jkljkl"]


def assistant() -> Assistant:
    """An assistant whose model records being asked and must not be.

    Both `_complete` and `_stream` are replaced, so any path that reaches the model
    at all fails the test rather than passing quietly.
    """
    instance = Assistant.__new__(Assistant)
    instance.asked: list[str] = []

    def complete(user_prompt: str, system_prompt: str = "", max_tokens=None) -> str:
        instance.asked.append(user_prompt)

        return "a generated reply nobody should see"

    def stream(user_prompt: str, system_prompt: str = "", max_tokens=None):
        yield complete(user_prompt, system_prompt, max_tokens)

    instance._complete = complete
    instance._stream = stream
    instance.retrieval = type(
        "Retrieval",
        (),
        {
            "retrieve": staticmethod(
                lambda query: (_ for _ in ()).throw(
                    AssertionError(f"retrieval must not run for {query!r}")
                )
            ),
            "retrieve_continuation": staticmethod(
                lambda query, documents, shown: (_ for _ in ()).throw(
                    AssertionError("and neither must a continuation")
                )
            ),
        },
    )()

    return instance


def previous(**fields) -> PreviousAnswer:
    return PreviousAnswer(**fields)


class UnreadableDetectionTest(unittest.TestCase):
    """What counts as a keyboard accident, and what emphatically does not."""

    def test_the_obvious_ones(self):
        for text in GIBBERISH:
            with self.subTest(text=text):
                self.assertTrue(is_unintelligible(text), text)

    def test_an_acronym_is_a_word_nobody_spells_out(self):
        for text in [
            "VPN",
            "HR",
            "IT",
            "MDM setup",
            "PTO policy",
            "WFH days",
            "SSO login",
            "2FA",
            "18",
        ]:
            with self.subTest(text=text):
                self.assertFalse(is_unintelligible(text), text)

    def test_casual_and_pidgin_english_is_english(self):
        # Somebody writing in the language they were taught at home is not typing
        # with their hands in the wrong place, and "chale" is in no dictionary.
        for text in [
            "abeg how do i set up VPN",
            "wetin be the leave policy",
            "chale how much leave do i get",
            "defo i can take leave?",
        ]:
            with self.subTest(text=text):
                self.assertFalse(is_unintelligible(text), text)

    def test_one_misspelt_word_in_an_ordinary_sentence_is_not_gibberish(self):
        for text in [
            "whats the leav policy",
            "how do i cliam parental leave",
            "vpn set up guid",
        ]:
            with self.subTest(text=text):
                self.assertFalse(is_unintelligible(text), text)

    def test_a_persons_name_is_not_a_mistyped_word(self):
        for text in ["Kpobi Tetteh", "ask for Ama Konadu", "my name is Kwame"]:
            with self.subTest(text=text):
                self.assertFalse(is_unintelligible(text), text)

    def test_a_real_question_is_never_flagged(self):
        for text in [
            "what is the leave policy?",
            "how do I set up the VPN",
            "how do I claim parental leave?",
            "who approves leave?",
            "what is the notice period?",
            "grievance",
            "tell me more",
            "anything else?",
        ]:
            with self.subTest(text=text):
                self.assertFalse(is_unintelligible(text), text)

    def test_laughter_is_recognised_before_this_check_ever_sees_it(self):
        # "hhhhh" is a run of letters no word list knows, and reading it as a
        # keyboard accident would answer a laugh with "did your keyboard slip?".
        # The order is what saves it, and it is pinned here so the order stays.
        for text in ["hhhhh", "hahaha", "lol", "kkkk", "jjjjj"]:
            with self.subTest(text=text):
                self.assertTrue(is_laughter(text), text)
                self.assertTrue(is_obvious_conversational(text), text)


class UnreadableReplyTest(unittest.TestCase):
    """What the reply is, and what it never is."""

    def ask(self, text: str, previous_answer: PreviousAnswer | None = None) -> dict:
        return list(assistant().ask_stream(text, previous=previous_answer))[-1]

    def test_the_first_one_is_warm_and_makes_no_model_call(self):
        for text in GIBBERISH:
            with self.subTest(text=text):
                instance = assistant()
                done = list(instance.ask_stream(text))[-1]

                self.assertEqual(done["kind"], "conversational")
                self.assertIn(done["answer"], UNREADABLE_REPLIES)
                self.assertEqual(instance.asked, [])
                self.assertEqual(done["sources"], [])
                self.assertIsNone(done["confidence"])

    def test_the_reply_is_never_the_failure_frame(self):
        for text in GIBBERISH:
            with self.subTest(text=text):
                answer = self.ask(text)["answer"].lower()

                # Nothing here may claim the documents came up short, send the
                # reader to HR, refuse them, or tell them the assistant does not
                # understand a *sentence* — which blames them for a keyboard.
                self.assertNotIn("documents", answer)
                self.assertNotIn("hr@", answer)
                self.assertNotIn("company policies, processes", answer)
                self.assertNotIn("doesn't make sense", answer)
                self.assertNotIn("!", answer)

    def test_the_second_one_offers_two_questions_the_documents_answer(self):
        done = self.ask("vdghgjkhh", previous(unreadable_streak=1, unreadable_seen=1))

        self.assertEqual(done["answer"], self.expected_second(1))
        self.assertIn(SAMPLE_QUESTIONS[1], done["answer"])
        self.assertIn(SAMPLE_QUESTIONS[2], done["answer"])

    def test_the_third_and_every_one_after_it_is_the_same_short_line(self):
        for streak in (2, 3, 9):
            with self.subTest(streak=streak):
                done = self.ask("vdghgjkhh", previous(unreadable_streak=streak))

                # Deliberately not escalating. Somebody typing into a box at the
                # wrong moment is not a problem to be solved.
                self.assertEqual(done["answer"], UNREADABLE_THIRD)

    def test_repeated_slips_alternate_the_first_reply(self):
        firsts = [
            self.ask("vdghgjkhh", previous(unreadable_seen=seen))["answer"]
            for seen in range(4)
        ]

        self.assertEqual(firsts[0], UNREADABLE_REPLIES[0])
        self.assertEqual(firsts[1], UNREADABLE_REPLIES[1])
        self.assertEqual(firsts[2], UNREADABLE_REPLIES[0])

    @staticmethod
    def expected_second(seen: int) -> str:
        return UNREADABLE_SECOND.format(
            first=SAMPLE_QUESTIONS[seen % len(SAMPLE_QUESTIONS)],
            second=SAMPLE_QUESTIONS[(seen + 1) % len(SAMPLE_QUESTIONS)],
        )

    def test_a_remark_after_an_answer_is_still_read_as_unreadable(self):
        # The point of running this before the context-dependent checks: a short
        # odd message typed after a real answer must not be rewritten into a
        # follow-up and retrieved as though it had asked something.
        topic = previous(
            has_topic=True,
            question="How much annual leave do I get?",
            answer="Full-time staff get 25 days.",
            documents=frozenset({"Leave Policy"}),
        )
        instance = assistant()

        done = list(instance.ask_stream("asdfgh", previous=topic))[-1]

        self.assertEqual(done["kind"], "conversational")
        self.assertIn(done["answer"], UNREADABLE_REPLIES)
        self.assertEqual(instance.asked, [])

    def test_laughter_is_answered_as_chat_and_not_as_a_mistake(self):
        for text in ["hhhhh", "hahaha", "lol", "😂😂"]:
            with self.subTest(text=text):
                instance = assistant()
                done = list(instance.ask_stream(text))[-1]

                self.assertEqual(done["kind"], "conversational")
                self.assertNotIn(done["answer"], UNREADABLE_REPLIES)
                self.assertIn(
                    done["answer"], (PLEASANTRY_INVITATION, *PLEASANTRY_REPLIES)
                )
                self.assertEqual(instance.asked, [])

    def test_the_invitation_is_offered_once_and_the_pool_rotates_after_it(self):
        instance = assistant()
        answers = [
            list(
                instance.ask_stream(
                    "hello", previous=previous(assistant_replies=turn)
                )
            )[-1]["answer"]
            for turn in range(5)
        ]

        self.assertEqual(answers[0], PLEASANTRY_INVITATION)
        self.assertNotIn(PLEASANTRY_INVITATION, answers[1:])

    def test_an_invitation_already_given_is_not_given_again(self):
        instance = assistant()
        answers = [
            list(
                instance.ask_stream(
                    "hello",
                    previous=previous(assistant_replies=turn, invitation_given=True),
                )
            )[-1]["answer"]
            for turn in range(4)
        ]

        self.assertNotIn(PLEASANTRY_INVITATION, answers)
        self.assertEqual(len(set(answers)), len(answers))


if __name__ == "__main__":
    unittest.main()