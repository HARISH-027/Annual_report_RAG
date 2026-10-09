"""Stage events fire at real pipeline boundaries. Retriever and LLM are test stubs; no network or index needed."""
from collections import OrderedDict
from rag.agent import Agent
from rag.skills import load_skills


class StubRetriever:
    def search(self, queries, companies, prefer_tables, final_k):
        return [0], 0.6

    def pack(self, picked):
        return [dict(cid="C1", company="SAIL", doc_id="SAIL_2024_2025", kind="text", section="s", title="t",
                     page=3, stmt=None, unit=None, text="Revenue was 1,234 crore", idx=0, score=0.1)]


def make_agent():
    a = object.__new__(Agent)
    a.retriever, a.skills, a.cache = StubRetriever(), load_skills(), OrderedDict()
    def llm(messages, max_tokens):
        if "route questions" in messages[0]["content"]:   # planner call
            return '{"q":"weather","intent":"out_of_scope","companies":[],"sub":[]}', 5, 5
        return "Revenue was 1,234 crore [C1]", 10, 5
    a.llm = llm
    return a


def test_events_in_order_and_result_unchanged():
    seen = []
    res = make_agent().answer("What are SAIL revenue figures?", emit=lambda s, st, m, **k: seen.append((s, st, k)))
    stages = [(s, st) for s, st, _ in seen]
    assert stages[0] == ("plan", "running")
    assert ("retrieve", "completed") in stages and stages.index(("retrieve", "completed")) < stages.index(("generate", "running"))
    assert stages[-1] == ("verify", "completed")
    assert dict(seen[-1][2])["grounding"] == res["grounding"]["status"]
    assert set(res) >= {"plan", "trace", "evidence", "answer", "grounding", "usage", "cached", "seconds"}


def test_out_of_scope_emits_no_retrieval():
    seen = []
    make_agent().answer("What is the weather today?", emit=lambda s, st, m, **k: seen.append(s))
    assert "retrieve" not in seen and "generate" not in seen
