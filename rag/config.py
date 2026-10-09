import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "export_fy2425"
INDEX_DIR = ROOT / "index"
SKILLS_DIR = ROOT / "skills"
UI_DIR = ROOT / "ui"


def _load_env():
    p = ROOT / ".env"
    if p.exists():
        for line in p.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())


_load_env()

OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
OPENROUTER_MODEL = os.environ.get("OPENROUTER_MODEL", "nvidia/nemotron-3-ultra-550b-a55b:free")
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

EMBED_MODEL = "BAAI/bge-small-en-v1.5"
QUERY_PREFIX = "Represent this sentence for searching relevant passages: "
EMBED_BATCH = 64
EMBED_MAX_LEN = 384

# Companies present in the corpus: doc_id prefix -> (display name, aliases)
COMPANIES = {
    "ONGC": ("ONGC", ["ongc", "oil and natural gas", "oil & natural gas"]),
    "OVL": ("ONGC Videsh (OVL)", ["ovl", "videsh"]),
    "IRCTC": ("IRCTC", ["irctc", "indian railway catering"]),
    "Hindustan_Copper": ("Hindustan Copper", ["hindustan copper", "hcl"]),
    "SAIL": ("SAIL", ["sail", "steel authority"]),
}

# Retrieval / budget knobs
DENSE_K = 60
BM25_K = 60
RRF_K = 60
FINAL_K = 10                 # evidence items sent to the LLM
EVIDENCE_CHAR_BUDGET = 11000  # ~2.8k tokens
TEXT_ITEM_CHARS = 1400
TABLE_ITEM_CHARS = 1800
MIN_DENSE_SCORE = 0.42       # below this best score => nothing relevant, skip LLM
PLAN_MAX_TOKENS = 500
ANSWER_MAX_TOKENS = 1800
