# FINORA — Annual Report Analyst (grounded RAG with CA-auditor skills)

A local retrieval-augmented question-answering system over the **FY 2024-25 annual reports** of
**ONGC, OVL (ONGC Videsh), IRCTC, Hindustan Copper and SAIL**. It answers *only* from the retrieved
report excerpts, cites every claim, and can analyse the reports through a CA-auditor lens
(audit review, observations), risk analysis, pain points, financial analysis and comparisons.

- **Embeddings:** `BAAI/bge-small-en-v1.5`, run locally on the GPU (fp16)
- **Vector store:** FAISS (exact inner-product) + BM25 keyword index, fused with Reciprocal Rank Fusion
- **LLM:** any OpenRouter model (default `nvidia/nemotron-3-ultra-550b-a55b:free`)
- **Backend:** FastAPI (REST + Server-Sent Events) · **UI:** FINORA, a light-theme, no-build ES-module app with a live "Inside the AI Workspace" pipeline view

---

## Architecture

```
                         ┌──────────────────────── offline (once) ────────────────────────┐
 export_fy2425/*.jsonl ─►│ rag/ingest.py  →  bge-small (GPU)  →  index/faiss.index        │
 (documents, text, tables)│                →  BM25 postings     →  index/bm25.pkl          │
                         │                →  passage metadata  →  index/meta.jsonl        │
                         └─────────────────────────────────────────────────────────────────┘

 FINORA UI ──POST /api/chat/stream (SSE)──► FastAPI (rag/server.py)
             └─ fallback: POST /api/chat
                                   │
                                   ▼
                        ┌──────── Single agent (rag/agent.py) ────────┐
                        │ 1. PLAN     rephrase · classify intent ·     │
                        │             detect companies · pick skills   │
                        │ 2. SKILLS   load 1–2 markdown skills         │
                        │ 3. RETRIEVE hybrid dense+BM25, RRF,          │
                        │             per-company balancing,           │
                        │             neighbour expansion, packing     │
                        │ 4. ANSWER   one grounded LLM call            │
                        │ 5. VERIFY   citation + number check          │
                        └──────────────────────────────────────────────┘
```

### One agent, five steps

| Step | What happens | LLM cost |
|---|---|---|
| **Plan** | Rule-based fast path detects company aliases and intent from keywords. If the question is ambiguous or a follow-up, one tiny LLM call (max 500 tokens) rewrites it into a standalone query, classifies the intent and proposes up to 2 extra search queries. | 0 or 1 small call |
| **Skills** | The intent maps to skills in `skills/` (e.g. `audit` → `ca_auditor`). Only the 1–2 relevant skill files are injected into the prompt. Skill-defined search hints are used as extra retrieval queries locally (free). | none |
| **Retrieve** | See below. | none (local GPU/CPU) |
| **Answer** | One call with the system rules, the skill text and the packed evidence. Temperature 0, reasoning disabled. | 1 call |
| **Verify** | Strips citations that do not exist, checks every number in the answer appears in the evidence, and returns a grounding status. | none |

Every step reports a **stage event** (`plan`, `skill`, `retrieve`, `generate`, `verify`, `cache`) through an optional
`emit` callback on `Agent.answer(...)`. Events fire only at real pipeline boundaries and are what the UI's workspace pane shows.

Intents: `audit`, `observations`, `risk`, `painpoint`, `financial`, `compare`, `general`, `out_of_scope`.
`out_of_scope` questions are refused without any retrieval or answer call.

### Retrieval pipeline (`rag/retriever.py`)

1. **Index units** — narrative chunks (table stubs and tiny fragments are skipped) and extracted tables.
   Each is embedded with a context header (`company | section | …`); tables are embedded as
   `title + description + first rows`, so statement tables are discoverable.
2. **Hybrid search** — for each query: FAISS dense top-60 + BM25 top-60 (BM25 catches exact terms and numbers).
3. **Fusion** — Reciprocal Rank Fusion across all queries (original rewrite weighted highest).
4. **Re-weighting** — numeric questions boost tables; tables tagged as a financial statement and
   primary statements (`Statement of Profit and Loss`, `Balance Sheet`, …) get further boosts; headings/figures are damped.
5. **Company filter & balancing** — detected companies restrict the search; multi-company questions
   are interleaved round-robin so one company cannot exhaust the evidence budget.
6. **Neighbour expansion** — top narrative hits are widened with adjacent chunks from the same page
   range (answers usually follow headings/questions).
7. **Packing** — table markdown is compacted, items are truncated and the evidence is packed into a
   hard character budget (~2.8k tokens) with ids `C1…Cn`.

### Anti-hallucination design

- System prompt: answer **only** from `EVIDENCE`, no outside knowledge, every claim cites `[Cn]`,
  no unit conversion or rounding, and the exact reply `Not found in the available reports.` when unsupported.
- `out_of_scope` short-circuit and "reports covered" rule for companies that are not in the corpus.
- Post-generation **verification**: invalid citations are removed; numbers not found verbatim in the
  evidence are flagged (UI shows `grounded` / `partly verified` / `unverified` and lists unmatched numbers).
- Skills forbid inventing facts: missing items must be reported as "not reported in retrieved evidence".

### Token / free-tier optimisation

- Rule-based routing avoids the planner call for most questions (typically **one LLM call per query**).
- Only relevant skills are loaded; evidence is capped (~2.8k tokens) and tables are compacted.
- Responses are cached in memory (normalised query + filters); 5 retries with backoff on provider overload.
- Typical usage measured on 14 queries: ~3.5k prompt + ~0.3k completion tokens per query.

---

## Skills (`skills/`)

Markdown files with front-matter; the body is injected into the prompt, and `queries:` are local retrieval hints.

| Skill | Purpose |
|---|---|
| `ca_auditor` | CA auditor review: opinion, key audit matters, emphasis of matter, CARO, internal financial controls, going concern, compliance |
| `ca_auditor_observations` | Management-letter style table: observation, evidence, severity, suggested action |
| `risk_analysis` | Disclosed financial / operational / regulatory / market / ESG risks and stated mitigations |
| `pain_points` | Management-stated challenges vs. metrics that visibly worsened |
| `financial_analysis` | Reported figures with unit, period and basis; ratios labelled "(computed)" |
| `comparison` | Same-basis side-by-side tables; missing values marked "n/a" |

Add a skill by creating `skills/<name>.md`:

```markdown
---
name: my_skill
title: My Skill
intents: risk
description: One-line description shown in the UI
queries: first retrieval hint | second retrieval hint
---
Instructions the agent must follow when this skill is active.
```

then map it to an intent in `rag/skills.py` (`INTENT_SKILLS`). In the UI, skill cards under **Analysis lens**
can also force a skill regardless of the question wording.

---

## Project layout

```
rag/
  config.py      paths, model names, retrieval and token budgets, company aliases
  ingest.py      JSONL → embeddings (GPU) → FAISS + BM25 + metadata
  retriever.py   hybrid search, RRF, balancing, window expansion, packing
  agent.py       plan → skills → retrieve → answer → verify; OpenRouter client; cache
  skills.py      skill loader and intent→skill map
  textutil.py    tokenizer shared by indexing and BM25 search
  server.py      FastAPI: GET /api/meta, POST /api/chat, POST /api/chat/stream (SSE), serves the UI
skills/          markdown skills (CA auditor, risk, pain points, …)
ui/
  index.html     FINORA app shell
  css/           tokens.css (design tokens), app.css
  js/            main.js (app + state wiring), api.js (all network calls), storyboard.js (live pipeline view),
                 chart.js (charts from answer tables), markdown.js (safe renderer), state.js (localStorage)
  assets/        logo.svg
tests/           test_stage_events.py (pytest; LLM and retriever stubbed)
export_fy2425/   (not in git) documents.jsonl, text_chunks.jsonl, table_chunks.jsonl
index/           (not in git) generated FAISS/BM25/metadata
```

## Data format (not included in the repo)

`export_fy2425/` must contain three JSONL files exported from the source database
(embedding columns removed):

- `documents.jsonl` — one row per report (`doc_id`, `company`, `fy_start`, `fy_end`, page/chunk counts, `toc_sections`)
- `text_chunks.jsonl` — `chunk_id`, `doc_id`, `chunk_type`, `content`, `section`, `toc_section`, page fields, context fields
- `table_chunks.jsonl` — `table_id`, `doc_id`, `table_title`, `table_description`, `financial_stmt_type`, `unit`, `currency`, `table_md`, page fields

Company keys are derived from the `doc_id` prefix (`ONGC_2024_2025` → `ONGC`); see `COMPANIES` in `rag/config.py`.

## Setup & run

Requirements: Python 3.10+, an NVIDIA GPU with CUDA (a 4 GB card is enough; CPU also works, slower), an OpenRouter API key.

```bash
pip install -r requirements.txt
# PyTorch with CUDA, e.g.: pip install torch --index-url https://download.pytorch.org/whl/cu118

cp .env.example .env            # Windows: copy .env.example .env
# edit .env: OPENROUTER_API_KEY=...  OPENROUTER_MODEL=...

python -m rag.ingest            # build the index (~1 min on GPU, ~300 MB VRAM)
python -m uvicorn rag.server:app --port 8000
```

Open <http://localhost:8000>. Make sure the `python` you run has the dependencies installed
(a different virtualenv will fail with `No module named uvicorn`).

### Configuration

`.env`

| Variable | Meaning |
|---|---|
| `OPENROUTER_API_KEY` | your OpenRouter key (never commit it) |
| `OPENROUTER_MODEL` | model id, default `nvidia/nemotron-3-ultra-550b-a55b:free` |

`rag/config.py` — `EMBED_MODEL`, `DENSE_K`/`BM25_K`, `FINAL_K`, `EVIDENCE_CHAR_BUDGET`,
`PLAN_MAX_TOKENS`, `ANSWER_MAX_TOKENS`, `COMPANIES`.

## API

| Endpoint | Description |
|---|---|
| `GET /api/meta` | companies, skills, model names, passage count |
| `POST /api/chat` | body `{query, history?, companies?, skills?}` → `{answer, plan, evidence[], grounding, usage, trace, seconds, cached}` |
| `POST /api/chat/stream` | same body; `text/event-stream`. `stage` events (`request_id, stage, status, display_message, timestamp, …`), then one `result` event (identical JSON to `/api/chat`) or an `error` event |

## Example questions

- What are the key audit matters reported by the auditor of IRCTC?
- Give a CA auditor review of SAIL: opinion, key audit matters and remarks
- Raise CA auditor observations on ONGC's contingent liabilities
- Identify the main risks disclosed by Hindustan Copper
- What pain points does SAIL report in its operations?
- Compare total income and profit after tax of ONGC and OVL

## Known limitations

- Free-tier models can return "overloaded" errors (retried 5×) and long audit/risk answers take 30–60 s.
- Large multi-column statements may be truncated in the evidence budget, so some figures (e.g. a consolidated PAT) can be reported as "not in retrieved evidence" instead of guessed.
- The number check verifies numbers, not unit labels; the model may occasionally mislabel a unit.
- Only FY 2024-25 reports of five companies are indexed; older-year figures appear only where they sit inside those reports.

## FINORA UI (`ui/`)

A no-build ES-module single-page app (serve-as-static, no Node tooling). Light, warm palette defined as tokens in `css/tokens.css`.

- **Chat workspace** with answers rendered from markdown (tables, lists), clickable `[Cn]` citation chips that open the source passage, page and statement type, grounding badge (`grounded` / `partly verified` / `unverified`, with unmatched numbers listed) and per-answer token/latency figures.
- **Inside the AI Workspace** (`js/storyboard.js`): an animated scene driven *only* by the real stage events from `/api/chat/stream`. If the stream is unavailable the UI falls back to `/api/chat` and labels the stages as reconstructed.
- **Charts** (`js/chart.js`): drawn from tables already present in the answer, using cell values exactly as written (no scaling or recalculation); tables that cannot be parsed reliably are not charted.
- **Report library, Analysis lenses and Settings** dialogs; skill cards force a lens regardless of wording; company filters restrict retrieval.
- **Conversations** are stored in the browser (`localStorage`) with search; nothing is stored server-side.
- Not supported by the backend, so not in the UI: document upload, server-side conversation storage, token streaming, tool calls, structured numeric output.

## Tests

```bash
pip install pytest
python -m pytest tests
```

`tests/test_stage_events.py` stubs the retriever and LLM and checks that stage events fire at real pipeline boundaries (no network, GPU or index needed).
