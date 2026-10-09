import asyncio, json, time, uuid
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool
from . import config as C
from .agent import Agent

app = FastAPI(title="Annual Report Analyst")
agent = Agent()


class ChatReq(BaseModel):
    query: str
    history: list[dict] = []
    companies: list[str] = []
    skills: list[str] = []


@app.get("/api/meta")
def meta():
    return dict(
        companies=[dict(key=k, name=v[0]) for k, v in C.COMPANIES.items()],
        skills=[dict(name=s.name, title=s.title, description=s.description) for s in agent.skills.values()],
        model=C.OPENROUTER_MODEL, embed_model=C.EMBED_MODEL, chunks=len(agent.retriever.meta))


@app.post("/api/chat")
async def chat(req: ChatReq):
    q = req.query.strip()
    if not q:
        raise HTTPException(400, "Empty query")
    if len(q) > 1500:
        raise HTTPException(400, "Query too long")
    companies = [c for c in req.companies if c in C.COMPANIES]
    skills = [s for s in req.skills if s in agent.skills]
    try:
        return await run_in_threadpool(agent.answer, q, req.history[-3:], companies, skills)
    except Exception as e:
        raise HTTPException(502, str(e))


@app.post("/api/chat/stream")
async def chat_stream(req: ChatReq):
    """Same pipeline as /api/chat, delivered as server-sent events: `stage` events at real
    pipeline boundaries, then one `result` (identical JSON to /api/chat) or `error` event."""
    q = req.query.strip()
    if not q:
        raise HTTPException(400, "Empty query")
    if len(q) > 1500:
        raise HTTPException(400, "Query too long")
    companies = [c for c in req.companies if c in C.COMPANIES]
    skills = [s for s in req.skills if s in agent.skills]
    request_id = uuid.uuid4().hex[:12]
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()

    def put(kind, data):
        loop.call_soon_threadsafe(queue.put_nowait, (kind, data))

    def emit(stage, status, message, **extra):
        put("stage", dict(request_id=request_id, stage=stage, event_type="stage", status=status,
                          display_message=message, timestamp=time.time(), **extra))

    def work():
        try:
            put("result", agent.answer(q, req.history[-3:], companies, skills, emit=emit))
        except Exception as e:
            put("error", dict(request_id=request_id, status="failed", error_message=str(e)))
        put("end", None)

    async def gen():
        task = loop.run_in_executor(None, work)
        while True:
            kind, data = await queue.get()
            if kind == "end":
                break
            yield f"event: {kind}\ndata: {json.dumps(data)}\n\n"
        await task

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/")
def index():
    return FileResponse(C.UI_DIR / "index.html")


app.mount("/static", StaticFiles(directory=C.UI_DIR), name="static")
