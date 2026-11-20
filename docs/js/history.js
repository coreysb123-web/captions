// Past conversations, kept only on this phone (IndexedDB).

const DB_NAME = 'captions';
const STORE = 'conversations';
const KEEP = 150; // oldest conversations beyond this are removed

let opening = null;

function db() {
  if (!opening) {
    opening = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return opening;
}

function run(mode, work) {
  return db().then(
    (d) =>
      new Promise((resolve, reject) => {
        const tx = d.transaction(STORE, mode);
        const req = work(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req ? req.result : undefined);
        tx.onerror = tx.onabort = () => reject(tx.error);
      })
  );
}

/** conversation = { id, startedAt, endedAt, turns: [{ who, color, text, at }] } */
export function saveConversation(conversation) {
  return run('readwrite', (s) => s.put(conversation)).catch(() => {});
}

export function deleteConversation(id) {
  return run('readwrite', (s) => s.delete(id)).catch(() => {});
}

export function listConversations() {
  return run('readonly', (s) => s.getAll())
    .then((all) => (all || []).sort((a, b) => b.id - a.id))
    .catch(() => []);
}

export async function pruneConversations() {
  const all = await listConversations();
  for (const old of all.slice(KEEP)) await deleteConversation(old.id);
}

export function whenLabel(ms) {
  const d = new Date(ms);
  const day = d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `${day}, ${time}`;
}

/** Plain text version for sharing or copying. */
export function asText(conversation) {
  const lines = [`Conversation, ${whenLabel(conversation.startedAt)}`, ''];
  for (const turn of conversation.turns) {
    lines.push(`${turn.who}: ${turn.text.replace(/\n+/g, ' ')}`, '');
  }
  return lines.join('\n').trim() + '\n';
}
