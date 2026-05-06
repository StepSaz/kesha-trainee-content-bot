import { getStore } from '@netlify/blobs';

export interface MemoryEntry {
  url: string;
  title: string;
  publishedAt: string;
  postId: number | null;
}

const BLOB_KEY = 'memory-v1';
const MAX_ENTRIES = 40;

export async function loadMemory(): Promise<MemoryEntry[]> {
  try {
    const store = getStore('kesha');
    const existing = await store.get(BLOB_KEY, { type: 'json' }) as MemoryEntry[] | null;
    if (existing) return existing;

    const oldTopics = await store.get('published-topics', { type: 'json' }) as string[] | null;
    if (!oldTopics || oldTopics.length === 0) return [];

    // Regex defined inside the function to avoid global-flag lastIndex state issues across calls
    const TOPIC_REGEX = /\d+\.\s+\[T\d+\]\s+(.+?)\s+\((?:hn|web)\)/g;

    // migrated entries use epoch — they predate normalized memory
    const migratedPublishedAt = new Date(0).toISOString();
    const entries: MemoryEntry[] = [];
    for (const topicStr of oldTopics) {
      for (const match of topicStr.matchAll(TOPIC_REGEX)) {
        entries.push({ url: '', title: match[1], publishedAt: migratedPublishedAt, postId: null });
      }
    }
    if (entries.length > 0) await store.setJSON(BLOB_KEY, entries);
    return entries;
  } catch (err) {
    console.warn('[memory] loadMemory error:', err);
    return [];
  }
}

export async function appendMemory(entries: MemoryEntry[]): Promise<void> {
  try {
    const store = getStore('kesha');
    const existing = await store.get(BLOB_KEY, { type: 'json' }) as MemoryEntry[] | null ?? [];
    const updated = [...existing, ...entries].slice(-MAX_ENTRIES);
    await store.setJSON(BLOB_KEY, updated);
  } catch (err) {
    console.warn('[memory] appendMemory error:', err);
  }
}
