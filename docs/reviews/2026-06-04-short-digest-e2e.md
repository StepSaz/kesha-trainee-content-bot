# /digest short — E2E проверка

Ветка: `feat/short-digest` · дата: 2026-06-04

Фича: короткий дайджест (новости одной строкой 📎 + вывод). Ручная команда `/digest short`
и опциональный cron-режим через `KESHA_DIGEST_FORMAT=short`.

Статус кода: 767 юнит-тестов зелёные, tsc без новых ошибок, финальный ревью — ready to merge.

---

## 1. Локальный E2E (пайплайн против реального API)

Гоняет весь короткий пайплайн: HN + web-поиск → отбор тем → генерация → ревью → валидация.
Запускать из корня репозитория:

```bash
ANTHROPIC_API_KEY=sk-... TAVILY_API_KEY=tvly-... npm run e2e:short-digest
```

Что проверить в выводе:
- `success: true`
- `topics selected: N` (обычно 4-5, в бедную неделю 3)
- блок «Generated short digest» — формат: шапка `Я МАЛЕНЬКИЙ БОТ...`, N строк с `📎 ... <url>`, строка `Вывод: ...`, подпись
- `validateShort.valid: true`
- `linked sources: N` == `topics: N`
- финал `✅ PASS`

### Результат прогона (вставь сюда вывод скрипта):

Свежий локальный прогон 2026-06-04:

```text
npm test
Test Files  51 passed (51)
Tests       767 passed (767)
```

Важно: обычный `npm test` сейчас подхватывает тесты из `.claude/worktrees/**`, поэтому счётчик 767 включает не только текущую рабочую копию.

Чистый short-digest с исключением `.claude/**`:

```text
npx vitest run --exclude '.claude/**' src/lib/__tests__/short-digest.test.ts src/lib/__tests__/validator.test.ts netlify/functions/__tests__/kesha-post-cron.test.ts netlify/functions/__tests__/kesha-digest-callback.test.ts
Test Files  4 passed (4)
Tests       53 passed (53)
```

Targeted typecheck по файлам short-digest ветки:

```text
npx tsc --noEmit 2>&1 | grep -E 'short-digest|boss-command-parser|validator\.ts|pipeline\.ts|kesha-boss-background' | grep -v test
TARGETED_TSC_MATCH_COUNT=0
```

Full `npx tsc --noEmit` по-прежнему падает на pre-existing errors вне short-digest поверхности:

```text
netlify/functions/kesha-post-background.mts: Property 'timing' / 'draft' / 'review' / 'selectedTopics' ... does not exist on type 'ManagedResult'
netlify/functions/__tests__/*.test.ts: .mts import requires allowImportingTsExtensions
src/lib/__tests__/memory.test.ts: Type 'VitestUtils' is not assignable...
```

Реальный API E2E через Netlify env был запущен, но не дошёл до генерации:

```text
npx netlify-cli@latest dev:exec --context production -- npm run e2e:short-digest
Injected project settings env vars: ANTHROPIC_API_KEY, TAVILY_API_KEY, ...
success: false
topics selected: 0
error: 401 authentication_error: invalid x-api-key
```

`npm run qa:kesha` через тот же Netlify context тоже упал на Anthropic auth:

```text
npx netlify-cli@latest dev:exec --context production -- npm run qa:kesha
P1-P10: probe threw 401 authentication_error: invalid x-api-key
QA crashed: invalid x-api-key
```

Вывод по E2E: кодовые unit/short-digest проверки зелёные, но реальный API smoke сейчас заблокирован невалидным `ANTHROPIC_API_KEY` в Netlify env.

Проверенный пост:

```text
Я МАЛЕНЬКИЙ БОТ, Я ТОЛЬКО УЧУСЬ.

Кеша на проводе 🐤 Пять штук главного за неделю, одной строкой каждое:

📎 ChatGPT теперь "мечтает" - OpenAI запустила Dreaming, фоновый анализ чатов для долгосрочной персональной памяти https://openai.com/index/chatgpt-memory-dreaming
📎 Google показала 9 живых демо Gemini Omni и 3.5 - смотрим, работает ли всё то, что обещали на I/O https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-omni-3-5-videos/
📎 Агентный AI сделал доменную экспертизу главным активом - писать код уже не ценность, ценность - понять, правильный ли он https://www.brethorsting.com/blog/2026/05/domain-expertise-has-always-been-the-real-moat/
📎 "Теория мёртвой экономики": AI увольняет работников, те перестают покупать, компании теряют выручку - замкнутый круг https://www.owenmcgrann.com/p/the-dead-economy-theory
📎 AI-поддержка Meta обманута ради угона Instagram-аккаунтов - 2FA обойдена, дыру закрыли, осадок остался https://www.0xsid.com/blog/meta-account-takeover-fiasco

Вывод: неделя выдалась тревожно-философской - AI становится умнее и персональнее, но одновременно превращается в уязвимость и макроэкономический риск. Кеша пока не знает, радоваться или нервничать, но продолжает наблюдать.

Ваш стажер-Кеша @st_szs 🐤
```

### Вердикт по формату/тону (твоими словами):

Формат в целом попал: короткий дайджест читается быстро, шапка узнаваемая, каждая новость действительно занимает одну строку, в конце есть общий вывод и подпись Кеши. Для новой рубрики это рабочая форма.

Тон тоже хороший: "Кеша пока не знает, радоваться или нервничать" звучит живо и в персонажа, не как сухой RSS-пересказ. Формулировка "тревожно-философской" нормально склеивает выпуск.

Но as-is я бы не публиковал из-за фактологии и окна отбора:

1. OpenAI не совсем "запустила Dreaming". По статье OpenAI, Dreaming появился как метод ещё в апреле 2025, а 4 июня 2026 они выкатывают более мощную архитектуру памяти на его основе. Лучше: "OpenAI прокачала ChatGPT Memory: Dreaming теперь фоном синтезирует память из прошлых чатов..."

2. В строке Google лучше заменить "живых демо" на "демо/видео" и уточнить модель: "Gemini Omni и Gemini 3.5 Flash", не просто "3.5".

3. The Dead Economy Theory опубликована 1 мая 2026. Для дайджеста за последние 7 дней на 4 июня она выбивается из окна. По проектным правилам это нужно фильтровать на `fetchWebContext`, а не надеяться, что persona prompt отрежет старую ссылку.

4. По Meta лучше смягчить "дыру закрыли". В 0xsid формулировка осторожная, а TechCrunch 3 июня писал, что атаки, похоже, продолжались даже после заявления Meta о фиксе. Безопаснее: "Meta говорит, что чинит, осадок остался" или "Meta говорит, что дыру закрыла, но история всё равно пахнет плохо".

Рекомендованная версия строк:

```text
📎 ChatGPT теперь "мечтает" - OpenAI прокачала Memory: Dreaming фоном синтезирует память из прошлых чатов для более долгого персонального контекста https://openai.com/index/chatgpt-memory-dreaming
📎 Google выложила 9 демо Gemini Omni и Gemini 3.5 Flash - смотрим, что из обещанного на I/O уже можно потрогать глазами https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-omni-3-5-videos/
📎 Агентный AI делает доменную экспертизу главным активом - механическое написание кода дешевеет, а умение понять "правильно ли оно работает" дорожает https://www.brethorsting.com/blog/2026/05/domain-expertise-has-always-been-the-real-moat/
📎 "Теория мёртвой экономики": AI заменяет работников, те меньше покупают, компании теряют выручку - замкнутый круг https://www.owenmcgrann.com/p/the-dead-economy-theory
📎 AI-поддержку Meta обманули ради угона Instagram-аккаунтов - 2FA обходилась через recovery-flow, Meta говорит, что чинит, осадок остался https://www.0xsid.com/blog/meta-account-takeover-fiasco
```

Итог: формат/тон ready, фактология needs changes. Самый важный фикс в коде - не допускать источники старше 7 дней в короткий дайджест.

---

## 2. Telegram E2E (после деплоя ветки/мерджа на прод)

Бот-вебхук бьёт в задеплоенную функцию, так что эта проверка — после мерджа в `main`
(Netlify задеплоит) или на preview-деплое ветки.

Чеклист (в личке с ботом, ты — босс):
- [ ] `/digest short` → сообщение «⏳ генерирую короткий дайджест...», затем превью-пост с кнопками ✅/❌
- [ ] Превью: 📎-строки по одной на тему, у каждой ссылка; в конце «Вывод:»; шапка и подпись на месте
- [ ] Жму ✅ → пост уходит в канал, приходит «✅ Отправлено в канал: t.me/psyreq/...»
- [ ] В канале пост выглядит как короткий дайджест (не развёрнутый)
- [ ] `/digest` (полный) по-прежнему работает как раньше
- [ ] Запускаю `/digest short`, затем ещё раз `/digest short` до подтверждения → «⚠️ Уже есть незавершённый дайджест»
- [ ] (опц.) Жму ❌ на превью → «❌ Отменено», в канал ничего не ушло

### Что пошло не так / замечания:

Не проверялось в Telegram в рамках этого review: реальный генерационный smoke упал раньше на `401 invalid x-api-key` от Anthropic. Перед публикацией важно руками пройти preview flow, потому что локальная генерация не подтверждает:

- что кнопки ✅/❌ приходят под коротким превью;
- что повторный `/digest short` блокируется при незавершённом дайджесте;
- что в канал уходит именно short-версия, а не full-дайджест;
- что ссылки в Telegram выглядят нормально и не ломают "одна строка на новость".

Отдельный риск для Telegram: длинные URL могут визуально переносить строки. Это нормально для Telegram, но логически каждая тема всё равно должна оставаться одной `📎`-строкой в исходном тексте.

---

## 3. Cron-режим (опционально, когда захочешь переключить четверг на короткий)

В Netlify env выставить `KESHA_DIGEST_FORMAT=short` (дефолт `full`). Тогда четверговый
cron запостит короткий формат вместо полного. Короткий cron НЕ трогает `previous-intros`
и НЕ подавляет будущие full-прогоны. Откат — убрать переменную (вернётся `full`).

- [ ] Проверено на test-канале (`KESHA_CRON_CHANNEL=test`) перед прод-переключением

### Замечания:

Cron-режим не проверялся: текущий Netlify `ANTHROPIC_API_KEY` инжектится, но не проходит Anthropic auth. До включения `KESHA_DIGEST_FORMAT=short` на проде нужно обновить ключ, прогнать на test-канале и отдельно убедиться, что weekly window реально 7 дней.

Главный продуктовый риск для cron - старые, но "вкусные" evergreen-статьи. В тестовом посте так прошла The Dead Economy Theory от 1 мая 2026. Для еженедельного cron это нельзя оставлять на уровне промпта: фильтр по дате должен срабатывать в data-gathering (`fetchWebContext`), иначе Кеша будет иногда приносить хороший, но не недельный дайджест.
