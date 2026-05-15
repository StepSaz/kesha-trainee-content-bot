// EXPERIMENT (2026-05-15): tool-use comment replies — see CLAUDE.md
import type { ToolDef, ToolResult } from './claude.js';
import { tavilyExtract } from './tavily.js';
import { getFileAsBase64 } from './telegram.js';

export const COMMENT_TOOLS: ToolDef[] = [
  {
    name: 'extract_url',
    description:
      'Открой ссылку из поста и получи её содержимое (первые ~3000 символов основного текста). Используй только если читателю нужно знать, что в этой ссылке, или ты явно ссылаешься на её содержимое.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Полный URL, начиная с https://' },
      },
      required: ['url'],
    },
  },
  {
    name: 'view_image',
    description:
      'Посмотри картинку, прикреплённую к посту, под которым задан вопрос. Вызывай только если содержимое картинки нужно для ответа. Если поста с картинкой нет, вернётся сообщение об этом.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
];

export interface CommentToolContext {
  photoFileId?: string;
}

export function makeExecuteTool(
  ctx: CommentToolContext
): (name: string, input: Record<string, unknown>) => Promise<ToolResult> {
  const urlCache = new Map<string, string>();
  let imageLoaded = false;

  return async (name, input) => {
    if (name === 'extract_url') {
      const url = typeof input.url === 'string' ? input.url : '';
      if (!url || !/^https:\/\//i.test(url)) return 'некорректный URL';

      const cached = urlCache.get(url);
      if (cached !== undefined) return cached;

      const content = await tavilyExtract(url);
      if (!content) {
        let host = url;
        try { host = new URL(url).host; } catch { /* keep url */ }
        // Cache the fallback too: prevents retrying the same dead URL within one loop.
        const fallback = `не смог открыть ссылку: ${host}`;
        urlCache.set(url, fallback);
        return fallback;
      }
      urlCache.set(url, content);
      return content;
    }

    if (name === 'view_image') {
      if (!ctx.photoFileId) return 'под комментом нет картинки';
      if (imageLoaded) return 'уже смотрел эту картинку, добавить нечего';
      const image = await getFileAsBase64(ctx.photoFileId);
      if (!image) return 'не смог скачать картинку';
      imageLoaded = true;
      return { kind: 'image', base64: image.base64, mediaType: image.mediaType };
    }

    return `неизвестный инструмент: ${name}`;
  };
}
