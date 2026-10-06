"""The confidence figure, and that it is derived from retrieval rather than guesswork.

The client already renders `Confidence: N/10` and describes it as "how closely the
indexed passages matched your question" — not a probability of being right. These
pin the two things that description depends on: that the number comes from the
retrieved similarity, and that it stays inside the range it claims to.

The anchors are measurements, not choices, so the cases are stated as the
similarities that were actually observed on this corpus rather than as round
numbers that would pass against any scale.
"""

import unittest

from app.rag.retrieval import (
    CONFIDENCE_HIGH_SIMILARITY,
    CONFIDENCE_LOW_SIMILARITY,
    CONFIDENCE_MAX,
    CONFIDENCE_MIN,
    Candidate,
    retrieval_confidence,
)


def candidate(similarity: float | None) -> Candidate:
    return Candidate(node=object(), fused=0.016, similarity=similarity, keyword=None)


class ConfidenceScaleTest(unittest.TestCase):
    def test_it_is_always_inside_the_range_the_client_renders(self):
        # The client renders `score/10` and casts nothing, so a 0, an 11 or a
        # float would all show as something it is not.
        for similarity in [
            0.0, 0.01, 0.149, 0.15, 0.222, 0.307, 0.40, 0.442, 0.555, 0.669,
            0.70, 0.85, 1.0, 1.5,
        ]:
            with self.subTest(similarity=similarity):
                score = retrieval_confidence([candidate(similarity)])
                self.assertIsInstance(score, int)
                self.assertGreaterEqual(score, CONFIDENCE_MIN)
                self.assertLessEqual(score, CONFIDENCE_MAX)

    def test_a_clear_match_scores_high(self):
        self.assertGreaterEqual(retrieval_confidence([candidate(0.669)]), 9)

    def test_the_similarity_floor_scores_mid_range_not_high(self):
        # The point of anchoring the scale where it is. A chunk that only just
        # cleared `min_score` matched in the middle of the range, and reporting 9
        # would be a flattering lie — the client already warns that this number
        # reads lower than people expect, which is only honest if it is.
        score = retrieval_confidence([candidate(0.40)])

        self.assertGreaterEqual(score, 4)
        self.assertLessEqual(score, 6)

    def test_a_rescued_chunk_reports_a_low_confidence_rather_than_none(self):
        # Sub-floor but real. `grievance` scores 0.149 on the chunk that answers
        # it; a low figure is the truth about that match, and no figure at all
        # would throw away the only signal that it was marginal.
        score = retrieval_confidence([candidate(0.149)])

        self.assertIsNotNone(score)
        self.assertLessEqual(score, 2)

    def test_it_reads_the_best_chunk_not_an_average(self):
        # Retrieval is best-of-the-set by construction. Averaging would let four
        # mediocre chunks drag down one that matched well, which is the chunk that
        # makes the answer good.
        best_only = retrieval_confidence([candidate(0.60)])
        buried = retrieval_confidence([candidate(0.60), candidate(0.20), candidate(0.21)])

        self.assertEqual(best_only, buried)

    def test_nothing_retrieved_means_no_figure_rather_than_a_low_one(self):
        # There were no passages to be confident about, which is a different thing
        # from matching badly. The caller uses None for exactly the turns that
        # cite nothing, and a number there would describe evidence that is absent.
        self.assertIsNone(retrieval_confidence([]))
        self.assertIsNone(retrieval_confidence([candidate(None)]))
        self.assertIsNone(retrieval_confidence([candidate(None), candidate(None)]))


class ConfidenceAnchorTest(unittest.TestCase):
    def test_the_anchors_bracket_the_observed_range(self):
        # Guards the two constants against being "tidied" into round numbers. The
        # low anchor is the recall floor, so a chunk below it is never handed to
        # the generator and cannot be the basis of a figure.
        self.assertEqual(CONFIDENCE_LOW_SIMILARITY, 0.15)
        self.assertEqual(CONFIDENCE_HIGH_SIMILARITY, 0.70)
        self.assertGreater(CONFIDENCE_HIGH_SIMILARITY, CONFIDENCE_LOW_SIMILARITY)

    def test_a_similarity_below_the_low_anchor_does_not_score_below_the_range(self):
        # It cannot happen in the product — the recall floor is the low anchor —
        # but the function is total, so it must not return 0 or a negative for one.
        self.assertEqual(retrieval_confidence([candidate(0.0)]), CONFIDENCE_MIN)


if __name__ == "__main__":
    unittest.main()
