import { getStore } from '@netlify/blobs';

export interface MemoryEntry {
  url: string;
  title: string;
  publishedAt: string;
  postId: number | null;
}

const BLOB_KEY = 'memory-v1';
const MAX_ENTRIES = 40;

const TOPIC_REGEX = /\d+\.\s+\[T\d\]\s+(.+?)\s+\((?:hn|web)\)/g;

export async function loadMemory(): Promise<MemoryEntry[]> {
  try {
    const store = getStore('kesha');
    const existing = await store.get(BLOB_KEY, { type: 'json' }) as MemoryEntry[] | null;
    if (existing) return existing;

    const oldTopics = await store.get('published-topics', { type: 'json' }) as string[] | null;
    if (!oldTopics || oldTopics.length === 0) return [];

    const now = new Date().toISOString();
    const entries: MemoryEntry[] = [];
    for (const topicStr of oldTopics) {
      for (const match of topicStr.matchAll(TOPIC_REGEX)) {
        entries.push({ url: '', title: match[1], publishedAt: now, postId: null });
      }
    }
    if (entries.length > 0) await store.setJSON(BLOB_KEY, entries);
    return entries;
  } catch {
    return [];
  }
}

export async function appendMemory(entries: MemoryEntry[]): Promise<void> {
  try {
    const store = getStore('kesha');
    const existing = await store.get(BLOB_KEY, { type: 'json' }) as MemoryEntry[] | null ?? [];
    const updated = [...existing, ...entries].slice(-MAX_ENTRIES);
    await store.setJSON(BLOB_KEY, updated);
  } catch {
    // non-fatal
  }
}
