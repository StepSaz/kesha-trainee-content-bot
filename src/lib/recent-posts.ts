import { getStore } from '@netlify/blobs';

export interface PublishedPost {
  text: string;
  publishedAt: string;
  channelMessageId: number | null;
}

const BLOB_KEY = 'recent-posts-v1';
const MAX_POSTS = 3;

export async function appendPublishedPost(text: string, channelMessageId: number | null): Promise<void> {
  try {
    const store = getStore('kesha');
    const existing = (await store.get(BLOB_KEY, { type: 'json' }) as PublishedPost[] | null) ?? [];
    const updated = [...existing, { text, publishedAt: new Date().toISOString(), channelMessageId }].slice(-MAX_POSTS);
    await store.setJSON(BLOB_KEY, updated);
  } catch (err) {
    console.warn('[recent-posts] append error:', err);
  }
}

export async function loadRecentPosts(): Promise<PublishedPost[]> {
  try {
    const store = getStore('kesha');
    return (await store.get(BLOB_KEY, { type: 'json' }) as PublishedPost[] | null) ?? [];
  } catch (err) {
    console.warn('[recent-posts] load error:', err);
    return [];
  }
}
