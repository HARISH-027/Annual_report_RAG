"""Build FAISS (dense, GPU-embedded) + BM25 index from export_fy2425/*.jsonl."""
import json, pickle, time
from collections import defaultdict
import numpy as np
import faiss
import torch
from sentence_transformers import SentenceTransformer
from . import config as C
from .textutil import tokenize


def company_of(doc_id):
    for k in C.COMPANIES:
        if doc_id.startswith(k + "_"):
            return k
    return doc_id


def load_records():
    recs = []
    for line in open(C.DATA_DIR / "text_chunks.jsonl", encoding="utf-8"):
        r = json.loads(line)
        txt = (r.get("content") or "").strip()
        if r["chunk_type"] == "table_stub" or len(txt) < 40:
            continue
        recs.append(dict(
            id=r["chunk_id"], kind="text", ctype=r["chunk_type"], doc_id=r["doc_id"],
            company=company_of(r["doc_id"]), section=r.get("section") or "",
            toc=r.get("toc_section") or "", title=r.get("title") or "",
            page=r.get("page_ocr_start"), page_end=r.get("page_ocr_end"), text=txt,
            stmt=None, unit=None, ref=r["chunk_id"]))
    for line in open(C.DATA_DIR / "table_chunks.jsonl", encoding="utf-8"):
        r = json.loads(line)
        md = (r.get("table_md") or "").strip()
        if not md:
            continue
        title = r.get("table_title") or ""
        recs.append(dict(
            id=r["table_id"], kind="table", ctype="table", doc_id=r["doc_id"],
            company=company_of(r["doc_id"]), section=r.get("section") or "",
            toc=r.get("toc_section") or "", title=title,
            page=r.get("page_ocr_start"), page_end=r.get("page_ocr_end"),
            text=md, desc=r.get("table_description") or "",
            stmt=r.get("financial_stmt_type"), unit=r.get("unit"), ref=r["table_id"]))
    # keep document order so neighbours are adjacent
    recs.sort(key=lambda x: (x["doc_id"], x["page"] or 0, x["kind"] != "text", x["id"]))
    return recs


def embed_text(r):
    head = f"{C.COMPANIES.get(r['company'], (r['company'],))[0]} | {r['toc']} | {r['section']}".strip(" |")
    if r["kind"] == "table":
        stmt = f" ({r['stmt'].replace('_', ' ')})" if r["stmt"] else ""
        return f"{head}\nTable{stmt}: {r['title']}\n{r['desc'][:300]}\n{r['text'][:900]}"
    return f"{head}\n{r['text']}"


def bm25_text(r):
    head = f"{r['company']} {r['toc']} {r['section']} {r['title']}"
    body = r["text"][:6000]
    if r["kind"] == "table" and r["stmt"]:
        head += " " + r["stmt"].replace("_", " ")
    return head + " " + body


def build_bm25(texts):
    post = defaultdict(list)
    dl = np.zeros(len(texts), dtype=np.float32)
    for i, t in enumerate(texts):
        toks = tokenize(t)
        dl[i] = len(toks)
        tf = defaultdict(int)
        for w in toks:
            tf[w] += 1
        for w, c in tf.items():
            post[w].append((i, c))
    index = {w: (np.array([a for a, _ in v], dtype=np.int32), np.array([b for _, b in v], dtype=np.float32))
             for w, v in post.items()}
    return dict(post=index, dl=dl, avgdl=float(dl.mean()), N=len(texts))


def main():
    t0 = time.time()
    C.INDEX_DIR.mkdir(exist_ok=True)
    recs = load_records()
    print(f"{len(recs)} records ({sum(r['kind']=='table' for r in recs)} tables)")
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    print("device:", dev, torch.cuda.get_device_name(0) if dev == "cuda" else "")
    model = SentenceTransformer(C.EMBED_MODEL, device=dev)
    model.max_seq_length = C.EMBED_MAX_LEN
    if dev == "cuda":
        model.half()
    texts = [embed_text(r) for r in recs]
    # sort by length for fast batching, then restore order
    order = np.argsort([len(t) for t in texts])
    emb = model.encode([texts[i] for i in order], batch_size=C.EMBED_BATCH, normalize_embeddings=True,
                       show_progress_bar=True, convert_to_numpy=True).astype("float32")
    out = np.zeros_like(emb)
    out[order] = emb
    index = faiss.IndexFlatIP(out.shape[1])
    index.add(out)
    faiss.write_index(index, str(C.INDEX_DIR / "faiss.index"))
    with open(C.INDEX_DIR / "meta.jsonl", "w", encoding="utf-8") as f:
        for r in recs:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    bm = build_bm25([bm25_text(r) for r in recs])
    pickle.dump(bm, open(C.INDEX_DIR / "bm25.pkl", "wb"))
    if dev == "cuda":
        print("peak VRAM MB:", torch.cuda.max_memory_allocated() // 2**20)
    print(f"done in {time.time()-t0:.0f}s; vectors={index.ntotal}")


if __name__ == "__main__":
    main()
