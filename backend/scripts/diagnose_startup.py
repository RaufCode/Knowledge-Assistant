"""Which startup step is the backend waiting on?"""

import os
import time

from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))


def timed(label, fn):
    started = time.time()
    try:
        result = fn()
        print(f"  {label}: ok in {time.time() - started:.1f}s -> {result}")
        return True
    except Exception as error:  # noqa: BLE001 - this is a diagnostic script
        print(f"  {label}: FAILED after {time.time() - started:.1f}s")
        print(f"    {type(error).__name__}: {str(error)[:300]}")
        return False


print("1. Neon database")
url = os.environ.get("DATABASE_URL", "")
print(f"  scheme: {url.split(':', 1)[0] or '(none)'}")

if url.startswith("postgresql"):
    import psycopg

    def check_db():
        with psycopg.connect(url, connect_timeout=15) as conn:
            with conn.cursor() as cur:
                cur.execute("select 1")
                return "reachable"

    timed("connect", check_db)
else:
    print("  not postgres, skipping")

print("2. NVIDIA embeddings")
embed_key = os.environ.get("NVIDIA_EMBEDDING_API_KEY", "")
print(f"  key present: {bool(embed_key)}")
if embed_key:
    import httpx

    def check_embed():
        response = httpx.post(
            "https://integrate.api.nvidia.com/v1/embeddings",
            headers={"Authorization": f"Bearer {embed_key}"},
            json={
                "model": os.environ.get("EMBED_MODEL", "nvidia/nemotron-3-embed-1b"),
                "input": ["a short sentence"],
                "encoding_format": "float",
            },
            timeout=30,
        )
        return f"HTTP {response.status_code}"

    timed("embeddings call", check_embed)