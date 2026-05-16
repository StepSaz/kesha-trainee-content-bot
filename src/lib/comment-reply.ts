// EXPERIMENT (2026-05-15): tool-use comment replies — see CLAUDE.md
// Pure helpers extracted from kesha-boss-background.mts so the context-building
// and prompt-composition logic can be tested without Netlify Blobs / Telegram /
// Anthropic mocks. The handler still owns rate limiting, history, and IO.

export interface TelegramEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id?: string;
  width?: number;
  height?: number;
  file_size?: number;
}

export interface ReplyToMessageLike {
  message_id?: number;
  text?: string;
  caption?: string;
  entities?: TelegramEntity[];
  caption_entities?: TelegramEntity[];
  photo?: TelegramPhotoSize[];
  media_group_id?: string;
}

export interface PostContext {
  postText: string;
  postUrls: string[];
  photoFileId?: string;
  inMediaGroup: boolean;
  hasCaption: boolean;
}

export type CommentIntent = 'expand' | 'explain' | 'compare' | 'freeform';

const URL_LIMIT = 5;

export function parseCommentIntent(text: string): CommentIntent {
  const t = text.toLowerCase();
  if (/расширь|подробнее|больше/.test(t)) return 'expand';
  if (/объясни|что значит|что такое/.test(t)) return 'explain';
  if (/сравни|vs\b|versus/.test(t)) return 'compare';
  return 'freeform';
}

export function extractPostContext(reply: ReplyToMessageLike | undefined): PostContext {
  const sourceText = reply?.text ?? reply?.caption ?? '';
  const hasCaption = sourceText.length > 0;
  const photoFileId = reply?.photo && reply.photo.length > 0
    ? reply.photo[reply.photo.length - 1].file_id
    : undefined;
  const inMediaGroup = !!reply?.media_group_id;
  const postText = hasCaption
    ? sourceText
    : (photoFileId ? '[пост без подписи, только картинка]' : '[текст поста недоступен]');

  const entities = reply?.entities ?? reply?.caption_entities ?? [];
  const urlSet = new Set<string>();
  for (const e of entities) {
    if (e.type === 'text_link' && e.url) {
      if (/^https:\/\//i.test(e.url)) urlSet.add(e.url);
    } else if (e.type === 'url') {
      const slice = sourceText.slice(e.offset, e.offset + e.length);
      if (/^https:\/\//i.test(slice)) urlSet.add(slice);
    }
  }
  const postUrls = Array.from(urlSet).slice(0, URL_LIMIT);

  return { postText, postUrls, photoFileId, inMediaGroup, hasCaption };
}

export function buildPostMetaLines(ctx: PostContext): string[] {
  const lines: string[] = [];
  if (!ctx.photoFileId && !ctx.inMediaGroup) {
    lines.push('Тип поста: только текст (картинок нет).');
  } else if (ctx.photoFileId && !ctx.inMediaGroup) {
    lines.push('Тип поста: текст с одной картинкой. Чтобы посмотреть её содержимое — вызови view_image().');
  } else if (ctx.photoFileId && ctx.inMediaGroup) {
    lines.push('Тип поста: одна картинка из медиагруппы — ты видишь только её, остальные недоступны. Если читатель спросит про другие картинки в посте, честно скажи, что не видишь их. Чтобы посмотреть доступную картинку — view_image().');
  }
  if (ctx.postUrls.length > 0) {
    lines.push(`Ссылки в посте: ${ctx.postUrls.join(' ')}. Если читателю важно узнать, что по конкретной ссылке — вызови extract_url(url).`);
  }
  return lines;
}

export const INTENT_INSTRUCTIONS: Record<CommentIntent, (userName: string) => string> = {
  expand: u => `${u} просит развернуть тему подробнее. Напиши 2-3 абзаца, углубись в детали.`,
  explain: u => `${u} просит объяснить проще. Объясни как для умного нетехнического человека.`,
  compare: u => `${u} просит сравнение. Сравни кратко — что лучше, хуже, в каком контексте.`,
  freeform: u => `${u} написал комментарий к посту. Ответь по делу, в своём стиле стажёра.`,
};

export interface ComposeUserMessageArgs {
  isFirstTurn: boolean;
  postContext: PostContext;
  userName: string;
  commentText: string;
  intent: CommentIntent;
  previousPostsBlock?: string;
}

export function composeCommentUserMessage(args: ComposeUserMessageArgs): string {
  const intentInstruction = INTENT_INSTRUCTIONS[args.intent](args.userName);

  if (!args.isFirstTurn) {
    return `${args.userName}: "${args.commentText}"\n\n${intentInstruction}`;
  }

  const metaLines = buildPostMetaLines(args.postContext);
  const postMeta = metaLines.length > 0 ? `\n${metaLines.join('\n')}` : '';
  const previousBlock = args.previousPostsBlock ?? '';

  return `Контекст текущего поста:\n${args.postContext.postText}${postMeta}${previousBlock}\n\nКомментарий ${args.userName}: "${args.commentText}"\n\n${intentInstruction}`;
}
