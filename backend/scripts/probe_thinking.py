"""Whether GLM's reasoning can be switched off on this endpoint.

The model's thinking is streamed but discarded, which is why the screen is blank
for over a minute before any answer text appears. If thinking can be disabled the
answer itself starts in about a second and streams visibly.
"""

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

MESSAGES = [
    {"role": "system", "content": "Answer from the given context only. Be brief."},
    {
        "role": "user",
        "content": "Context: full-time staff get 21 working days of annual leave.\n\nQuestion: How many annual leave days do I get?",
    },
]


def probe(label: str, **extra) -> None:
    started = time.time()
    reasoning = 0
    content = 0
    first_content = None
    sample = ""

    try:
        stream = client.chat.completions.create(
            model="z-ai/glm-5.3-flash",
            messages=MESSAGES,
            temperature=0.5,
            top_p=1,
            max_tokens=1024,
            stream=True,
            **extra,
        )

        for chunk in stream:
            if not chunk.choices:
                continue

            delta = chunk.choices[0].delta

            if getattr(delta, "reasoning_content", None):
                reasoning += 1
            elif delta.content:
                content += 1
                if first_content is None:
                    first_content = time.time() - started
                sample += delta.content

        verdict = f"first content {first_content:.2f}s" if first_content else "NO CONTENT"
        print(f"{label}: {verdict}, {reasoning} reasoning chunks, {content} content chunks, {time.time() - started:.2f}s total")
        print(f"   text: {sample[:90]!r}\n")
    except Exception as exc:  # noqa: BLE001 - probing, any rejection is the answer
        print(f"{label}: REJECTED -> {type(exc).__name__}: {str(exc)[:180]}\n")


probe("baseline")
probe("chat_template_kwargs", extra_body={"chat_template_kwargs": {"enable_thinking": False}})
probe("thinking=false", extra_body={"enable_thinking": False})
probe("reasoning_effort=none", extra_body={"reasoning_effort": "none"})
