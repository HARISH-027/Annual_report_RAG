"""Single agent: rephrase + classify + plan (rule fast-path or one tiny LLM call) -> read skills -> retrieve -> grounded answer."""
import json, re, time, hashlib
from collections import OrderedDict
import httpx
from . import config as C
from .skills import load_skills, INTENT_SKILLS
from .retriever import Retriever

INTENTS = ["audit", "observations", "risk", "painpoint", "financial", "compare", "general", "out_of_scope"]
NOT_FOUND = "Not found in the available reports."

KW = {
    "observations": r"observation|management letter|audit finding|red flag|concern",
    "audit": r"\baudit|auditor|\bkam\b|key audit|caro|qualif|emphasis of matter|going concern|internal financial control|\bcompliance|\bcomment",
    "risk": r"\brisk|exposure|vulnerab|threat|contingent|litigation",
    "painpoint": r"pain ?point|challenge|problem|weakness|headwind|difficult|bottleneck|struggl",
    "financial": r"revenue|income|profit|\bpat\b|\bpbt\b|ebitda|margin|asset|liabilit|cash ?flow|borrowing|debt|dividend|\beps\b|turnover|expense|capex|ratio|net worth|balance sheet",
    "compare": r"compar|versus|\bvs\.?\b|difference between|better than|rank|highest|lowest|which company",
}
DOMAIN = re.compile(r"annual report|fy ?\d|20\d\d|company|board|director|crore|lakh|production|sales|employee|csr|"
                    + "|".join(KW.values()), re.I)

SYSTEM = (
    "You are an annual-report analyst. Answer ONLY from the EVIDENCE blocks provided. "
    "You have no other knowledge: never use outside facts, memory, or assumptions, and never invent numbers.\n"
    "Rules:\n"
    "1. Every factual sentence/number must end with its citation like [C1] or [C2][C5]; in tables put the citation inside each row. Use only ids present in EVIDENCE.\n"
    "2. Copy numbers exactly with their unit and period (FY 2024-25 unless the evidence says otherwise). Do not convert units or round; if another unit is needed, say it requires conversion. Note standalone vs consolidated when stated.\n"
    f"3. If the evidence does not contain the answer, reply exactly: {NOT_FOUND} and one line on what is missing. If only partly answerable, answer that part and state what is missing.\n"
    "4. Keep it concise and structured (short headings, bullets, markdown tables). No preamble, no restating the question.\n"
    "5. Reports covered: only the companies appearing in EVIDENCE; say so if the user asks about any other entity."
)

PLAN_SYS = (
    "You route questions about annual reports of: ONGC, OVL (ONGC Videsh), IRCTC, Hindustan_Copper, SAIL (FY2024-25). "
    "Return ONE JSON object, no prose: "
    '{"q":"standalone rewritten query (resolve pronouns from history, expand abbreviations)",'
    '"intent":"audit|observations|risk|painpoint|financial|compare|general|out_of_scope",'
    '"companies":["keys from the list, [] if all/unspecified"],'
    '"sub":["up to 2 extra short search queries that would retrieve missing evidence"]}. '
    "intent=out_of_scope only if unrelated to company annual reports/finance/audit."
)


def alias_companies(q):
    ql = " " + q.lower() + " "
    found = []
    for key, (_, aliases) in C.COMPANIES.items():
        for a in aliases:
            if re.search(r"(?<![a-z])" + re.escape(a) + r"(?![a-z])", ql):
                found.append(key)
                break
    if "OVL" in found and "ONGC" in found and "videsh" in ql:
        found.remove("ONGC")
    return found


def detect_intent(q):
    for intent in ["observations", "audit", "risk", "painpoint", "compare", "financial"]:
        if re.search(KW[intent], q, re.I):
            return intent
    return None


class Agent:
    def __init__(self):
        self.retriever = Retriever()
        self.skills = load_skills()
        self.cache = OrderedDict()
        self.http = httpx.Client(timeout=180)

    # ---------- LLM
    def llm(self, messages, max_tokens):
        body = {"model": C.OPENROUTER_MODEL, "messages": messages, "max_tokens": max_tokens,
                "temperature": 0, "reasoning": {"enabled": False}}
        last = None
        for attempt in range(5):
            try:
                r = self.http.post(C.OPENROUTER_URL, headers={"Authorization": "Bearer " + C.OPENROUTER_API_KEY},
                                   json=body)
                d = r.json()
                if "choices" in d and d["choices"] and d["choices"][0]["message"].get("content"):
                    u = d.get("usage", {})
                    return d["choices"][0]["message"]["content"], u.get("prompt_tokens", 0), u.get("completion_tokens", 0)
                last = d.get("error", {}).get("message", str(d)[:200])
            except Exception as e:  # network / json
                last = str(e)
            time.sleep(min(2 ** attempt, 12))
        raise RuntimeError(f"LLM unavailable: {last}")

    # ---------- plan (same agent)
    def plan(self, query, history, forced_companies, forced_skills):
        trace = []
        companies = forced_companies or alias_companies(query)
        intent = detect_intent(query)
        tokens = [0, 0]
        confident = bool(intent) and (companies or DOMAIN.search(query)) and not history
        plan = dict(q=query, intent=intent or "general", companies=companies, sub=[])
        if confident:
            trace.append("Routing: rule-based fast path (no LLM call)")
        else:
            h = ""
            if history:
                h = "History:\n" + "\n".join(f"U: {t['q'][:200]}\nA: {t['a'][:250]}" for t in history[-2:]) + "\n"
            try:
                out, pt, ct = self.llm([{"role": "system", "content": PLAN_SYS},
                                        {"role": "user", "content": h + "Question: " + query}], C.PLAN_MAX_TOKENS)
                tokens = [pt, ct]
                m = re.search(r"\{.*\}", out, re.S)
                p = json.loads(m.group(0)) if m else {}
                if p.get("q"):
                    plan["q"] = str(p["q"])[:400]
                if p.get("intent") in INTENTS:
                    plan["intent"] = p["intent"]
                pc = [c for c in p.get("companies", []) if c in C.COMPANIES]
                plan["companies"] = forced_companies or pc or alias_companies(plan["q"]) or companies
                plan["sub"] = [str(s)[:200] for s in p.get("sub", [])][:2]
                trace.append("Routing: LLM planner (rephrase + classify)")
            except Exception as e:
                trace.append(f"Planner failed ({e}); fell back to rules")
                if not DOMAIN.search(query) and not companies:
                    plan["intent"] = "out_of_scope"
        if plan["intent"] == "general" and detect_intent(plan["q"]):
            plan["intent"] = detect_intent(plan["q"])
        names = forced_skills if forced_skills else INTENT_SKILLS.get(plan["intent"], [])
        plan["skills"] = [s for s in names if s in self.skills]
        return plan, trace, tokens

    # ---------- answer
    def answer(self, query, history=None, companies=None, skills=None):
        t0 = time.time()
        key = hashlib.md5(json.dumps([query.strip().lower(), sorted(companies or []), sorted(skills or []),
                                      bool(history)]).encode()).hexdigest()
        if key in self.cache:
            res = dict(self.cache[key])
            res["cached"] = True
            return res
        plan, trace, (pt1, ct1) = self.plan(query, history or [], companies, skills)
        res = dict(plan=plan, trace=trace, evidence=[], answer="", grounding=None,
                   usage=dict(prompt=pt1, completion=ct1, calls=1 if pt1 else 0), cached=False)
        if plan["intent"] == "out_of_scope":
            res["answer"] = (NOT_FOUND + " This assistant only answers from the FY 2024-25 annual reports of "
                             "ONGC, OVL, IRCTC, Hindustan Copper and SAIL.")
            res["trace"].append("Out of scope - no retrieval, no answer LLM call")
            return self._finish(res, key, t0)

        # queries: rewritten + planner sub-queries + skill hints (hints are local-only, free)
        scope_names = [C.COMPANIES[c][0] for c in plan["companies"]] or ["annual report"]
        core = plan["q"]
        if plan["companies"]:   # company filter already scopes retrieval; names only add noise to the query
            for c in plan["companies"]:
                for a in C.COMPANIES[c][1] + [C.COMPANIES[c][0]]:
                    core = re.sub(r"(?i)(?<![a-z])" + re.escape(a) + r"(?![a-z])('s)?", " ", core)
            core = re.sub(r"(?i)(compare|comparison|versus|vs\.?|and|of|between|the)", " ", core)
            core = re.sub(r"\s+", " ", core).strip(" ,?.")
            if len(core.split()) < 2:
                core = plan["q"]
        queries = [core] + plan["sub"]
        hint_skills = plan["skills"] + (["financial_analysis"] if plan["intent"] == "compare" and "financial_analysis" not in plan["skills"] else [])
        for sk in hint_skills:
            for hint in self.skills[sk].queries[:5]:
                queries.append(f"{scope_names[0] if len(scope_names) == 1 else ''} {hint}".strip())
        queries = list(dict.fromkeys(queries))[:7]
        prefer_tables = plan["intent"] in ("financial", "compare") or bool(re.search(r"\d|total|amount|crore|lakh", plan["q"]))
        broad = plan["intent"] in ("risk", "painpoint", "observations", "audit")
        picked, best = self.retriever.search(queries, plan["companies"] or None, prefer_tables,
                                             final_k=C.FINAL_K + (2 if broad else 0))
        ev = self.retriever.pack(picked)
        res["evidence"] = ev
        res["trace"].append(f"Retrieved {len(ev)} evidence items ({len(queries)} queries, hybrid dense+BM25, best dense {best:.2f})")
        if not ev:
            res["answer"] = NOT_FOUND
            return self._finish(res, key, t0)

        ev_txt = "\n\n".join(
            f"[{e['cid']}] {C.COMPANIES.get(e['company'], (e['company'],))[0]} | {e['kind']} | p.{e['page']} | "
            f"{(e['title'] or e['section'])[:90]}{' | ' + e['stmt'] if e['stmt'] else ''}\n{e['text']}" for e in ev)
        skill_txt = "\n\n".join(f"SKILL ({self.skills[s].title}):\n{self.skills[s].body}" for s in plan["skills"])
        user = (f"{skill_txt}\n\n" if skill_txt else "") + f"EVIDENCE:\n{ev_txt}\n\nQUESTION: {plan['q']}"
        out, pt, ct = self.llm([{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}],
                               C.ANSWER_MAX_TOKENS)
        res["usage"]["prompt"] += pt
        res["usage"]["completion"] += ct
        res["usage"]["calls"] += 1
        res["answer"], res["grounding"] = self.verify(out.strip(), ev)
        res["trace"].append("Answer generated and verified against evidence")
        return self._finish(res, key, t0)

    def _finish(self, res, key, t0):
        res["seconds"] = round(time.time() - t0, 1)
        res["evidence"] = [{k: v for k, v in e.items() if k != "idx"} for e in res["evidence"]]
        self.cache[key] = res
        if len(self.cache) > 200:
            self.cache.popitem(last=False)
        return res

    # ---------- grounding check
    def verify(self, text, ev):
        ids = {e["cid"] for e in ev}
        bad = [c for c in set(re.findall(r"\[(C\d+)\]", text)) if c not in ids]
        for c in bad:
            text = text.replace(f"[{c}]", "")
        blob = " ".join(e["text"] for e in ev).replace(",", "")
        nums, miss = 0, []
        for line in text.splitlines():
            if re.search(r"computed|calculated", line, re.I):
                continue
            for n in re.findall(r"(?<![\w.])\d[\d,]*\.?\d*(?![\w])", re.sub(r"\[C\d+\]", "", line)):
                n2 = n.replace(",", "").rstrip(".")
                if len(n2.replace(".", "")) < 3 or re.fullmatch(r"(19|20)\d\d", n2):
                    continue
                nums += 1
                if n2 not in blob:
                    miss.append(n)
        cited = len(re.findall(r"\[C\d+\]", text))
        status = "verified" if not miss and (cited or text.startswith(NOT_FOUND)) else ("partial" if cited else "unverified")
        return text, dict(status=status, numbers_checked=nums, numbers_unmatched=sorted(set(miss))[:8],
                          citations=cited, invalid_citations_removed=len(bad))
