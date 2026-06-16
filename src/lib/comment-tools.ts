// EXPERIMENT (2026-05-15): tool-use comment replies — see CLAUDE.md
// EXPERIMENT (2026-05-18): advisor pattern — consult_advisor escalates to Sonnet.
import { callClaude, type ToolDef, type ToolResult } from './claude.js';
import { tavilyExtract, tavilySearch, type TavilySearchDepth } from './tavily.js';
import { getFileAsBase64 } from './telegram.js';

// Tavily search settings for comment replies. Tuned per Tavily's
// best-practices doc (tavily-ai/skills/skills/tavily-best-practices):
// - 'advanced' depth → chunks-style results, highest relevance (2 credits/call)
// - topic='news'    → time-sensitive AI/tech announcements ranked higher
// - timeRange='week'→ trims old noise when reader asks about recent stuff
// - chunksPerSource=5 → max content per source at advanced depth
// - minScore=0.4    → drops obvious off-topic hits
// - excludeDomains  → strips low-signal forums (reddit/quora) by default
const SEARCH_DEPTH: TavilySearchDepth = 'advanced';
const SEARCH_RESULTS = 5;
const SEARCH_SNIPPET_CHARS = 500;
const SEARCH_LIMIT_PER_CONVERSATION = 2;
const SEARCH_TOPIC = 'news' as const;
const SEARCH_TIME_RANGE = 'week' as const;
const SEARCH_CHUNKS_PER_SOURCE = 5;
const SEARCH_MIN_SCORE = 0.4;
const SEARCH_EXCLUDE_DOMAINS = ['reddit.com', 'quora.com'];

const ADVISOR_MODEL = 'claude-sonnet-4-6';
const ADVISOR_MAX_TOKENS = 400;
const ADVISOR_SYSTEM_PROMPT =
  'Ты старший напарник стажёра-бота Кеши. Кеша работает на дешёвой модели и отвечает на комментарии под постами Telegram-канала про AI/tech. Когда он сомневается — спрашивает тебя. Дай короткий, конкретный совет (1-3 предложения): как лучше ответить, на что обратить внимание, где Кеша ошибается. Не пиши финальный ответ за него — он сам напишет в своём стиле. Без markdown, без em-dash.';

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
  {
    name: 'web_search',
    description:
      'Поиск в вебе (Tavily, advanced depth, без reddit/quora). По умолчанию обычный поиск по релевантности — для фактических вопросов «что такое X / расскажи про X / цифры, цены, бенчмарки». Зови когда читатель просит копнуть глубже / спрашивает факты, которых нет в посте. На "спасибо/что думаешь" не зови. Возвращает топ-5 результатов (title + url + сниппет). Максимум 2 вызова за разговор. Иди в поиск сразу, не предлагай «могу поискать». Запрос делай коротко (под 400 символов), лучше на английском для tech-тем.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Поисковый запрос на том языке, на котором ожидаются источники (для tech-тем обычно en).',
        },
        fresh: {
          type: 'boolean',
          description: 'true ТОЛЬКО если вопрос именно про свежие события (релизы/анонсы/новости за последнюю неделю). Тогда поиск ограничится новостями за 7 дней. Для общих фактических вопросов («что такое X») оставь false/не указывай — иначе свежий новостной фильтр отсечёт релевантные источники.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'consult_advisor',
    description:
      'Спросить совета у старшего напарника (модель поумнее). Зови, если: не уверен в тоне ответа, не понимаешь скрытый смысл комментария, видишь противоречие или сарказм, или вопрос требует фактологии за пределами поста. НЕ зови на простых "спасибо/класс/что думаешь" — справишься сам. Один вызов на разговор. Возвращает короткий совет, а не готовый ответ — финальный текст пишешь ты сам в своём стиле.',
    input_schema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'Конкретный вопрос напарнику: что именно тебя смущает и какой совет нужен. Включи нужный контекст коротко.',
        },
        draft_answer: {
          type: 'string',
          description: 'Опционально: твой черновой ответ, если есть. Напарник скажет, что в нём не так.',
        },
      },
      required: ['question'],
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
  let advisorCalled = false;
  let searchCalls = 0;

  return async (name, input) => {
    if (name === 'web_search') {
      if (searchCalls >= SEARCH_LIMIT_PER_CONVERSATION) {
        return `лимит поисков исчерпан (${SEARCH_LIMIT_PER_CONVERSATION} на разговор), отвечай тем, что есть`;
      }
      const query = typeof input.query === 'string' ? input.query.trim() : '';
      if (!query) return 'нужен непустой query';
      searchCalls += 1;

      // Default to a general relevance search. The news+week filter is great
      // for "what dropped this week" but starves evergreen/factual questions
      // ("what is X") — irrelevant news ranks ~0.02 and gets dropped by
      // minScore, returning nothing. Only opt into news/week when the model
      // flags the question as genuinely recency-sensitive (fresh=true).
      const fresh = input.fresh === true;
      const results = await tavilySearch(query, {
        maxResults: SEARCH_RESULTS,
        depth: SEARCH_DEPTH,
        topic: fresh ? SEARCH_TOPIC : 'general',
        ...(fresh ? { timeRange: SEARCH_TIME_RANGE } : {}),
        chunksPerSource: SEARCH_CHUNKS_PER_SOURCE,
        minScore: SEARCH_MIN_SCORE,
        excludeDomains: SEARCH_EXCLUDE_DOMAINS,
      });
      if (results.length === 0) return 'поиск ничего не вернул';
      return results
        .map((r, i) => `[${i + 1}] ${r.title}\n    URL: ${r.url}\n    ${r.content.slice(0, SEARCH_SNIPPET_CHARS)}`)
        .join('\n\n');
    }

    if (name === 'consult_advisor') {
      if (advisorCalled) return 'уже спрашивал напарника в этом разговоре, справляйся сам';
      const question = typeof input.question === 'string' ? input.question.trim() : '';
      if (!question) return 'нужен непустой question';
      const draft = typeof input.draft_answer === 'string' ? input.draft_answer.trim() : '';
      advisorCalled = true;

      const userMessage = draft
        ? `Вопрос: ${question}\n\nМой черновой ответ:\n${draft}`
        : `Вопрос: ${question}`;

      console.log(`[advisor] called question=${JSON.stringify(question.slice(0, 200))} hasDraft=${draft.length > 0}`);
      try {
        const advice = await callClaude({
          systemPrompt: ADVISOR_SYSTEM_PROMPT,
          userMessage,
          model: ADVISOR_MODEL,
          temperature: 0.4,
          maxTokens: ADVISOR_MAX_TOKENS,
        });
        const trimmed = advice.trim();
        console.log(`[advisor] reply len=${trimmed.length}`);
        return trimmed || 'напарник промолчал, разбирайся сам';
      } catch (err) {
        console.error('[advisor] error:', err);
        return 'напарник недоступен, отвечай сам';
      }
    }

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
