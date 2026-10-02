// On-device persistence (IndexedDB). Doc JSON and page PNGs are written in one
// transaction so a torn save never leaves JSON pointing at missing ink.
import type { DocJson } from './doc.js';

const DB_NAME = 'manga-name-studio';
const DB_VERSION = 1;
const STORES = ['meta', 'docs', 'inks', 'clips', 'pdfs'] as const;
const LAST_KEY = 'mns:lastProject';

export interface ProjectMeta {
  id: string;
  name: string;
  updatedAt: number;
  pageCount: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // A closed or upgraded connection must not be reused forever (silent save stall).
      const drop = () => {
        db.close();
        dbPromise = null;
      };
      db.onclose = drop;
      db.onversionchange = drop;
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

function done(tx: IDBTransaction, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        tx.abort();
      } catch {
        // already finished
      }
      dbPromise = null;
      reject(new Error('IndexedDB transaction timed out'));
    }, timeoutMs);
    tx.oncomplete = () => {
      clearTimeout(timer);
      resolve();
    };
    tx.onabort = () => {
      clearTimeout(timer);
      reject(tx.error ?? new Error('transaction aborted'));
    };
    tx.onerror = () => {
      clearTimeout(timer);
      reject(tx.error);
    };
  });
}

function get<T>(store: (typeof STORES)[number], key: string): Promise<T | undefined> {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const req = db.transaction(store).objectStore(store).get(key);
        req.onsuccess = () => resolve(req.result as T | undefined);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function listProjects(): Promise<ProjectMeta[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction('meta').objectStore('meta').getAll();
    req.onsuccess = () =>
      resolve((req.result as ProjectMeta[]).sort((a, b) => b.updatedAt - a.updatedAt));
    req.onerror = () => reject(req.error);
  });
}

export const loadDoc = (id: string) => get<DocJson>('docs', id);
export const loadInk = (projectId: string, pageId: string) =>
  get<Blob>('inks', `${projectId}:${pageId}`);
export const loadClip = (projectId: string, clipId: string) =>
  get<Blob>('clips', `${projectId}:${clipId}`);
export const loadPdf = (projectId: string) =>
  get<{ name: string; data: ArrayBuffer }>('pdfs', projectId);

export async function saveProject(
  doc: DocJson,
  inks: ReadonlyMap<string, Blob>,
  clips: ReadonlyMap<string, Blob>,
  removedInks: readonly string[],
  removedClips: readonly string[],
): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(['meta', 'docs', 'inks', 'clips'], 'readwrite');
  const inkStore = tx.objectStore('inks');
  const clipStore = tx.objectStore('clips');
  for (const [pageId, blob] of inks) inkStore.put(blob, `${doc.id}:${pageId}`);
  for (const [clipId, blob] of clips) clipStore.put(blob, `${doc.id}:${clipId}`);
  for (const pageId of removedInks) inkStore.delete(`${doc.id}:${pageId}`);
  for (const clipId of removedClips) clipStore.delete(`${doc.id}:${clipId}`);
  tx.objectStore('docs').put(doc, doc.id);
  const meta: ProjectMeta = {
    id: doc.id,
    name: doc.name,
    updatedAt: doc.updatedAt,
    pageCount: doc.order.length,
  };
  tx.objectStore('meta').put(meta, doc.id);
  await done(tx);
}

export async function savePdf(projectId: string, name: string, data: ArrayBuffer): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('pdfs', 'readwrite');
  tx.objectStore('pdfs').put({ name, data }, projectId);
  await done(tx);
}

export async function renameProject(id: string, name: string): Promise<void> {
  const doc = await loadDoc(id);
  if (doc == null) return;
  doc.name = name;
  doc.updatedAt = Date.now();
  await saveProject(doc, new Map(), new Map(), [], []);
}

/** Delete pixels first, meta last: a failed delete leaves the project listed. */
export async function deleteProject(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(['meta', 'docs', 'inks', 'clips', 'pdfs'], 'readwrite');
  const range = IDBKeyRange.bound(`${id}:`, `${id}:￿`);
  tx.objectStore('inks').delete(range);
  tx.objectStore('clips').delete(range);
  tx.objectStore('pdfs').delete(id);
  tx.objectStore('docs').delete(id);
  tx.objectStore('meta').delete(id);
  await done(tx);
  if (lastProjectId() === id) localStorage.removeItem(LAST_KEY);
}

export function lastProjectId(): string | null {
  try {
    return localStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
}

export function rememberProject(id: string): void {
  try {
    localStorage.setItem(LAST_KEY, id);
  } catch {
    // Private mode: the project list still works, only auto-reopen is lost.
  }
}

export function requestPersistentStorage(): void {
  void navigator.storage?.persist?.().catch(() => undefined);
}
