// Work that is on the screen but not yet saved.
//
// Sending the app to the background used to blank the page outright — that
// was an auth bug and it is fixed. But Android is still free to kill a
// WebView under memory pressure, and a browser tab can still be closed by
// accident. Losing a typed menu costs five minutes; losing a scanned invoice
// costs the photo, the scan and the whole bill typed back in.
//
// IndexedDB rather than localStorage because the bill photo goes in here too
// — a phone photo as base64 runs to several megabytes and would blow the 5 MB
// localStorage quota, taking whatever else was in there down with it.

const DB = "slp-drafts", STORE = "drafts";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

// A draft is a convenience, never the record. If the browser refuses — private
// mode, no quota, no IndexedDB at all — the app carries on as it did before
// rather than failing in front of the store keeper.
export async function saveDraft(key: string, value: unknown): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put({ value, at: Date.now() }, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch { /* nothing was lost that wasn't already unsaved */ }
}

// Anything older than a day is not "where I left off", it is a stale copy of
// last week's bill waiting to be saved against today's date by mistake.
export async function loadDraft<T>(key: string, maxAgeMs = 24 * 60 * 60 * 1000): Promise<T | null> {
  try {
    const db = await open();
    const row = await new Promise<any>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const q = tx.objectStore(STORE).get(key);
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => reject(q.error);
    });
    db.close();
    if (!row) return null;
    if (Date.now() - row.at > maxAgeMs) { clearDraft(key); return null; }
    return row.value as T;
  } catch { return null; }
}

// One phone gets shared — the store keeper signs out and the chef signs in on
// the same handset. A draft is one person's unfinished work, including the
// photo of a bill, and it does not belong to whoever logs in next.
export async function clearAllDrafts(): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    db.close();
  } catch { /* ignore */ }
}

export async function clearDraft(key: string): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    db.close();
  } catch { /* ignore */ }
}
