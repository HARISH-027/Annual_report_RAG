// All network access to the existing backend lives here.
async function readError(res) {
  let detail = '';
  try { detail = (await res.json()).detail; } catch { /* non-JSON body */ }
  const e = new Error(detail || `Request failed (HTTP ${res.status})`);
  e.status = res.status;
  return e;
}

export async function getMeta() {
  const res = await fetch('/api/meta');
  if (!res.ok) throw await readError(res);
  return res.json();
}

const post = (url, payload, signal) => fetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal });

export async function chat(payload, signal) {
  const res = await post('/api/chat', payload, signal);
  if (!res.ok) throw await readError(res);
  return res.json();
}

/** Streams stage events from /api/chat/stream. Rejects with err.noStream=true if the stream could not be used at all. */
export async function chatStream(payload, signal, onStage) {
  let res;
  try { res = await post('/api/chat/stream', payload, signal); }
  catch (e) { if (e.name === 'AbortError') throw e; e.noStream = true; throw e; }
  if (res.status === 404 || res.status === 405 || !res.body) { const e = new Error('Streaming unavailable'); e.noStream = true; throw e; }
  if (!res.ok) throw await readError(res);
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = '', result = null, seen = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      const type = (block.match(/^event: (.*)$/m) || [])[1];
      const data = (block.match(/^data: (.*)$/m) || [])[1];
      if (!type || !data) continue;
      let obj; try { obj = JSON.parse(data); } catch { continue; }
      seen = true;
      if (type === 'stage') onStage(obj);
      else if (type === 'result') result = obj;
      else if (type === 'error') throw new Error(obj.error_message || 'The pipeline failed.');
    }
  }
  if (!result) { const e = new Error('The connection closed before an answer arrived.'); e.noStream = !seen; throw e; }
  return result;
}
