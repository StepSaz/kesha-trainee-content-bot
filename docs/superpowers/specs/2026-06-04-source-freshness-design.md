# Source freshness filter (7-day window) at data-gathering

**Дата:** 2026-06-04
**Статус:** дизайн утверждён владельцем (он же автор дизайна), готов к реализации
**Триггер:** E2E-ревью короткого дайджеста — статья "The Dead Economy Theory" (2026-05-01) попала в дайджест за 2026-06-04, хотя окно weekly = последние 7 дней.

## Проблема

Дайджест (и полный, и короткий) должен содержать только новости за последние 7 дней.
Сейчас фильтр свежести неполный, и старые источники протекают в context, который
уходит в `selectTopics` → в пост.

## Диагноз (где именно дыра)

Оба формата собирают контекст из двух функций в `src/lib/sources.ts`:

1. **`fetchHackerNewsContext` (= `fetchSourceContext`)** — HN shir-man feed + RSS
   (Anthropic / OpenAI / TechCrunch AI / Google AI blog). **Фильтра по дате НЕТ.**
   - HN feed (`?sort=week`) отдаёт ~120 элементов, сортированных по `agg_score`,
     режется до `max_items: 15`. Каждый HN-элемент имеет поле `time` (Unix seconds) —
     это дата HN-обсуждения, НЕ дата статьи. Старый evergreen может всплыть свежим
     HN-тредом и пролезть.
   - RSS-элементы имеют `pubDate`/`published`, но `fetchRss` их не извлекает и не фильтрует.
2. **`fetchLightWebSearch`** — Claude + web_search. **Уже** фильтрует программно
   (`item.date >= cutoff`), но доверяет дате, которую вернула модель → модель может
   ошибиться/датировать evergreen свежим числом. Вероятный источник E2E-лика.
3. `fetchWebContext` в `pipeline.ts` — **мёртвый код** (определён, нигде не вызывается).
   Не трогаем (отдельная чистка вне скоупа).

Вывод: чинить в `sources.ts`, в коде сбора, ДО того как текст уйдёт в Claude. НЕ в
`selectTopics` промптом (промпт остаётся только safety-net).

## Дизайн

Cutoff = 7 дней (как у существующего light-web окна). Всё — детерминированно, на
regex/JSON-LD/meta, БЕЗ LLM-датинга (дорого, медленно, опять "надеемся на модель").

### Общие helper'ы (в `src/lib/sources.ts`, экспортируемые для тестов)

```ts
// Возвращает дату-границу: now - days, в начале суток UTC (сравниваем по дате, не времени).
export function getCutoffDate(days = 7, now: Date = new Date()): Date;

// true, если date не старше cutoff. Невалидную/отсутствующую дату НЕ считает свежей.
export function isFreshDate(date: Date | null, cutoff: Date): boolean;

// Достаёт дату публикации из распарсенного RSS/Atom item (pubDate, published, updated, dc:date).
// Возвращает Date | null.
export function extractPublishedDateFromRssItem(item: Record<string, unknown>): Date | null;

// Достаёт дату публикации из HTML: JSON-LD datePublished/dateModified,
// meta article:published_time / datePublished / date / pubdate, <time datetime="...">.
// Возвращает Date | null. Best-effort, на любой ошибке — null.
export function extractPublishedDateFromHtml(html: string): Date | null;
```

### Light web search — минимальная правка

Существующий `item.date >= cutoff` остаётся, но переписан через общие helper'ы
(`getCutoffDate` + сравнение `isFreshDate(new Date(item.date), cutoff)`), чтобы окно
было единым во всех путях. Поведение не меняется.

### RSS — добавить date-фильтр

В `fetchRss`: для каждого item вызвать `extractPublishedDateFromRssItem`.
- дата есть и старше cutoff → **drop**;
- даты НЕТ → **drop** (RSS без даты как источник недельных новостей сомнителен);
- дата свежая → оставить.
Логировать число отброшенных (`[sources] RSS <feed>: dropped N stale/undated`).

### HN (shir-man) — двухступенчатый фильтр

В `fetchHN`: добавить поле `time?: number` в `HNItem`. Для каждого item:
1. `time` отсутствует ИЛИ старше cutoff (HN-обсуждение старое) → **drop** (без fetch).
2. `time` свежий → best-effort `fetch` статьи по `item.url` (таймаут ~6с, на ошибку/не-2xx
   → дата неизвестна), `extractPublishedDateFromHtml`:
   - дата найдена и старше cutoff → **drop** (свежий HN-тред про старую статью — кейс
     Dead Economy);
   - дата найдена и свежая → оставить;
   - дата НЕ найдена → **оставить**, но в строке context добавить пометку
     `Source date: unknown; HN date: YYYY-MM-DD`.

Fetch'и статей идут параллельно (`Promise.all`/`allSettled`) только для прошедших
шаг 1 (≤ max_items). Каждый best-effort, общий сбор не падает из-за одного фейла.

### Cache — версия + cutoff

`CacheEntry` получает `schemaVersion: number` и `cutoffDate: string` (YYYY-MM-DD).
`readCache`: если `schemaVersion` не совпадает с текущей ИЛИ `cutoffDate` != сегодняшний
cutoff → cache miss (игнорируем запись). Иначе старый stale-context может жить в blob
cache ещё час после деплоя.

### Потребители (full / short digest)

`generatePipelinePost` и `generateShortDigest` НЕ меняются по логике — они получают уже
очищенный context. Проверяем тестами, что full digest продолжает получать свежий context,
а short не выбирает stale linked sources.

## Обработка ошибок

- Любой best-effort fetch статьи: таймаут + try/catch → дата неизвестна, не роняем сбор.
- Невалидные даты (`new Date('...')` → Invalid) трактуются как "нет даты" (см. правила выше).
- RSS-фид целиком упал → как сейчас (`allSettled`, секция пропускается).

## Тесты (`src/lib/__tests__/sources.test.ts` + потребители)

- `getCutoffDate` / `isFreshDate`: граничные (ровно 7 дней, 8 дней, сегодня, невалидная дата).
- `extractPublishedDateFromRssItem`: pubDate (RSS), published/updated (Atom), dc:date, отсутствие.
- `extractPublishedDateFromHtml`: JSON-LD datePublished, meta article:published_time,
  `<time datetime>`, отсутствие → null.
- RSS: item со старым pubDate → drop; со свежим → остаётся; без даты → drop.
- HN: старый `time` → drop (без fetch); свежий `time` + старая article meta datePublished
  → drop; свежий `time` + неизвестная дата статьи → остаётся с пометкой `Source date: unknown`.
- light web: старый item по-прежнему отбрасывается (helper не сломал поведение).
- short digest: не выбирает stale linked sources (через замоканный sources, проверка что
  context чистый); full digest получает свежий context.
- cache: запись без `schemaVersion`/`cutoffDate` → cache miss.

## Что НЕ делаем (YAGNI)

- НЕ чиним через `selectTopics`/persona-промпт (остаётся safety-net, не основной фильтр).
- НЕ используем LLM для извлечения дат (regex/JSON-LD/meta достаточно).
- НЕ трогаем мёртвый `fetchWebContext` (отдельная чистка).
- Никакой логики сверх этого фикса.

## Открытые значения для тюнинга

- Таймаут article-fetch (старт ~6с).
- `schemaVersion` стартовое значение (1).
