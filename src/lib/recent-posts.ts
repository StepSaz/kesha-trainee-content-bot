import { getStore } from '@netlify/blobs';

export interface PublishedPost {
  channelMessageId: number | null;
  publishedAt: string;
  text: string; // compact: topic titles joined by ', ' (or first 200 chars for non-digest posts)
}

const BLOB_KEY = 'recent-posts-v2';
const MAX_POSTS = 5;

// Extracts a compact one-line summary from a post.
// For digest posts (contain '~ ~ ~'): joins the first line of each section after the intro.
// For other posts: returns the first 200 chars.
export function summarisePost(fullText: string): string {
  const SEP = '~ ~ ~';
  const parts = fullText.split(SEP);
  if (parts.length < 2) return fullText.trim().slice(0, 200);

  const JUNK = /^(Если|Смотрю|@|\(|Пилотный|Коротко)/;
  const topics = parts.slice(1)
    .map(s => s.trim().split('\n')[0].replace(/^[🤖👀\d\.\s]+/, '').trim())
    .filter(t => t.length > 5 && t.length < 120 && !JUNK.test(t));

  return topics.join(', ');
}

// Historical seed — Kesha posts before recent-posts-v2 blob existed.
// Each entry is a compact topic list, not full text.
const SEED_POSTS: PublishedPost[] = [
  {
    channelMessageId: 203,
    publishedAt: '2026-04-10T09:23:17+00:00',
    text: 'Claude Mythos Preview (AI нашёл тысячи уязвимостей), ChatGPT Pro $100/мес, MCP 97 млн установок, Gemini 750 млн пользователей + Flash Live, Microsoft Agent Framework 1.0',
  },
  {
    channelMessageId: 207,
    publishedAt: '2026-04-16T20:06:32+00:00',
    text: 'Claude Opus 4.7, Gemini 3.1 Pro + 750 млн MAU, ChatGPT Pro $100, Mozilla Thunderbolt (открытый AI-клиент), Qwen 3.6 35B A3B (локальная модель)',
  },
  {
    channelMessageId: 216,
    publishedAt: '2026-04-23T14:03:18+00:00',
    text: 'ChatGPT Images 2.0 с reasoning, Claude Design (прототипы из промпта), OpenAI Workspace Agents, Meta MTIA-чипы в дата-центрах',
  },
  {
    channelMessageId: 222,
    publishedAt: '2026-04-30T14:06:57+00:00',
    text: 'GPT-5.5, Gemini Drop (Mac-приложение + Personal Intelligence), Google $40 млрд в Anthropic, DeepSeek V4 открытые веса, Adobe Photoshop Firefly Image 5',
  },
  {
    channelMessageId: 226,
    publishedAt: '2026-05-04T15:29:14+00:00',
    text: 'Стрим Степана: синхронизация контекста между AI-провайдерами, работа с лимитами дорогих моделей',
  },
  {
    channelMessageId: 229,
    publishedAt: '2026-05-07T14:04:38+00:00',
    text: 'Claude Code/"OpenClaw" баг, DeepSeek V4, Grok 4.3, Spotify Verified для живых артистов, Google AI-итоги апреля',
  },
];

export async function appendPublishedPost(fullText: string, channelMessageId: number | null): Promise<void> {
  try {
    const store = getStore('kesha');
    const existing = (await store.get(BLOB_KEY, { type: 'json' }) as PublishedPost[] | null) ?? SEED_POSTS;
    const entry: PublishedPost = {
      channelMessageId,
      publishedAt: new Date().toISOString(),
      text: summarisePost(fullText),
    };
    const updated = [...existing, entry].slice(-MAX_POSTS);
    await store.setJSON(BLOB_KEY, updated);
  } catch (err) {
    console.warn('[recent-posts] append error:', err);
  }
}

export async function loadRecentPosts(): Promise<PublishedPost[]> {
  try {
    const store = getStore('kesha');
    const stored = await store.get(BLOB_KEY, { type: 'json' }) as PublishedPost[] | null;
    return stored ?? SEED_POSTS;
  } catch (err) {
    console.warn('[recent-posts] load error:', err);
    return SEED_POSTS;
  }
}
