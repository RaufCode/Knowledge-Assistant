"""Hybrid retrieval: what each search is for, and how the two are merged.

Run against a small stand-in corpus rather than the policy documents, because
what is being asserted is about the *mechanism* — an exact term ranked highly even
when meaning barely overlaps, a paraphrase still found when no term matches, a
chunk either search found kept rather than discarded — and those are far easier to
see on a corpus where the right answer is obvious.

No network and no index: the vector half is a retriever that returns a scripted
ranking with scripted scores, and the keyword half is a real BM25 index over the
same chunks, because the BM25 is the part worth testing.
"""

import unittest

from llama_index.core.schema import NodeWithScore, TextNode

from app.rag.retrieval import (
    RRF_K,
    Candidate,
    HybridRetriever,
    KeywordIndex,
    normalise,
    reciprocal_rank_fusion,
    tokenize,
)

POLICY = "Code of Conduct"
CHUNKS = {
    "conduct": "Employees must follow the Code of Conduct and treat colleagues with respect.",
    "leave": "Full-time staff accrue 25 days of annual leave each year, plus public holidays.",
    "vpn": "Set up the VPN using the GlobalProtect client before connecting from home.",
    "conduct_appeal": "A concern may be raised with a line manager, then escalated to HR.",
    "unrelated": "The canteen serves lunch from twelve until two on weekdays.",
}


def chunk(key: str) -> TextNode:
    return TextNode(text=CHUNKS[key], id_=key, metadata={"section": key})


def scripted_vector_retriever(order: dict[str, float]):
    """A retriever returning `order` (key -> similarity), highest first."""

    class _Retriever:
        def retrieve(self, query: str):
            return [
                NodeWithScore(node=chunk(key), score=score, node_id=key)
                for key, score in sorted(order.items(), key=lambda pair: -pair[1])
            ]

    return _Retriever()


def build_retriever(vector_order: dict[str, float], **overrides) -> HybridRetriever:
    nodes = [chunk(key) for key in CHUNKS]
    options = {
        "top_k": 3,
        "vector_candidates": 10,
        "keyword_candidates": 10,
        "min_score": 0.40,
        "keyword_min_score": 0.5,
        # Off by default in these tests, so a case about the strict pass is not
        # silently rescued by the last-resort path and the assertion stops
        # describing what it was written to describe.
        "recall_floor": 9.9,
        "recall_candidates": 4,
    }
    options.update(overrides)

    return HybridRetriever(
        scripted_vector_retriever(vector_order),
        KeywordIndex(nodes),
        **options,
    )


class TokenizeTest(unittest.TestCase):
    def test_plurals_and_case_fold_together(self):
        # A question says "policies" and a document says "policy"; without this
        # they are different words and the exact-term search misses both.
        self.assertEqual(tokenize("Policies and POLICY"), ["policy", "policy"])
        self.assertEqual(normalise("policies"), "policy")
        self.assertEqual(normalise("days"), "day")

    def test_words_that_carry_no_signal_are_dropped(self):
        self.assertEqual(tokenize("what is the policy of the company"), ["policy", "company"])

    def test_a_two_letter_fragment_is_not_a_term(self):
        self.assertEqual(tokenize("hr and it"), [])


class KeywordIndexTest(unittest.TestCase):
    def setUp(self):
        self.index = KeywordIndex([chunk(key) for key in CHUNKS])

    def test_finds_the_chunk_holding_the_exact_terms(self):
        hits = self.index.search("Code of Conduct", top_k=3)

        self.assertEqual(hits[0].node.node_id, "conduct")

    def test_a_question_with_no_shared_terms_matches_nothing(self):
        # Zero, rather than every chunk: a chunk that matches nothing is not a
        # weak match, and returning the corpus would put unrelated text in front
        # of the generator for every off-topic question.
        self.assertEqual(self.index.search("photosynthesis in plants", top_k=3), [])

    def test_stopwords_alone_match_nothing(self):
        self.assertEqual(self.index.search("what is it", top_k=3), [])

    def test_a_rare_term_outranks_a_common_one(self):
        # "policy" appears in three chunks and "GlobalProtect" in one, so the
        # chunk with the rare term is the better answer even though the common one
        # matches more of the query's words.
        hits = self.index.search("policy and the GlobalProtect client", top_k=3)

        self.assertEqual(hits[0].node.node_id, "vpn")


def named(*keys: str):
    """The smallest thing a fusion can rank, which is anything with a `node_id`."""
    return [type("N", (), {"node_id": key})() for key in keys]


class FusionTest(unittest.TestCase):
    def test_a_chunk_in_both_lists_outranks_one_in_neither(self):
        fused = reciprocal_rank_fusion([named("a", "b"), named("b", "c")])

        self.assertEqual(max(fused, key=fused.get), "b")

    def test_a_chunk_only_one_list_found_still_scores(self):
        # The point of running two searches: a chunk one method found must compete
        # rather than be discarded, or the second search could only reorder and
        # never contribute.
        fused = reciprocal_rank_fusion([named("a"), named("b")])

        self.assertIn("a", fused)
        self.assertIn("b", fused)

    def test_ranks_count_from_one_with_the_paper_constant(self):
        fused = reciprocal_rank_fusion([named("a", "b")])

        self.assertAlmostEqual(fused["a"], 1 / (RRF_K + 1))
        self.assertAlmostEqual(fused["b"], 1 / (RRF_K + 2))


class HybridRetrievalTest(unittest.TestCase):
    def test_an_exact_term_is_carried_when_the_vector_search_under_scores_it(self):
        # The case vector search is weak at. "GlobalProtect" and the canteen are
        # unrelated, so the canteen chunk takes the top vector slot, and the right
        # chunk scores under the floor — but it is still in the list the search
        # looked at, which is what lets the keyword half promote it. Without that
        # the exact-term hit a second search exists to find would be dropped.
        retriever = build_retriever({"unrelated": 0.72, "vpn": 0.11})

        found = [result.node.node_id for result in retriever.retrieve("GlobalProtect client setup")]

        self.assertIn("vpn", found)
        # It carries the score the vector search actually gave it, not a missing
        # one. Under the floor is not the same as unmeasured, and reporting a
        # rescued chunk as having no similarity misdescribes it in both
        # directions — which is what `confidence` is derived from.
        rescued = next(
            result
            for result in retriever.retrieve("GlobalProtect client setup")
            if result.node.node_id == "vpn"
        )
        self.assertEqual(rescued.similarity, 0.11)

    def test_a_keyword_hit_the_vector_search_never_returned_is_dropped(self):
        # The bug this rule exists for. On a corpus this small, BM25's IDF treats
        # a light verb used in four chunks as as rare as a policy name used in
        # four, so a question about pay put the IT setup guide first on the
        # strength of "get" and "work" — terms whose similarity to that chunk was
        # 0.163 — and the generator was handed a VPN guide in answer to a question
        # about pay. The floor would not have caught it either: that is applied to
        # what the vector search returns, and this chunk was not returned at all.
        retriever = build_retriever({"unrelated": 0.72})

        found = [result.node.node_id for result in retriever.retrieve("GlobalProtect client setup")]

        self.assertNotIn("vpn", found)

    def test_a_keyword_hit_under_the_floor_is_still_carried_into_the_context(self):
        # The case the rule must not over-reach into: the vector search looked at
        # this chunk and scored it just under the floor, so the keyword half
        # rescues it. It is carried even though the vector half did not score it,
        # because "looked at it" is a weaker requirement than "close enough".
        retriever = build_retriever({"conduct": 0.55, "vpn": 0.30})

        results = retriever.retrieve("GlobalProtect client setup")

        self.assertIn("vpn", [result.node.node_id for result in results])

    def test_a_chunk_under_ranked_by_meaning_rises_on_two_searches_agreeing(self):
        # The same case, realistically: the vector search has the right chunk but
        # has it eighth, and the keyword search puts it first. Two lists agreeing
        # is worth more than one list being emphatic, and that is the fusion doing
        # its job.
        retriever = build_retriever(
            {
                "unrelated": 0.70,
                "conduct_appeal": 0.68,
                "leave": 0.66,
                "conduct": 0.64,
                "vpn": 0.45,
            }
        )

        results = retriever.retrieve("GlobalProtect client setup")

        self.assertEqual(results[0].node.node_id, "vpn")
        self.assertIsNotNone(results[0].similarity)
        self.assertIsNotNone(results[0].keyword)

    def test_a_paraphrase_is_still_found_with_no_term_in_common(self):
        # The case keyword search is weak at: neither "remuneration" nor
        # "receive" appears anywhere in the corpus, so the leave chunk can only
        # have been found by meaning.
        retriever = build_retriever({"leave": 0.61})

        results = retriever.retrieve("What remuneration do I receive?")

        self.assertEqual(results[0].node.node_id, "leave")
        self.assertIsNone(results[0].keyword)

    def test_a_chunk_both_searches_like_ranks_first(self):
        retriever = build_retriever({"conduct": 0.55, "leave": 0.65})

        results = retriever.retrieve("Code of Conduct")

        self.assertEqual(results[0].node.node_id, "conduct")

    def test_nothing_relevant_returns_nothing(self):
        retriever = build_retriever({}, keyword_min_score=99)

        self.assertEqual(retriever.retrieve("photosynthesis in plants"), [])

    def test_below_the_similarity_floor_is_not_a_match(self):
        # The vector search returned the chunk but scored it 0.30, under the 0.40
        # floor. The floor is applied per search and before fusion, so relevance
        # decides this rather than rank: a weak vector score cannot buy a place in
        # the context just by being the only thing that came back.
        retriever = build_retriever({"unrelated": 0.30}, min_score=0.40)

        self.assertEqual(retriever.retrieve("photosynthesis in plants"), [])

    def test_the_result_is_capped_at_top_k(self):
        retriever = build_retriever(
            {"conduct": 0.6, "leave": 0.6, "vpn": 0.6, "unrelated": 0.6}, top_k=2
        )

        self.assertLessEqual(len(retriever.retrieve("the company policy and the code")), 2)

    def test_each_search_looks_further_down_than_top_k(self):
        # Asking each search for exactly top_k would cap the fusion at the two
        # best chunks it already had, so the candidate depth is its own setting.
        retriever = build_retriever(
            {key: 0.9 - index * 0.01 for index, key in enumerate(CHUNKS)},
            top_k=1,
            vector_candidates=4,
        )

        results = retriever.retrieve("Code of Conduct policy leave VPN")

        self.assertEqual(len(results), 1)
        # "conduct" is first in the vector list *and* first on keywords, so the
        # one slot goes to the chunk both agree on rather than to whichever search
        # happened to be consulted first.
        self.assertEqual(results[0].node.node_id, "conduct")

    def test_a_failing_vector_search_degrades_to_keywords(self):
        # Nothing was considered, so by the rule above nothing can be rescued — but
        # the question must still be answered from the keyword half rather than
        # raised as an error, since a throttled embedding tier is not the caller's
        # problem.
        class _Broken:
            def retrieve(self, query: str):
                raise RuntimeError("embeddings unavailable")

        retriever = HybridRetriever(
            _Broken(),
            KeywordIndex([chunk(key) for key in CHUNKS]),
            top_k=3,
            vector_candidates=10,
            keyword_candidates=10,
            min_score=0.40,
            keyword_min_score=0.5,
            recall_floor=9.9,
            recall_candidates=4,
        )

        self.assertEqual(retriever.retrieve("Code of Conduct"), [])


class RecallFloorTest(unittest.TestCase):
    """The last resort, for a question whose best chunk is under `min_score`.

    The case it exists for: questions the corpus genuinely answers score as low as
    0.22 on their best chunk, while questions it cannot answer peak near 0.32. No
    threshold separates those, so `min_score` cannot be lowered to cover them. The
    generator can tell them apart, and is what already decides `NOT_FOUND`, so the
    sub-floor chunk is handed to it rather than withheld.
    """

    def build(self, vector_order=None, **overrides) -> HybridRetriever:
        options = {
            "top_k": 3,
            "vector_candidates": 10,
            "keyword_candidates": 10,
            "min_score": 0.40,
            "keyword_min_score": 0.5,
            "recall_floor": 0.15,
            "recall_candidates": 3,
        }
        options.update(overrides)
        return HybridRetriever(
            # Everything below the floor by default: that is the situation the last
            # resort exists for, so a case that does not opt out of it is testing
            # something else.
            scripted_vector_retriever(
                vector_order if vector_order is not None else {"conduct": 0.22, "unrelated": 0.20}
            ),
            KeywordIndex([chunk(key) for key in CHUNKS]),
            **options,
        )

    def test_a_sub_floor_chunk_is_passed_on_when_nothing_else_matched(self):
        results = self.build().retrieve("compensation")

        # Under the floor and matching nothing lexically, so the strict pass is
        # empty — but the vector search did rank something, and returning nothing
        # here would report a gap in the corpus for a question it can answer.
        self.assertTrue(results)
        self.assertEqual(results[0].node.node_id, "conduct")

    def test_a_real_match_is_never_joined_by_sub_floor_chunks(self):
        # A question with a chunk above the floor must not have its ranking touched
        # by the last resort. Two chunks are above the floor and `top_k` is 3, so if
        # the recall path ran unconditionally it would fill the third slot with a
        # chunk that never cleared it. Membership in the vector candidate list is
        # what the keyword leg checks, so a sub-floor chunk does appear here — but
        # only as a candidate, never displacing a real match.
        results = self.build(
            vector_order={"conduct": 0.62, "vpn": 0.55, "unrelated": 0.21, "leave": 0.18}
        ).retrieve("Code of Conduct")

        self.assertTrue(results)
        self.assertEqual(results[0].node.node_id, "conduct")
        self.assertEqual(results[0].similarity, 0.62)

    def test_nothing_is_passed_on_below_the_recall_floor(self):
        # Without one, the last resort would hand the generator the least similar
        # chunk in the corpus, which is noise rather than evidence.
        results = self.build(recall_floor=0.95).retrieve("photosynthesis in plants")

        self.assertEqual(results, [])

    def test_the_recall_chunk_is_added_to_the_keyword_hits_not_instead_of_them(self):
        # A keyword hit is specific, so it keeps its place; the semantic evidence
        # is added beside it. Replacing would discard the better-founded of the two.
        results = self.build().retrieve("Code of Conduct")

        self.assertIn("conduct", [result.node.node_id for result in results])

    def test_a_broken_vector_search_does_not_invent_a_recall_hit(self):
        class _Broken:
            def retrieve(self, query: str):
                raise RuntimeError("embeddings unavailable")

        results = HybridRetriever(
            _Broken(),
            KeywordIndex([chunk(key) for key in CHUNKS]),
            top_k=3,
            vector_candidates=10,
            keyword_candidates=10,
            min_score=0.40,
            keyword_min_score=0.5,
            recall_floor=0.15,
            recall_candidates=3,
        ).retrieve("photosynthesis in plants")

        self.assertEqual(results, [])


class RerankerTest(unittest.TestCase):
    def test_a_reranker_reorders_the_merged_candidates(self):
        class _Reranker:
            def rerank(self, query: str, candidates: list[Candidate]):
                # Deliberately puts last first, which is the only thing an
                # optional final pass is here to be able to do.
                return list(reversed(candidates))

        retriever = build_retriever(
            {"conduct": 0.55, "leave": 0.65}, rerank=_Reranker()
        )

        results = retriever.retrieve("the leave policy and the code of conduct")

        # Fusion had leave first; the reranker saw both and reversed them. That is
        # the whole contract of an optional final pass — it decides the order of
        # an already-shortlisted set, and nothing else.
        self.assertEqual(results[0].node.node_id, "conduct")


if __name__ == "__main__":
    unittest.main()
