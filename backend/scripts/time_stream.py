"""Times each streamed delta straight from NVIDIA, with no backend in between.

Answers the question the frontend test raised: when the tokens all arrive in one
burst, is it NVIDIA buffering them, or is something in our own pipeline?
"""

import json
import os
import time
from pathlib import Path

from dotenv import load_dotenv
from openai import OpenAI

load_dotenv(Path(__file__).resolve().parents[1] / ".env")

client = OpenAI(
    base_url=os.getenv("NVIDIA_BASE_URL", "https://integrate.api.nvidia.com/v1"),
    api_key=os.environ["NVIDIA_API_KEY"],
    max_retries=0,
)

started = time.time()
first_content = None
chunks = 0
tokens = 0

stream = client.chat.completions.create(
    model="z-ai/glm-5.3-flash",
    messages=[
        {"role": "system", "content": "Answer from the given context only. Be brief."},
        {"role": "user", "content": "Context: full-time staff get 21 working days of annual leave.\n\nQuestion: How many annual leave days do I get?"},
    ],
    temperature=0.5,
    top_p=1,
    max_tokens=1024,
    stream=True,
)

for chunk in stream:
    now = time.time() - started
    chunks += 1

    if not chunk.choices:
        continue

    delta = chunk.choices[0].delta

    if getattr(delta, "reasoning_content", None):
        if first_content is None:
            print(f"[{now:6.2f}s] reasoning began")
        continue

    if delta.content:
        if first_content is None:
            first_content = now
        tokens += 1
        print(f"[{now:6.2f}s] chunk#{chunks} delta: {delta.content!r}")

total = time.time() - started
print(f"\nfirst content at {first_content:.2f}s" if first_content else "no content")
print(f"{tokens} content deltas over {chunks} chunks, {total:.2f}s total")
print(f"content spread: {total - (first_content or total):.2f}s")
