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

**Парсер — единственный источник истины (P1).** Чтобы функция не принимала
`/digestshort` за `full` даже при прямом вызове без внешнего guard, граница команды
проверяется ВНУТРИ парсера, а сам он возвращает `null` для не-digest команд:
```ts
export function parseDigestVariant(text: string): 'full' | 'short' | null {
  // (?=$|\s) — граница после команды: отвергает /digestshort, /digest_x.
  const m = text.match(/^\/digest(@\w+)?(?=$|\s)/i);
  if (!m) return null;  // не команда digest
  // Аргументы берём ТОЛЬКО из первой строки (newline не считается разделителем).
  const firstToken = text.slice(m[0].length).split('\n')[0].trim()
    .split(/\s+/)[0]?.toLowerCase() ?? '';
  return firstToken === 'short' ? 'short' : 'full';
}
```
Поведение: `/digest`→full, `/digest short`→short, `/digest short extra`→short (первый
токен), `/digest foo`→full, `/digest SHORT`→short (регистр), `/digestshort`→null,
`/digest_short`→null, `/digest\nshort`→full (аргументы только из первой строки, P3).
Функция в `src/lib/boss-command-parser.ts` рядом с `parseCommand`.

**Роутинг** перестаёт дублировать regex — просто зовёт парсер:
```ts
const variant = parseDigestVariant(msg.text ?? '');
if (variant) { await handleDigest(msg, variant); }
```
Так граница команды живёт в одном месте, и `/digestshort` не попадает в обработку.

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
- `reviewResultTool` — экспортируется из `pipeline.js` (схема `verdict + notes` общая;
  это переименованный `reviewPostTool`, см. §6).
- `findHallucinated` из `url-checker.js` для проверки URL.
- `callClaude`, `callClaudeStructured` из `claude.js`.

Своё (свои промпты + свой config-блок, см. §7):
- `generateShortPost(...)` — системный промпт `kesha-short.txt`.
- `reviewShortPost(...)` — системный промпт `kesha-short-reviewer.txt`, через `reviewResultTool`.
- `rewriteShortPost(...)` — `kesha-short.txt` + фидбек ревьюера.
- `fixShortPost(...)` — `kesha-short.txt` + список ошибок (как `fixPost`).

Fix-луп копирует паттерн `generatePipelinePost`. `collectErrors(post)` собирает:
1. `validateShort(post).errors` — статические структурные правила (см. §4);
2. URL из `findHallucinated(post, [hnContext, webContext])`;
3. **динамическую проверку количества (P1):** число буллетов `📎`+URL должно быть
   РОВНО `selectedTopics.topics.length`. Статический `validateShort` про это не знает
   (`requireLinkedSources(3)` пропустит 3 ссылки при 5 темах), поэтому проверка живёт
   здесь, где известен `selectedTopics`:
   ```ts
   const expected = selectedTopics.topics.length;
   const linked = countLinkedSources(post); // общий helper из validator.ts
   if (linked !== expected) {
     errors.push(`Expected ${expected} news items, found ${linked} 📎+URL lines`);
   }
   ```
   `countLinkedSources` экспортируется из `validator.ts` и используется и тут, и в
   `requireLinkedSources` — одна логика подсчёта. Это самый вероятный баг «всё зелёное,
   но пост неполный», поэтому проверка обязательна. До 2 fix-попыток, как в полном.

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
  `notes` через `reviewResultTool`.

### 4. Валидатор — `src/lib/validator.ts`

**Проблема (P1):** проверки «3 маркера 📎» недостаточно — пост с фейковым текстом-маркером
без ссылок мог бы пройти. Нужна проверка, что каждый засчитанный пункт — это строка,
которая НАЧИНАЕТСЯ с `📎` И содержит ссылку.

**Общий helper подсчёта** (используется и валидатором, и `collectErrors` в §2):
```ts
const LINKED_SOURCE_LINE = /^📎\s+\S.*https?:\/\/\S+/u; // 📎 в начале строки + текст + URL
export function countLinkedSources(t: string): number {
  return t.split('\n').filter(l => LINKED_SOURCE_LINE.test(l)).length; // без trim — 📎 строго первый символ
}
```
Regex по началу строки (P2/P3) — не «📎 и http где-то в строке», а именно `📎` ПЕРВЫМ
символом строки (без `trim`, leading-пробелы не засчитываются), затем текст, затем URL.

**Новые правила.** Вывод (P2): после последней `📎`-строки должна быть хотя бы одна
непустая строка без URL — это и есть вывод. Иначе reviewer мог дать `ok` посту из шапки
и трёх ссылок без вывода. Запрет дефис-буллетов (P2): `noMarkdown` их не ловит:
```ts
const requireLinkedSources = (min: number): Rule => (t) =>
  countLinkedSources(t) < min
    ? `Too few linked sources: ${countLinkedSources(t)} 📎+URL line(s) (min ${min})`
    : null;

const requireConclusion: Rule = (t) => {
  const lines = t.split('\n').map(l => l.trim()).filter(Boolean);
  let lastMarker = -1;
  lines.forEach((l, i) => { if (/^📎/u.test(l)) lastMarker = i; });
  if (lastMarker === -1) return null; // «нет маркеров» ловит requireLinkedSources
  const tail = lines.slice(lastMarker + 1).filter(l => !/https?:\/\//.test(l));
  return tail.length === 0 ? 'Missing conclusion after last source line' : null;
};

const noListBullets: Rule = (t) =>
  t.split('\n').some(l => /^\s*[-*•]\s/.test(l))
    ? 'Contains list bullets (-, * or •), use 📎 lines instead'
    : null;

export const validateShort = compose(
  requireDisclaimer,
  requireKesha,
  requireChicken,
  noEmDash,
  noMarkdown,
  noListBullets,
  maxLength(1500),           // короткий формат, тюнится
  requireLinkedSources(3),   // ≥3 строк «📎 ... http(s)» (нижняя граница selectTopics)
  requireConclusion,         // есть вывод после последней 📎-строки
);
```
`chickenDistance` **не включаю** — короткий пост, 🐤 в шапке достаточно; правило
дистанции рассчитано на длинные посты. `maxLength(1500)` — стартовое значение.

Точное соответствие «буллет на каждую тему» (`linked === topics.length`) проверяется
в `collectErrors` (§2), т.к. там известен `selectedTopics`. `validateShort` отвечает
только за нижнюю границу и структуру.

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
callback_data. `handleDigestCallback` разбирает callback строгим regex и проверяет id:
```ts
const m = data.match(/^digest_(prod|cancel):(.+)$/);
if (!m) { await answerCallbackQuery(callbackQueryId); return; } // malformed → no-op
const [, action, id] = m;
```
- кнопки: `digest_prod:${id}`, `digest_cancel:${id}`.
- если `pending.id !== id` → «⏰ Дайджест устарел — запусти /digest снова», без публикации.
- malformed (`digest_prod` без id, `digest_prod:`, `digest_x:${id}`) не матчатся regex →
  тихий no-op (P2).

**Проверка владельца клика (P1).** Кнопку может нажать не только босс, если превью
оказалось в не-приватном чате. Перед публикацией/отменой `handleDigestCallback`
проверяет ДВА условия (отдельно от stale-id):
```ts
const fromId = callbackQuery.from.id;
const cbChatId = String(callbackQuery.message?.chat.id ?? '');
if (!config.allowed_user_ids.includes(fromId) || pending.chatId !== cbChatId) {
  await answerCallbackQuery(callbackQueryId, 'Только для начальника 🐤');
  return; // чужой клик — ничего не публикуем
}
```
`from.id` — только босс; `pending.chatId === cbChatId` — клик в том же чате, где
создано превью.

Это сохраняет singleton-guard «уже есть незавершённый» (ключ blob по-прежнему один,
`pending-digest`) и одновременно закрывает: гонку со старой кнопкой, malformed callback,
чужой клик. Изменение затрагивает и full, и short — оба становятся надёжнее.

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

**Нейтральное имя tool (P3).** `reviewPostTool` переименовывается в `reviewResultTool`
при экспорте, чтобы короткий модуль не импортировал full-post терминологию (схема
`verdict + notes` общая для обоих). Единственное использование внутри `pipeline.ts`
(`reviewPost`) обновляется на новое имя.

### 7. Конфиг моделей — `src/config/pipeline.json` (P2)

Параметры моделей короткого дайджеста живут в конфиге, как и у остальных шагов (не
хардкодим в `short-digest.ts`). Новый блок `short_digest`:
```jsonc
"short_digest": {
  "generate": { "model": "claude-sonnet-5",        "temperature": 0.8, "max_tokens": 2048, "tools": [] },
  "review":   { "model": "claude-haiku-4-5-20251001", "temperature": 0.3, "max_tokens": 1024, "tools": [] },
  "rewrite":  { "model": "claude-sonnet-5",         "temperature": 0.7, "max_tokens": 2048, "tools": [] },
  "fix":      { "model": "claude-haiku-4-5-20251001", "temperature": 0.1, "max_tokens": 2048, "tools": [] }
}
```
Каждый шаг включает `tools: []` — как все существующие step-конфиги в `pipeline.json`
(P2). TS-тип шага: `{ model: string; temperature: number; max_tokens: number; tools: string[] }`.
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
  `/digest SHORT`→short (регистр), `/digest foo`→full, `/digest@bot short`→short,
  `/digestshort`→null, `/digest_short`→null (граница команды внутри парсера, P1/P3).
- **`countLinkedSources` / `validateShort`** (юнит): проходит валидный короткий пост;
  ловит превышение длины, em-dash, markdown, дефис-буллеты (`- `/`* `), <3 строк
  «📎...http», строку где 📎 не в начале или без ссылки, отсутствие вывода после
  последней 📎-строки, отсутствие дисклеймера/Кеши/🐤.
- **`generateShortDigest`** (интеграционный, замоканный Claude как в `pipeline.test.ts`):
  вызывает selectTopics → generate → review; отдаёт post при success; прогоняет fix-луп
  при hallucinated URL; в результате есть `hnContext`/`webContext`.
  **Mismatch количества (P1):** при 5 отобранных темах и посте с 4 буллетами
  `collectErrors` возвращает ошибку «Expected 5 … found 4» и идёт в fix.
- **Публикация в callback (самый рисковый путь):**
  - `variant: 'short'` → `appendMemory` вызван, `previous-intros` НЕ записан;
    `variant: 'full'` → вызваны оба.
  - stale id: `digest_prod:${staleId}` при другом активном pending → не публикует.
  - malformed (P2), НЕ матчатся `^digest_(prod|cancel):(.+)$` → no-op: `digest_prod`
    без id, `digest_prod:`, `digest_cancel:`, `digest_x:${id}`.
    (`digest_cancel:wrong` — это валидный callback со stale id, попадает в ветку
    «дайджест устарел», а не в no-op.)
  - чужой клик (P1): `from.id` не из `allowed_user_ids`, либо `pending.chatId` ≠ chatId
    клика → не публикует, отвечает «только для начальника».

## Что НЕ делаем (YAGNI)

- Не публикуем оба формата за один запуск.
- Не добавляем шаг `experience` в короткий флоу.

## Открытые значения для тюнинга (не блокируют реализацию)

- `maxLength` короткого поста (старт 1500).
- Минимум источников `requireLinkedSources` (старт 3).
- Точные тексты `kesha-short.txt` и `kesha-short-reviewer.txt` — итерируются на превью.

## Изменения при реализации (deltas)

Уточнения, внесённые в ходе code-review и по запросу владельца — спек отражает их для точности:

1. **`requireConclusion` (валидатор).** Финальный фильтр — НЕ «строка содержит URL», а «строка
   состоит ТОЛЬКО из голого URL»: `tail = lines.slice(lastMarker+1).filter(l => !/^https?:\/\/\S+$/.test(l))`.
   Так вывод с встроенной ссылкой («Вывод: детали тут https://...») засчитывается, а голый
   trailing-URL — нет. Покрыто тестами.
2. **Промпт ревьюера.** `kesha-short-reviewer.txt` явно требует на 📎-строке текст новости + URL
   в конце; строка только из 📎 и голого URL — это `rework` (иначе мог бы пройти мимо
   `requireLinkedSources`, который требует `\S` до URL).
3. **Подавление cron (Task 6 fix).** `digest-last-manual-at` пишется ТОЛЬКО для `variant === 'full'`.
   Ручной короткий дайджест НЕ подавляет четверговый full-cron (короткий — это дополнение, не
   замена). `appendMemory` при этом выполняется для обоих вариантов (темы дедупаются).
4. **Cron-формат (новый, по запросу владельца — больше НЕ «cron остаётся полным»).**
   `kesha-post-background.mts` читает `KESHA_DIGEST_FORMAT` (`short`/`full`, дефолт `full`).
   При `short` cron зовёт `generateShortDigest` вместо `generatePipelinePost` и НЕ обновляет
   `previous-intros` (у короткого нет интро). `appendMemory` идёт в обоих случаях. Управляется
   env-переменной — переключение без деплоя. Покрыто юнит-тестом `kesha-post-cron.test.ts`.
5. **E2E-скрипт.** `scripts/e2e-short-digest.ts` (`npm run e2e:short-digest`) гоняет реальный
   `generateShortDigest` end-to-end (HN + web → select → generate → review → validate), печатает
   пост, темы, тайминг и независимый `validateShort`. Не включён в агрегатный `npm run e2e`
   (дорогой). Требует `ANTHROPIC_API_KEY`.
