import re

PERSONAL_PATTERNS = [
    r"\bmy\b(\s+\w+){0,2}\s+(salary|pay\s?slip|appraisal|balance|tax)\b",
    r"\b(days|leave)\b.*\b(do i have|have i got|i have)\b.*\b(left|remaining)\b",
    r"\bhow (much|many)\b.*\b(do i have|have i got)\b.*\b(left|remaining)\b",
]


def is_personal_question(question: str) -> bool:
    q = question.lower()
    return any(re.search(p, q) for p in PERSONAL_PATTERNS)
