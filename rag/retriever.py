"""Hybrid retriever: dense (FAISS) + BM25 fused by RRF, company-balanced, neighbour-expanded, budget-packed."""
import json, pickle, re
import numpy as np
import faiss
import torch
from sentence_transformers import SentenceTransformer
from . import config as C
from .textutil import tokenize

PRIMARY_STMT = re.compile(r"^\W*(standalone |consolidated )?(statement of (consolidated |standalone )?(profit|income|financial position|cash flow|changes)|balance sheet)", re.I)


class Retriever:
    def __init__(self):
        self.meta = [json.loads(l) for l in open(C.INDEX_DIR / "meta.jsonl", encoding="utf-8")]
        self.index = faiss.read_index(str(C.INDEX_DIR / "faiss.index"))
        self.bm = pickle.load(open(C.INDEX_DIR / "bm25.pkl", "rb"))
        dev = "cuda" if torch.cuda.is_available() else "cpu"
        self.model = SentenceTransformer(C.EMBED_MODEL, device=dev)
        if dev == "cuda":
            self.model.half()
        self.company_ids = {}
        for i, m in enumerate(self.meta):
            self.company_ids.setdefault(m["company"], []).append(i)
        self.company_ids = {k: np.array(v, dtype=np.int64) for k, v in self.company_ids.items()}
        self.idf = {}
        N = self.bm["N"]
        for w, (ids, _) in self.bm["post"].items():
            n = len(ids)
            self.idf[w] = float(np.log(1 + (N - n + 0.5) / (n + 0.5)))
        self.pos = {m["id"]: i for i, m in enumerate(self.meta)}

    # ---- primitives
    def _embed(self, qs):
        return self.model.encode([C.QUERY_PREFIX + q for q in qs], normalize_embeddings=True,
                                 convert_to_numpy=True).astype("float32")

    def _dense(self, qvec, ids, k):
        sel = faiss.IDSelectorBatch(ids) if ids is not None else None
        params = faiss.SearchParameters(sel=sel) if sel is not None else None
        D, I = self.index.search(qvec[None], k, params=params)
        return [(int(i), float(d)) for i, d in zip(I[0], D[0]) if i >= 0]

    def _bm25(self, q, ids, k, k1=1.4, b=0.75):
        N = self.bm["N"]
        score = np.zeros(N, dtype=np.float32)
        dl, avg = self.bm["dl"], self.bm["avgdl"]
        for w in set(tokenize(q)):
            p = self.bm["post"].get(w)
            if p is None:
                continue
            di, tf = p
            score[di] += self.idf[w] * tf * (k1 + 1) / (tf + k1 * (1 - b + b * dl[di] / avg))
        if ids is not None:
            mask = np.zeros(N, dtype=bool)
            mask[ids] = True
            score[~mask] = 0
        top = np.argpartition(-score, min(k, N - 1))[:k]
        top = top[np.argsort(-score[top])]
        return [(int(i), float(score[i])) for i in top if score[i] > 0]

    # ---- main search
    def search(self, queries, companies=None, prefer_tables=False, final_k=C.FINAL_K):
        """queries: list[str] (first = main rewrite). companies: list of company keys or None."""
        scopes = [(c, self.company_ids[c]) for c in (companies or []) if c in self.company_ids] or [(None, None)]
        qvecs = self._embed(queries)
        fused = {}      # idx -> score
        best_dense = 0.0
        per_scope = {}
        for sname, ids in scopes:
            sc = {}
            for qi, (q, qv) in enumerate(zip(queries, qvecs)):
                w = 1.0 if qi == 0 else 0.7
                dn = self._dense(qv, ids, C.DENSE_K)
                bm = self._bm25(q, ids, C.BM25_K)
                if dn:
                    best_dense = max(best_dense, dn[0][1])
                for r, (i, _) in enumerate(dn):
                    sc[i] = sc.get(i, 0) + w / (C.RRF_K + r)
                for r, (i, _) in enumerate(bm):
                    sc[i] = sc.get(i, 0) + w / (C.RRF_K + r)
            for i in sc:
                m = self.meta[i]
                if prefer_tables and m["kind"] == "table":
                    sc[i] *= 1.35 * (1.3 if m["stmt"] else 1.0) * (1.6 if PRIMARY_STMT.search(m["title"]) else 1.0)
                if m["ctype"] in ("heading", "figure"):
                    sc[i] *= 0.7
            per_scope[sname] = sorted(sc.items(), key=lambda x: -x[1])
        # balanced pick: round-robin across companies so one company cannot exhaust the evidence budget
        n_scopes = len(scopes)
        lists = [lst for lst in per_scope.values()]
        picked = []
        for r in range(max(final_k, 1)):
            for lst in lists:
                if r < len(lst):
                    picked.append(lst[r])
        picked = picked[: final_k * (1 if n_scopes == 1 else n_scopes) // (1 if n_scopes == 1 else 1)] if n_scopes == 1 else picked[: max(final_k, 6 * n_scopes)]
        return picked, best_dense

    def window(self, i, fwd=4, back=1, cap=C.TEXT_ITEM_CHARS):
        """Contiguous same-doc text chunks around hit i (forward-heavy: answers follow headings/questions)."""
        m = self.meta[i]
        idxs = [i]
        total = len(m["text"])
        for step, rng in ((1, fwd), (-1, back)):
            j = i
            for _ in range(rng):
                j += step
                if not (0 <= j < len(self.meta)):
                    break
                n = self.meta[j]
                if n["doc_id"] != m["doc_id"] or n["kind"] != "text" or abs((n["page"] or 0) - (m["page"] or 0)) > 1:
                    break
                if n["ctype"] in ("subsection_summary", "section_summary", "doc_summary") or total + len(n["text"]) > cap:
                    break
                total += len(n["text"])
                idxs.append(j) if step == 1 else idxs.insert(0, j)
        return idxs

    def pack(self, picked, budget=C.EVIDENCE_CHAR_BUDGET):
        """Return evidence list [{cid, idx, label, text, ...}] under a char budget."""
        ev, used, seen = [], 0, set()
        for rank, (i, s) in enumerate(picked):
            if i in seen:
                continue
            seen.add(i)
            m = self.meta[i]
            text = m["text"]
            if m["kind"] == "text" and m["ctype"] not in ("subsection_summary", "section_summary", "doc_summary") and rank < 5:
                cap = 2400 if rank < 3 else C.TEXT_ITEM_CHARS
                w = [j for j in self.window(i, fwd=6, cap=cap) if j == i or j not in seen]
                seen.update(w)
                text = "\n".join(self.meta[j]["text"] for j in w)
            if m["kind"] == "table":
                text = re.sub(r"\n\|[\s:|-]+\|(?=\n|$)", "", text)      # drop markdown separator row
                text = re.sub(r"[ \t]{2,}", " ", text)
                text = re.sub(r"(\| *)+\|\s*$", "|", text, flags=re.M)   # trailing empty cells
            lim = (C.TABLE_ITEM_CHARS + 900 if m["stmt"] else C.TABLE_ITEM_CHARS) if m["kind"] == "table" else 2400
            if len(text) > lim:
                text = text[:lim] + " …[truncated]"
            if used + len(text) > budget and ev:
                continue
            used += len(text)
            ev.append(dict(cid=f"C{len(ev)+1}", idx=i, score=round(s, 4), company=m["company"],
                           doc_id=m["doc_id"], kind=m["kind"], section=m["section"] or m["toc"],
                           title=m["title"], page=m["page"], stmt=m["stmt"], unit=m["unit"], text=text))
        return ev
