# Короткий дайджест — `/digest short`

**Дата:** 2026-06-03
**Статус:** дизайн утверждён (после ревью), готов к плану реализации
**Подход:** B — отдельный модуль и отдельные промпты, переиспользование grounded-шагов

## Проблема

Сейчас у Кеши один формат дайджеста — развёрнутый пост (`/digest`): вступление,
секция на каждую тему по 2-3 предложения, вывод. Нужен второй, лёгкий формат:
**новости недели одной строкой + короткий вывод** в конце. Запускается командой
в боте, проходит то же ревью владельцем (превью с кнопками) и публикуется в канал.

## Решение

Новая подкоманда `/digest short`. Полный `/digest` не меняется по поведению. Короткий
дайджест живёт в отдельном модуле `src/lib/short-digest.ts` со своими промптами
генерации и ревью. Grounded-шаги (сбор контекста, отбор тем, проверка URL)
переиспользуются — именно там галлюцинации опаснее всего, и менять их незачем.

### Почему Подход B (а не флаг `format` в существующем пайплайне)

- Отдельный промпт проще дорабатывать без риска сломать полный дайджест.
- Меньше условной логики в промптах → меньше шанс галлюцинаций.
- Чистая граница: full digest и short digest можно тюнить независимо.
- Цена — небольшое дублирование review/fix-лупа, принятая осознанно.

### Решение по количеству новостей (зафиксировано на ревью)

Короткий дайджест показывает **по одному буллету на каждую отобранную тему** —
ровно столько, сколько вернул `selectTopics` (обычно 4-5, в sparse-неделю 3).
Генерация-промпт говорит «по буллету на каждую тему из списка», НЕ «4-5». Валидатор
требует минимум 3 (нижняя граница `selectTopics`). Это снимает противоречие
«генерация 4-5 vs валидатор 3» и не падает в бедную неделю.

## Флоу короткого дайджеста

```
сбор (HN + light web, параллельно, dedup по памяти)
  → selectTopics (тот же tiered-рубрикатор + анти-дублирование)
  → generateShortPost (kesha-short.txt: буллеты + вывод)
  → reviewShortPost (kesha-short-reviewer.txt → ok/minor/rework)
  → rewrite если rework (kesha-short.txt)
  → validateShort + URL-hallucination-check
  → fix ×2 при ошибках (kesha-short.txt на Haiku)
  → превью боссу (кнопки ✅/❌)
  → постинг в канал
```

Шаг `experience` (личные реакции на каждую тему) **пропускается** — для one-liner'ов
он не нужен, голос Кеши живёт в выводе. Это дешевле и быстрее.

## Компоненты

### 1. Роутинг команды — `netlify/functions/kesha-boss-background.mts`

**Проблема текущего роутинга (P1):** `msg?.text?.match(/^\/digest/)` ловит всё, что
начинается с `/digest`, включая `/digestshort`, `/digest_anything`. Их нельзя молча
трактовать как full digest.

**Точное совпадение команды.** Роутинг-регексп требует границу после `/digest` или
`/digest@bot`:
```ts
/^\/digest(@\w+)?(\s|$)/i
```
- `/digest`, `/digest short`, `/digest@psyreqbot short` → попадают в `handleDigest`.
- `/digestshort`, `/digest_short` → НЕ совпадают, проваливаются мимо (никакой обработки
  дайджеста), как и сейчас для любой неизвестной команды.

**Разбор варианта.** Чистая функция в `src/lib/boss-command-parser.ts` рядом с
`parseCommand`:
```ts
export function parseDigestVariant(text: string): 'full' | 'short' {
  const args = text.replace(/^\/digest(@\w+)?/i, '').trim();
  const firstToken = args.split(/\s+/)[0]?.toLowerCase() ?? '';
  return firstToken === 'short' ? 'short' : 'full';
}
```
Берёт ПЕРВЫЙ токен аргументов: `/digest short` и `/digest short extra` → short;
`/digest`, `/digest foo` → full; регистр игнорируется.

`handleDigest(message, variant)` выбирает функцию генерации:
```ts
const result = variant === 'short'
  ? await generateShortDigest({ memoryEntries })
  : await generatePipelinePost({ memoryEntries, previousIntros });
```
Превью, кнопки, guard «уже есть незавершённый дайджест» — общие.

### 2. Новый модуль — `src/lib/short-digest.ts`

Экспортирует `generateShortDigest(options: ShortDigestOptions): Promise<ShortDigestResult>`.

```ts
export interface ShortDigestOptions {
  memoryEntries?: MemoryEntry[];
}

export interface ShortDigestResult {
  success: boolean;
  post?: string;
  hnContext: string;   // сохраняем для дебага и тестов URL-проверки
  webContext: string;  // (P2: симметрично PipelineResult)
  selectedTopics: SelectedTopics;
  draft: string;
  review: ReviewResult;
  errors?: string[];
  timing: Record<string, number>;
}
```
`hnContext`/`webContext` включены намеренно: URL-hallucination-check зависит от них,
без них падения труднее дебажить, а тестам не на что опереться.

Переиспользует:
- `fetchHackerNewsContext`, `fetchLightWebSearch`, `normalizeUrl` из `sources.js`
  (сбор контекста — копия двухстрочного `Promise.all` из `generatePipelinePost`,
  с тем же `excludeUrls` из памяти).
- **`selectTopicsForContexts`** — новый чистый экспорт-обёртка из `pipeline.js`
  (см. §6 ниже). Не утекает приватный `PipelineConfig` в новый модуль.
- `reviewPostTool` — экспортируется из `pipeline.js` (схема `verdict + notes` общая).
- `findHallucinated` из `url-checker.js` для проверки URL.
- `callClaude`, `callClaudeStructured` из `claude.js`.

Своё (свои промпты + свой config-блок, см. §7):
- `generateShortPost(...)` — системный промпт `kesha-short.txt`.
- `reviewShortPost(...)` — системный промпт `kesha-short-reviewer.txt`, через `reviewPostTool`.
- `rewriteShortPost(...)` — `kesha-short.txt` + фидбек ревьюера.
- `fixShortPost(...)` — `kesha-short.txt` + список ошибок (как `fixPost`).

Fix-луп копирует паттерн `generatePipelinePost`: `collectErrors(post)` =
`validateShort(post).errors` + URL из `findHallucinated(post, [hnContext, webContext])`,
до 2 попыток.

### 3. Промпты — `src/config/`

**Формат буллета (P2 — снимаем конфликт «plain text vs буллеты»).** Маркер новости —
эмодзи `📎` в начале строки. Он же служит «буллетом», отдельного списочного синтаксиса
(`-`, `*`, `•`) НЕ используем — это держит пост в plain text и совпадает с уже
используемым в канале маркером источника. Шаблон строки:
```
📎 <новость одной строкой> <https://url-источника>
```

- **`kesha-short.txt`** — генерация. Требования:
  - Стандартная шапка канала (дисклеймер БОТ/УЧУСЬ, имя Кеша, 🐤) — как в полном.
  - **По одному буллету `📎` на каждую тему из переданного списка** (не больше, не меньше).
  - Каждый буллет: одна строка, новость + ссылка на источник из контекста.
  - Короткий вывод в конце голосом Кеши (1-2 предложения).
  - Plain text, без markdown, без em-dash, без списочных дефисов.
  - Ссылки берутся ТОЛЬКО из предоставленного контекста, не выдумываются.
- **`kesha-short-reviewer.txt`** — механический ревьюер: буллеты однострочные, у каждого
  есть ссылка, вывод присутствует, нет воды и пересказа поста. Возвращает `verdict` +
  `notes` через `reviewPostTool`.

### 4. Валидатор — `src/lib/validator.ts`

**Проблема (P1):** проверки «3 маркера 📎» недостаточно — пост с фейковым текстом-маркером
без ссылок мог бы пройти. Нужна проверка, что каждый засчитанный пункт — это строка
с маркером И ссылкой.

Новое правило + `validateShort`:
```ts
const requireLinkedSources = (min: number): Rule => (t) => {
  const linked = t.split('\n')
    .filter(l => l.includes('📎') && /https?:\/\//.test(l))
    .length;
  return linked < min
    ? `Too few linked sources: ${linked} line(s) with 📎+URL (min ${min})`
    : null;
};

export const validateShort = compose(
  requireDisclaimer,
  requireKesha,
  requireChicken,
  noEmDash,
  noMarkdown,
  maxLength(1500),           // короткий формат, тюнится
  requireLinkedSources(3),   // ≥3 строк, где есть и 📎, и http(s)-ссылка
);
```
`chickenDistance` **не включаю** — короткий пост, 🐤 в шапке достаточно; правило
дистанции рассчитано на длинные посты. `maxLength(1500)` — стартовое значение.

### 5. Превью и публикация — `kesha-boss-background.mts`

**Дискриминированный union вместо «добавить `variant`» (P1).** Short-дайджест не должен
иметь поля `newIntros`, иначе легко случайно записать `[]` в `previous-intros`:
```ts
interface PendingDigestBase {
  id: string;            // см. ниже — защита от устаревших кнопок
  variant: 'full' | 'short';
  chatId: string;
  progressMessageId: number;
  post: string;
  selectedTopics: PipelineResult['selectedTopics'];
  createdAt: string;
}
type PendingDigest =
  | (PendingDigestBase & { variant: 'full'; newIntros: string[] })
  | (PendingDigestBase & { variant: 'short' });
```
`newIntros` существует только в ветке `full`; в ветке `short` его попросту нет в типе,
обращение к нему не скомпилируется.

**Защита от устаревших кнопок (P1).** Сейчас `digest_prod` глобален: старая кнопка
опубликует то, что лежит в `pending-digest` СЕЙЧАС. Добавляю `id` (UUID) в pending и в
callback_data:
- кнопки: `digest_prod:${id}`, `digest_cancel:${id}`.
- `handleDigestCallback` парсит `id`, грузит `pending-digest`, и если `pending.id !== id`
  → отвечает «⏰ Дайджест устарел — запусти /digest снова», ничего не публикует.

Это сохраняет singleton-guard «уже есть незавершённый» (ключ blob по-прежнему один,
`pending-digest`) и одновременно закрывает гонку со старой кнопкой. Изменение
затрагивает и full, и short — оба становятся надёжнее.

**Логика публикации в `handleDigestCallback`** ветвится по `pending.variant`:
- `appendMemory(selectedTopics)` — **всегда** (оба варианта), чтобы темы короткого
  дайджеста дедуплицировались в будущих дайджестах.
- `previous-intros` обновляется **только в ветке `full`** (там есть `newIntros`).
  В ветке `short` блок с интро не выполняется вообще — `extractIntro`/`previous-intros`
  к короткому формату не применяются.

### 6. Экспорт-обёртка для отбора тем — `pipeline.ts` (P2)

`selectTopics` сейчас принимает приватный `PipelineConfig`. Чтобы не тащить этот тип в
новый модуль, добавляю в `pipeline.ts` чистую обёртку, читающую конфиг внутри:
```ts
export async function selectTopicsForContexts(
  hnContext: string,
  webContext: string,
  memoryEntries?: MemoryEntry[],
): Promise<SelectedTopics> {
  const cfg = JSON.parse(readConfig('pipeline.json')) as PipelineConfig;
  return selectTopics(hnContext, webContext, cfg, memoryEntries);
}
```
`short-digest.ts` зовёт `selectTopicsForContexts` — без доступа к `PipelineConfig`.
`reviewPostTool` экспортируется как есть (тип уже публичный).

### 7. Конфиг моделей — `src/config/pipeline.json` (P2)

Параметры моделей короткого дайджеста живут в конфиге, как и у остальных шагов (не
хардкодим в `short-digest.ts`). Новый блок `short_digest`:
```jsonc
"short_digest": {
  "generate": { "model": "claude-sonnet-4-6",        "temperature": 0.8, "max_tokens": 2048 },
  "review":   { "model": "claude-haiku-4-5-20251001", "temperature": 0.3, "max_tokens": 1024 },
  "rewrite":  { "model": "claude-sonnet-4-6",         "temperature": 0.7, "max_tokens": 2048 },
  "fix":      { "model": "claude-haiku-4-5-20251001", "temperature": 0.1, "max_tokens": 2048 }
}
```
`short-digest.ts` читает `pipeline.json` и маппит snake_case → camelCase при передаче в
`callClaude` (проектная конвенция).

## Обработка ошибок

- Падение `generateShortDigest` → то же сообщение `❌ Пайплайн упал: <errors>`,
  превью не создаётся.
- Не прошло валидацию после 2 fix-попыток → `success: false`, превью не создаётся,
  ошибки показываются боссу.
- Веб-поиск упал → продолжаем без него (как в полном: `fetchLightWebSearch` ловит ошибку).
- Клик по устаревшей кнопке → «дайджест устарел», без публикации (см. §5).

## Тестирование

- **`parseDigestVariant`** (юнит): `/digest`→full, `/digest short`→short,
  `/digest  short` (лишние пробелы)→short, `/digest short extra`→short,
  `/digest SHORT`→short (регистр), `/digest foo`→full, `/digest@bot short`→short.
- **Роутинг-регексп** (юнит): `/digestshort` и `/digest_short` НЕ матчатся как digest.
- **`validateShort`** (юнит): проходит валидный короткий пост; ловит превышение длины,
  em-dash, markdown, <3 строк с 📎+URL, строку с 📎 но без ссылки, отсутствие
  дисклеймера/Кеши/🐤.
- **`generateShortDigest`** (интеграционный, замоканный Claude как в `pipeline.test.ts`):
  вызывает selectTopics → generate → review; отдаёт post при success; прогоняет fix-луп
  при hallucinated URL; в результате есть `hnContext`/`webContext`.
- **Публикация в callback (P2 — самый рисковый путь):** при `variant: 'short'` —
  `appendMemory` вызван, `previous-intros` НЕ записан; при `variant: 'full'` — вызваны
  оба. Плюс: клик по `digest_prod:${staleId}` при другом активном pending → не публикует.

## Что НЕ делаем (YAGNI)

- Не трогаем cron — короткий дайджест только по ручной команде.
- Не делаем выбор формата для cron-постинга по четвергам (остаётся полный).
- Не публикуем оба формата за один запуск.
- Не добавляем шаг `experience` в короткий флоу.

## Открытые значения для тюнинга (не блокируют реализацию)

- `maxLength` короткого поста (старт 1500).
- Минимум источников `requireLinkedSources` (старт 3).
- Точные тексты `kesha-short.txt` и `kesha-short-reviewer.txt` — итерируются на превью.
