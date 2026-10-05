from app.rag.ingest import build_index

QUESTIONS = [
    "How many sick leave days do I get?",
    "How much annual leave can I carry over and until when?",
    "How do I get a salary advance?",
    "How do I set up the VPN?",
    "How do I report a phishing email?",
    "How many employees does the company have?",
    "How do I ask for a raise?",
    "How many leave days do I have left?",
    "What is the company policy on pets in the office?",
    "Who won the World Cup?",
]

index = build_index()
retriever = index.as_retriever(similarity_top_k=4)

for q in QUESTIONS:
    print(f"\n{q}")
    for n in retriever.retrieve(q):
        print(f"  {n.score:.2f}  {n.metadata['policy_title']} > {n.metadata['section']}")
