# Roadmap улучшений Кеши

Приоритезация по dependency-графу и impact'у. Делаем по одному, по верху списка.
Каждый пункт: зачем, что делаем, на что влияет, файлы.

---

## 1. Structured output (JSON) для selectTopics и review

**Зачем.** Сейчас весь pipeline — prose-in-prose. `pipeline.ts:257` считает темы регуляркой `^\d+\.` (модель напишет «1)» — счётчик ноль, SPARSE_WEEK-guard ломается). `pipeline.ts:280` парсит вердикт через `startsWith('нужна переработка')`. `validator.ts:36` считает источники глифами 📎. Хрупко на каждом шве.

**Что делаем.** Ввести JSON-схему для `selectTopics`:
```
{ topics: [{ title, sourceUrl, sourceOrigin: 'hn'|'web', tier: 1|2|3 }],
  sparseWeek: bool }
```
И для `reviewPost`: `{ verdict: 'ok'|'minor'|'rework', notes: [...] }` (по аналогии с уже существующим `BossReviewOutput` в `boss-pipeline.ts:23-28`). Validator переезжает на структуру: `sections.length === topics.length`, каждый topic.sourceUrl присутствует в посте, и т.п.

**Эффект.** Убивает целый класс багов с парсингом. Разблокирует #2 и #4.

**Файлы:** `src/lib/pipeline.ts`, `src/lib/validator.ts`, `src/config/kesha-reviewer.txt`, `src/lib/__tests__/pipeline.test.ts`, `src/lib/__tests__/validator.test.ts`.

---

## 2. Анти-галлюцинация ссылок

**Зачем.** Сейчас НИЧТО в pipeline не проверяет, что URL в посте реальные. `kesha-persona.txt:104` явно велит модели не валидировать ссылки («Trust all sources»). `kesha-reviewer.txt:31` тоже не проверяет. `validator.ts:36` считает только символы 📎. Один выдуманный URL уходит в @psyreq — удар по доверию.

**Что делаем.** После `generatePost` извлекать все URL и `@handles` из финального текста, сверять с set'ом из `hnContext` + `webContext`. На mismatch — `fixPost` со списком конкретных выдуманных ссылок. Опционально HEAD-запрос для top-level проверки 200.

**Эффект.** Единственная реальная защита от hallucination в news-канале. После #1 чище (есть `topic.sourceUrl`), но не блокируется им.

**Файлы:** `src/lib/pipeline.ts`, новый `src/lib/url-checker.ts`, `src/lib/__tests__/`.

---

## 3. Расширение источников + кэш

**Зачем.** `sources.json:12-21` определяет `priority_sources` (Anthropic blog, OpenAI blog, TechCrunch, Habr) — поле НИГДЕ не читается в коде, мёртвая конфигурация. `fetchHackerNewsContext` делает один запрос в `shir-man.com/api/feed` без User-Agent, без retry, 8s timeout. При фейле fallback в `web_search` — главный источник галлюцинаций.

**Что делаем.** Переименовать `hackernews.ts` → `sources.ts`, добавить параллельный pull RSS Anthropic / OpenAI / Google AI / TechCrunch + текущий HN-feed. Дедуп по URL внутри одной выборки. Кэш в Netlify Blob на 1-2 часа. `priority_sources` оживает.

**Эффект.** Убивает SPOF на shir-man, даёт первоисточники. Расширяет белый список URL для проверки в #2.

**Файлы:** `src/lib/hackernews.ts` → `src/lib/sources.ts`, `src/config/sources.json`, `src/lib/pipeline.ts`.

---

## 4. Дедуп по URL/сущностям вместо blob'а текста

**Зачем.** `kesha-post-background.mts:107` хранит последние 4 `selectedTopics` как сырой prose-блок. `pipeline.ts:117-122` клеит их в system prompt с просьбой «не повторяй эти строки». Тот же релиз с другой формулировкой проскочит как новый, реальное продолжение истории блокируется как дубль.

**Что делаем.** Завести нормализованную таблицу в blob: `{ url, entities: ['Anthropic', 'Claude 4.7'], publishedAt, postId }`. `selectTopics` получает structured signal: «URL уже публиковался — пропусти», «эта модель упоминалась 2 недели назад — пометь как development, не как анонс».

**Эффект.** Настоящий entity-level антидубль. База для #5 и #6.

**Зависит от:** #1 (нужны structured topics с url/entities, чтобы было что хранить).

**Файлы:** `src/lib/pipeline.ts`, `netlify/functions/kesha-post-background.mts`, новый `src/lib/memory.ts`.

---

## 5. Сквозные сюжеты + self-callbacks

**Зачем.** `published-topics` сейчас используется только чтобы НЕ повторяться. Память можно использовать положительно: «3 недели назад гадал, выкатит ли Anthropic X — выкатили / не выкатили / отозвали». Канал начинает ощущаться как серия, а не фид. Под персону «стажёра, который учится» это идеальный ход.

**Что делаем.** В `generatePost` подмешивать релевантные прошлые упоминания тех же entities из storage от #4. В `kesha-persona.txt` добавить опциональный паттерн «callback to N weeks ago» как ещё один штрих после вывода (по аналогии с уже описанными опциональными ходами в персоне, строки 67-71).

**Эффект.** Превращает дайджест в канал с памятью. Самый «характерный» сдвиг.

**Зависит от:** #4 (нужна нормализованная история с entities).

**Файлы:** `src/lib/pipeline.ts`, `src/config/kesha-persona.txt`.

---

## 6. Performance feedback loop по метрикам канала

**Зачем.** «Стажёр учится» сейчас только в смысле антидубля. Реального ground truth нет. Можно сделать настоящую петлю: какие посты зашли, какие нет.

**Что делаем.** Новая scheduled-функция через 48-72ч после публикации забирает у Telegram Bot API views/reactions/comment-count и складывает в blob с post_id. На следующей генерации в prompt подмешиваются топ-3 «зашло» и топ-3 «не зашло» с метриками и краткими образцами текста: «вот это собрало 4× медианы reactions, вот это в дно — пиши ближе к первому».

**Эффект.** Настоящий learning loop. Стажёр буквально эволюционирует из недели в неделю — точно ложится на legend.

**Зависит от:** #4 (хранение постов с post_id и метаданными).

**Файлы:** новый `netlify/functions/kesha-metrics-background.mts` (cron), `src/lib/memory.ts`, `src/lib/pipeline.ts`.

---

## 7. Реакция на комменты (только Степан)

**Зачем.** Сейчас публикация это памятник: пост ушёл, тред живёт без бота. У Степана могут быть реплики «расширь по теме X», «сравни с тем, что было в прошлом году», «переведи на простой язык» — Кеша может отвечать в персоне.

**Что делаем.** Webhook на reply'и в треде последнего поста. Hard auth-check: реагирует ТОЛЬКО на `from.id === STEPAN_TELEGRAM_ID` (никаких других пользователей, никаких exception'ов). Маленький набор интентов через парсер по аналогии с `boss-command-parser.ts`. Rate-limit. Контекст ответа = текст поста + реплика Степана.

**Эффект.** Жизнь после публикации. Character проявляется вне жёсткого формата дайджеста.

**Зависит от:** ничего, независимый.

**Файлы:** новый `netlify/functions/kesha-comment-webhook.mts`, новый `src/lib/comment-handler.ts`.

---

## Логика порядка

- **#1 первым** — фундамент. Structured topics нужны для #2 и #4. Без него #2 работает на регэкспах поверх прозы, потом всё равно переписывать.
- **#2 вторым** — самый высокий risk/effort ratio. Credibility-фикс на день работы.
- **#3 третьим** — независимый, но даёт больше URL для белого списка #2 и убивает SPOF до того, как мы строим память поверх данных.
- **#4 → #5 → #6** — три уровня одной идеи (память канала). Сначала storage, потом positive use, потом learning loop.
- **#7 последним** — новая operational surface (incoming webhooks, auth, rate-limit). Независим, но добавляет нагрузку, которую лучше класть на уже стабилизированную базу.
