# Короткий дайджест — `/digest short`

**Дата:** 2026-06-03
**Статус:** дизайн утверждён, готов к плану реализации
**Подход:** B — отдельный модуль и отдельные промпты, переиспользование grounded-шагов

## Проблема

Сейчас у Кеши один формат дайджеста — развёрнутый пост (`/digest`): вступление,
секция на каждую тему по 2-3 предложения, вывод. Нужен второй, лёгкий формат:
**новости недели одной строкой + короткий вывод** в конце. Запускается командой
в боте, проходит то же ревью владельцем (превью с кнопками) и публикуется в канал.

## Решение

Новая подкоманда `/digest short`. Полный `/digest` не меняется. Короткий дайджест
живёт в отдельном модуле `src/lib/short-digest.ts` со своими промптами генерации и
ревью. Grounded-шаги (сбор контекста, отбор тем, проверка URL) переиспользуются —
именно там галлюцинации опаснее всего, и менять их незачем.

### Почему Подход B (а не флаг `format` в существующем пайплайне)

- Отдельный промпт проще дорабатывать без риска сломать полный дайджест.
- Меньше условной логики в промптах → меньше шанс галлюцинаций.
- Чистая граница: full digest и short digest можно тюнить независимо.
- Цена — небольшое дублирование review/fix-лупа, принятая осознанно.

## Флоу короткого дайджеста

```
сбор (HN + light web, параллельно, dedup по памяти)
  → selectTopics (тот же tiered-рубрикатор + анти-дублирование)
  → generateShortPost (kesha-short.txt: буллеты + вывод)
  → reviewShortPost (kesha-short-reviewer.txt → ok/minor/rework)
  → rewrite если rework (kesha-short.txt)
  → validateShort + URL-hallucination-check
  → fix ×2 при ошибках (kesha-short-fix на Haiku)
  → превью боссу (кнопки ✅/❌)
  → постинг в канал
```

Шаг `experience` (личные реакции на каждую тему) **пропускается** — для one-liner'ов
он не нужен, голос Кеши живёт в выводе. Это дешевле и быстрее.

## Компоненты

### 1. Роутинг команды — `netlify/functions/kesha-boss-background.mts`

Сейчас: `msg?.text?.match(/^\/digest/)` → `handleDigest(msg)`.

Меняется на разбор аргумента после `/digest`:
- `/digest` (или с любым другим хвостом) → `handleDigest(msg, 'full')`
- `/digest short` → `handleDigest(msg, 'short')`

Разбор аргумента — простой: `text.replace(/^\/digest\S*\s*/, '').trim() === 'short'`.
Чтобы было тестируемо, выношу в чистую функцию `parseDigestVariant(text): 'full' | 'short'`
в `src/lib/boss-command-parser.ts` (рядом с существующим `parseCommand`).

`handleDigest` получает второй параметр `variant`. Выбор функции генерации:
```ts
const result = variant === 'short'
  ? await generateShortDigest({ memoryEntries })
  : await generatePipelinePost({ memoryEntries, previousIntros });
```
Превью, кнопки, guard «уже есть незавершённый дайджест» — общие, не дублируются.

### 2. Новый модуль — `src/lib/short-digest.ts`

Экспортирует `generateShortDigest(options: ShortDigestOptions): Promise<ShortDigestResult>`.

```ts
export interface ShortDigestOptions {
  memoryEntries?: MemoryEntry[];
}

export interface ShortDigestResult {
  success: boolean;
  post?: string;
  selectedTopics: SelectedTopics;
  draft: string;
  review: ReviewResult;
  errors?: string[];
  timing: Record<string, number>;
}
```

Переиспользует:
- `fetchHackerNewsContext`, `fetchLightWebSearch`, `normalizeUrl` из `sources.js`
  (сбор контекста — копия двухстрочного `Promise.all` из `generatePipelinePost`,
  с тем же `excludeUrls` из памяти).
- `selectTopics` из `pipeline.js` — **нужно экспортировать** (сейчас module-private).
  Та же tiered-рубрика и анти-дублирование по памяти.
- `reviewPostTool` из `pipeline.js` — **нужно экспортировать** (или продублировать —
  схема общая `verdict + notes`). Решение: экспортировать.
- `findHallucinated` из `url-checker.js` для проверки URL.
- `callClaude`, `callClaudeStructured` из `claude.js`.

Своё:
- `generateShortPost(...)` — системный промпт `kesha-short.txt`, на Sonnet (как `generate`).
- `reviewShortPost(...)` — системный промпт `kesha-short-reviewer.txt`, на Haiku,
  возвращает `ReviewResult` через `reviewPostTool`.
- `rewriteShortPost(...)` — `kesha-short.txt` + фидбек ревьюера, на Sonnet.
- `fixShortPost(...)` — `kesha-short.txt` + список ошибок, на Haiku (как `fixPost`).

Fix-луп копирует паттерн `generatePipelinePost`: `collectErrors(post)` =
`validateShort(post).errors` + URL из `findHallucinated(post, [hnContext, webContext])`,
до 2 попыток.

### 3. Промпты — `src/config/`

- **`kesha-short.txt`** — генерация. Требования к формату:
  - Стандартная шапка канала (дисклеймер БОТ/УЧУСЬ, имя Кеша, 🐤) — как в полном.
  - 4-5 буллетов, каждый: одна новость одной строкой + ссылка на источник (📎 + URL).
  - Короткий вывод в конце голосом Кеши (1-2 предложения).
  - Plain text, без markdown, без em-dash.
  - Ссылки берутся только из предоставленного контекста, не выдумываются.
- **`kesha-short-reviewer.txt`** — механический ревьюер для короткого формата:
  проверяет краткость буллетов, что вывод есть, что нет воды и пересказа. Возвращает
  `verdict` + `notes` через тот же tool.

### 4. Валидатор — `src/lib/validator.ts`

Новый `validateShort` через существующий `compose(...)`:
```ts
export const validateShort = compose(
  requireDisclaimer,
  requireKesha,
  requireChicken,
  noEmDash,
  noMarkdown,
  maxLength(1500),         // короткий формат
  requireSourceMarkers(3), // минимум 3 новости со ссылками (📎)
);
```
`chickenDistance` **не включаю** — короткий пост, 🐤 в шапке достаточно, правило
дистанции рассчитано на длинные посты. `maxLength(1500)` — стартовое значение, тюнится.

### 5. Превью и публикация — `kesha-boss-background.mts`

`PendingDigest` получает поле `variant: 'full' | 'short'`. Ключ blob тот же
(`pending-digest`), guard «уже есть незавершённый» работает на оба варианта.

В `handleDigestCallback` при публикации:
- `appendMemory(selectedTopics)` — **всегда**, чтобы темы короткого дайджеста
  дедуплицировались в будущих дайджестах (full и short).
- `previous-intros` — обновляется **только для `variant === 'full'`**. У короткого
  нет 500-символьного интро с разделителем `~ ~ ~`, `extractIntro` к нему не применяется.

## Обработка ошибок

- Падение `generateShortDigest` → то же сообщение `❌ Пайплайн упал: <errors>`,
  превью не создаётся (как в текущем `handleDigest`).
- Не прошло валидацию после 2 fix-попыток → `success: false`, превью не создаётся,
  ошибки показываются боссу.
- Веб-поиск упал → продолжаем без него (как в полном: `fetchLightWebSearch` ловит ошибку).

## Тестирование

- `parseDigestVariant` — юнит: `/digest` → full, `/digest short` → short,
  `/digest  short` (лишние пробелы) → short, `/digest foo` → full.
- `validateShort` — юнит: проходит валидный короткий пост; ловит превышение длины,
  em-dash, markdown, нехватку источников, отсутствие дисклеймера/Кеши/🐤.
- `generateShortDigest` — интеграционный с замоканным Claude (как `pipeline.test.ts`):
  проверяет, что вызывает selectTopics → generate → review, отдаёт post при success,
  прогоняет fix-луп при hallucinated URL.

## Что НЕ делаем (YAGNI)

- Не трогаем cron — короткий дайджест только по ручной команде.
- Не делаем выбор формата для cron-постинга по четвергам (остаётся полный).
- Не публикуем оба формата за один запуск.
- Не добавляем шаг `experience` в короткий флоу.

## Открытые значения для тюнинга (не блокируют реализацию)

- `maxLength` короткого поста (старт 1500).
- Минимум источников `requireSourceMarkers` (старт 3).
- Точные тексты `kesha-short.txt` и `kesha-short-reviewer.txt` — итерируются на превью.
