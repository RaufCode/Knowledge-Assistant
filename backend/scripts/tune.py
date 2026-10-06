"""Retrieval threshold tuning, across both searches.

Run after changing `EMBED_MODEL` or either floor. It prints, per question, what
each search found and what the fusion put in front of the generator, so a
threshold that is mistuned is visible as a number rather than as every question
coming back "not found" with no error anywhere.

Needs the embedding key and a network call to build the index. The questions are
deliberately a mix of the four cases that matter: a plain policy question, a
paraphrase whose wording appears nowhere in the documents, an exact term, and a
question the corpus genuinely does not cover. That last one is the one to watch —
if it retrieves confidently, the floors are too low.
"""

from app.config import settings
from app.rag.ingest import build_index
from app.rag.retrieval import HybridRetriever, KeywordIndex

# (question, what a good result looks like, must retrieve nothing?)
#
# The last flag is the one to watch. Retrieval is allowed to hand the generator
# chunks for a question the corpus does not cover — the generator is the thing that
# decides NOT_FOUND, and that is the right division of labour. But the chunk it
# hands over should be obviously irrelevant, not the closest thing to an answer.
CASES = [
    ("How many sick leave days do I get?", "Leave Policy", False),
    ("How much annual leave can I carry over and until when?", "Leave Policy", False),
    ("What is the Code of Conduct?", "Code of Conduct", False),
    ("How do I set up the VPN?", "IT & VPN", False),
    ("How do I report a phishing email?", "Security", False),
    ("How many employees does the company have?", "Company Overview", False),
    # The exact-term case the keyword half exists for: the vector search scores
    # this at 0.149, so without keywords it is a not-found.
    ("grievance", "Code of Conduct", False),
    # A paraphrase whose words appear nowhere in the documents. Only the vector
    # search can find these, which is the half that must not regress.
    ("How is salary paid each month?", "Compensation", False),
    ("How much time off do I get in a year?", "Leave Policy", False),
    # A paraphrase that used to be misrouted to the IT guide on "get" and "work".
    # Fixed by requiring a keyword hit to have been seen by the vector search.
    ("What do I get paid for my work?", "Compensation", False),
    # The recall floor's cases: the right chunk ranks first but scores under
    # MIN_SCORE, so nothing clears the strict pass and the best chunk is handed to
    # the generator instead. Retrieval reporting nothing here is the bug.
    ("What is the notice period?", None, False),
    ("How do I raise a complaint?", "Code of Conduct", False),
    ("How is performance reviewed?", "Compensation", False),
    # Genuinely not covered. Retrieval returning something is acceptable here —
    # the generator rejects it — but it should be nothing like an answer.
    ("What is the policy on tuition reimbursement for postgraduate study?", None, True),
    ("How many dentists does the company have?", None, True),
    # Not the assistant's to answer at all. It never reaches retrieval in the
    # product; it is here because a mistuned floor shows up as it retrieving.
    ("how many presidents has Ghana had?", None, True),
]

index = build_index()
retriever = HybridRetriever(
    index.as_retriever(similarity_top_k=settings.vector_candidates),
    KeywordIndex(index.docstore.docs.values()),
    top_k=settings.top_k,
    vector_candidates=settings.vector_candidates,
    keyword_candidates=settings.keyword_candidates,
    min_score=settings.min_score,
    keyword_min_score=settings.keyword_min_score,
    recall_floor=settings.recall_floor,
    recall_candidates=settings.recall_candidates,
)

print(
    f"TOP_K={settings.top_k}  MIN_SCORE={settings.min_score}  "
    f"KEYWORD_MIN_SCORE={settings.keyword_min_score}  "
    f"RECALL_FLOOR={settings.recall_floor}  "
    f"candidates={settings.vector_candidates}/{settings.keyword_candidates}"
)

for question, expected, expect_nothing in CASES:
    candidates = retriever.retrieve(question)
    titles = [candidate.node.metadata["policy_title"] for candidate in candidates]

    if expect_nothing:
        # Nothing to assert about the *title* here — some of these legitimately
        # retrieve the nearest document, since the corpus does contain the words.
        # What matters is how the generator then treats it, and that is what the
        # `expect_nothing` flag marks for a reader, not a pass/fail computed here.
        print(f"\n{question}\n  expecting: nothing relevant  [generator must answer NOT_FOUND]")
    else:
        found = expected.lower() in " ".join(titles).lower()
        print(f"\n{question}\n  expecting: {expected}  [{'ok' if found else 'MISSING'}]")

    if not candidates:
        print("  (nothing retrieved)")

    for candidate in candidates:
        similarity = (
            "-" if candidate.similarity is None else f"{candidate.similarity:.3f}"
        )
        keyword = "-" if candidate.keyword is None else f"{candidate.keyword:.2f}"
        node = candidate.node
        print(
            f"  fused={candidate.fused:.4f} vec={similarity} kw={keyword}"
            f"  {node.metadata['policy_title']} > {node.metadata['section']}"
        )
