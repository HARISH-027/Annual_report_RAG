// Conversation history is client-side only (the backend is stateless).
const KEY = 'finora.conversations.v1';
const MAX = 30;

export const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
};

export function loadConversations() { return store.get(KEY, []); }

export function saveConversations(list) {
  list = list.slice(0, MAX);
  while (list.length && !store.set(KEY, list)) list.pop();   // quota: drop oldest until it fits
  return list;
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export function relTime(ts) {
  const d = (Date.now() - ts) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return Math.floor(d / 60) + ' min ago';
  if (d < 86400) return Math.floor(d / 3600) + ' h ago';
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
