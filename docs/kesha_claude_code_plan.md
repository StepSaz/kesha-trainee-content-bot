# Кеша-бот: разработка в Claude Code

Загрузи в Claude Code Project два файла:
1. kesha_bot_project.md (описание проекта, персонаж, стиль)
2. Этот файл (план разработки)

Стек: Node.js + TypeScript + Netlify Functions
Зависимости: @anthropic-ai/sdk, fast-xml-parser

---

## Структура проекта

```
kesha-bot/
  netlify/
    functions/
      kesha-post.mts          # Scheduled function (cron по средам)
      kesha-test.mts          # HTTP trigger для тестов
  src/
    config/
      sources.json             # RSS-фиды + поисковые запросы
      kesha-persona.txt        # Системный промт: персонаж Кеши
      kesha-reviewer.txt       # Системный промт: редактор
      pipeline.json            # Конфиг: модели, temperature, лимиты
    lib/
      claude.ts                # Обертка Claude API
      rss.ts                   # Fetch и парсинг RSS-фидов
      pipeline.ts              # Оркестратор: RSS → write → review → rewrite
      telegram.ts              # Обертка Telegram Bot API
      validator.ts             # Техническая валидация поста
  netlify.toml
  package.json
  tsconfig.json
  .env.example
  .gitignore
  README.md
```

---

## Схема пайплайна

```
СРЕДА 10:00 (Варшава)
       |
       v
[CRON TRIGGER]
       |
       v
[ШАГ 0: RSS КОНТЕКСТ]
  fetch shir-man.com/api/rss → парсинг → текстовый блок
  (если фид недоступен - пропускаем, не ломаем пайплайн)
       |
       v
[ШАГ 1: ГЕНЕРАЦИЯ]
  Sonnet + web search, t=0.8
  "Вот тренды из RSS: {контекст}. Найди еще интересное, напиши пост"
       |
       v
[ШАГ 2: РЕВЬЮ]
  Sonnet (промт редактора), t=0.3
  "Отревьюй по чеклисту"
       |
       ├── "хорошо" ──> пост из шага 1
       |
       └── "нормально" / "переработка"
                |
                v
          [ШАГ 3: ПЕРЕПИСЫВАНИЕ]
            Sonnet, t=0.7
            "Перепиши с учетом фидбека"
                |
                v
[ТЕХНИЧЕСКАЯ ВАЛИДАЦИЯ]
  Нет —? Нет markdown? Есть 🐤? Длина ок?
       |
       ├── ок ──> ПУБЛИКАЦИЯ в @psyreq
       |
       └── ошибки ──> ОДИН RETRY
                |
                ├── ок ──> ПУБЛИКАЦИЯ
                └── ошибки ──> НЕ ПОСТИТЬ, логировать
```

---

## Шаг 1: Инициализация проекта

Промт для Claude Code:

"Создай новый Node.js проект kesha-bot. Структура: Netlify Functions на TypeScript. Установи зависимости: @anthropic-ai/sdk, fast-xml-parser. Создай netlify.toml с scheduled function. Создай .env.example с переменными: ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_TEST_CHAT_ID, TEST_SECRET. Создай tsconfig.json для TypeScript. Создай всю структуру папок. Настрой .gitignore (включить .env, node_modules). Инициализируй git."

---

## Шаг 2: Конфигурационные файлы

### 2.1 src/config/pipeline.json

```json
{
  "steps": {
    "generate": {
      "model": "claude-sonnet-4-20250514",
      "temperature": 0.8,
      "max_tokens": 4096,
      "system_prompt_file": "kesha-persona.txt",
      "tools": ["web_search"]
    },
    "review": {
      "model": "claude-sonnet-4-20250514",
      "temperature": 0.3,
      "max_tokens": 2048,
      "system_prompt_file": "kesha-reviewer.txt",
      "tools": []
    },
    "rewrite": {
      "model": "claude-sonnet-4-20250514",
      "temperature": 0.7,
      "max_tokens": 4096,
      "system_prompt_file": "kesha-persona.txt",
      "tools": []
    }
  },
  "max_review_cycles": 1
}
```

### 2.2 src/config/sources.json

```json
{
  "rss_feeds": [
    {
      "name": "shir-man AI Trends",
      "url": "https://shir-man.com/api/rss",
      "description": "AI & Tech trends dashboard by Denis Shiryaev (JetBrains AI). Aggregates Hacker News, GitHub trending, Midjourney, LessWrong, Lobsters.",
      "max_items": 10
    }
  ],
  "priority_sources": [
    "TechCrunch AI news",
    "The Verge AI",
    "Anthropic blog",
    "OpenAI blog",
    "Google AI blog",
    "Hacker News top stories",
    "Product Hunt new AI tools",
    "Habr AI articles"
  ],
  "search_queries": [
    "AI news this week",
    "new AI tools released this week",
    "Claude Anthropic updates",
    "ChatGPT OpenAI updates",
    "Gemini Google updates",
    "vibe coding news",
    "business analysis AI tools",
    "Cursor IDE updates",
    "AI developer tools new"
  ]
}
```

### 2.3 src/config/kesha-persona.txt

Системный промт Кеши - полное содержание в kesha_bot_project.md. Ключевые элементы:

- Роль: Иннокентий (Кеша), бот-стажер канала "Временно Степан" (@psyreq)
- Характер: старательный, неуверенный, с самоиронией, тегает @psyreq
- Дисклеймер: "Я МАЛЕНЬКИЙ БОТ, Я ТОЛЬКО УЧУСЬ. Не бейте. 🐤"
- Приветствие: "Кеша на проводе🐤"
- Разделители: ~ ~ ~
- Эмодзи: 🐤 🤖 👀 🫡 📎
- КРИТИЧНО: plain text, НЕТ длинных тире (—), НЕТ markdown
- Тематика: AI, tech, vibe coding, инструменты для IT
- Длина: до 2000 символов (макс 3500)
- Финал: вопрос к аудитории или тег @psyreq

Промт для Claude Code:
"Создай src/config/kesha-persona.txt. Полное содержание системного промта Кеши описано в kesha_bot_project.md. Включи: роль, характер стадии 1 (робкий стажер), формат поста с дисклеймером, антислоп-правила, тематические рамки, инструкцию по генерации с web search."

### 2.4 src/config/kesha-reviewer.txt

Системный промт редактора. Другая роль, другой взгляд.

- Роль: строгий но справедливый редактор канала
- Задача: ревью поста Кеши, КОНКРЕТНЫЕ правки с цитатами

Чеклист ревью:
1. ИНТЕРЕС - не generic ли? Есть ли за что зацепиться?
2. ХАРАКТЕР КЕШИ - стажер с характером или безликий агрегатор?
3. АНТИСЛОП - шаблонные фразы, рубленые предложения, наполнители?
4. КОНКРЕТИКА - цифры, названия, ссылки?
5. ФОРМАТ - нет длинных тире, нет markdown, есть дисклеймер?
6. ДЛИНА - нет воды?

Формат ответа: оценка (хорошо / нормально / нужна переработка) + конкретные правки с цитатами.

Промт для Claude Code:
"Создай src/config/kesha-reviewer.txt. Роль: редактор канала. Задача: ревью поста Кеши по чеклисту из 6 пунктов (интерес, характер, антислоп, конкретика, формат, длина). Формат ответа: оценка + конкретные правки с цитатами из текста. Не абстрактные советы, а 'фраза X звучит generic, замени на Y'."

---

## Шаг 3: src/lib/rss.ts

Экспортирует: fetchRssContext() => string

Логика:
1. Читает rss_feeds из sources.json
2. Для каждого фида: fetch URL (timeout 5 сек) → XML → fast-xml-parser
3. Извлекает: title, link, description, pubDate из каждого item
4. Strip HTML tags из description (sanitization)
5. Сортирует по дате, берет последние max_items
6. Форматирует в текстовый блок:
   "Тренды из RSS (shir-man AI Trends):
   1. {title} - {description} ({link})
   2. ..."
7. При любой ошибке - console.log + возврат пустой строки

Промт для Claude Code:
"Создай src/lib/rss.ts. Async функция fetchRssContext(). Читает rss_feeds из sources.json. Fetch каждого URL (timeout 5 сек). Парсит XML через fast-xml-parser. Извлекает title, link, description, pubDate. Strip HTML tags из description. Сортирует по дате, берет max_items. Форматирует в текстовый блок. При ошибке - логирует и возвращает пустую строку. Возвращает string."

---

## Шаг 4: src/lib/claude.ts

Экспортирует: callClaude({ systemPrompt, userMessage, model, temperature, maxTokens, tools? }) => string

Логика:
1. Создает Anthropic client из @anthropic-ai/sdk
2. Формирует запрос: system, messages, model, temperature, max_tokens
3. Если tools включает "web_search" - добавляет { type: "web_search_20250305", name: "web_search" }
4. Отправляет запрос
5. Собирает text blocks из response.content (фильтрует по type === "text")
6. Возвращает объединенный текст

Промт для Claude Code:
"Создай src/lib/claude.ts. Функция callClaude с параметрами { systemPrompt, userMessage, model, temperature, maxTokens, tools? }. Использует @anthropic-ai/sdk. API key из env ANTHROPIC_API_KEY. Если tools содержит 'web_search' - добавляет web search tool. Собирает text blocks из ответа. Возвращает string."

---

## Шаг 5: src/lib/validator.ts

Экспортирует: validatePost(text: string) => { valid: boolean, errors: string[] }

Проверки (без API, чистый код):
- Есть дисклеймер (текст содержит "БОТ" или "УЧУСЬ" в верхнем регистре)
- Есть "Кеша" где-то в тексте
- Есть 🐤 хотя бы раз
- НЕТ длинного тире (символ — U+2014)
- НЕТ markdown: **, ##, ```
- Длина до 4000 символов

Промт для Claude Code:
"Создай src/lib/validator.ts. Функция validatePost(text). Проверяет: наличие дисклеймера бота (БОТ/УЧУСЬ в caps), наличие 'Кеша' и 🐤, отсутствие em dash (U+2014), отсутствие markdown (**, ##, ```), длина до 4000 символов. Возвращает { valid, errors }."

---

## Шаг 6: src/lib/telegram.ts

Экспортирует: sendToChannel(text: string, chatId?: string) => { success: boolean, messageId?: number, error?: string }

Логика:
1. POST на https://api.telegram.org/bot{TOKEN}/sendMessage
2. Body: { chat_id, text }
3. parse_mode НЕ указываем (plain text!)
4. Обработка ответа и ошибок

Промт для Claude Code:
"Создай src/lib/telegram.ts. Функция sendToChannel(text, chatId?). POST на Telegram Bot API sendMessage. Токен из env TELEGRAM_BOT_TOKEN. Дефолтный chatId из env TELEGRAM_CHAT_ID. Без parse_mode (plain text). Возвращает { success, messageId?, error? }."

---

## Шаг 7: src/lib/pipeline.ts (ядро)

Экспортирует: generatePost() => { success, post?, draft, review, rssContext, errors?, timing }

Логика:
1. ШАГ 0: rssContext = fetchRssContext()
2. ШАГ 1 (ГЕНЕРАЦИЯ): Читает kesha-persona.txt и pipeline.json (generate). User prompt включает дату + rssContext + инструкцию писать пост. callClaude с web_search tool.
3. ШАГ 2 (РЕВЬЮ): Читает kesha-reviewer.txt и pipeline.json (review). User prompt = черновик из шага 1. callClaude без tools.
4. Парсит оценку из ревью: если "хорошо" - берет черновик как финальный, пропускает шаг 3.
5. ШАГ 3 (ПЕРЕПИСЫВАНИЕ): Читает kesha-persona.txt и pipeline.json (rewrite). User prompt = черновик + ревью. callClaude без tools.
6. ВАЛИДАЦИЯ: validatePost(finalPost).
7. Логирует каждый шаг с таймингом.
8. Возвращает все промежуточные результаты.

Промт для Claude Code:
"Создай src/lib/pipeline.ts. Async функция generatePost(). Последовательно:
1. fetchRssContext() - получить тренды
2. callClaude с kesha-persona.txt + web_search - сгенерировать черновик. User prompt включает дату, RSS-контекст и инструкцию.
3. callClaude с kesha-reviewer.txt - отревьюить черновик. Если оценка 'хорошо' - пропустить шаг 4.
4. callClaude с kesha-persona.txt - переписать с учетом ревью.
5. validatePost() - техническая проверка.
Читай модели и temperature из pipeline.json. Логируй каждый шаг с console.log и замером времени. Возвращай { success, post?, draft, review, rssContext, errors?, timing }."

---

## Шаг 8: netlify/functions/kesha-post.mts

Scheduled Netlify Function. Точка входа для cron.

Логика:
1. Вызвать generatePost()
2. Если success и валидный - sendToChannel(result.post)
3. Если невалидный - retry один раз (generatePost() заново)
4. Если после retry невалидный - не постить, залогировать все
5. Логировать полный результат (draft, review, final, timing)

netlify.toml:
```toml
[functions."kesha-post"]
schedule = "0 8 * * 3"
```
(Среда 8:00 UTC = 10:00 по Варшаве)

Промт для Claude Code:
"Создай netlify/functions/kesha-post.mts. Scheduled Netlify function. Вызывает generatePost() из pipeline.ts. Если success - sendToChannel(). Если не success - один retry. Логирует все. Обнови netlify.toml: schedule = '0 8 * * 3'. Экспортируй как Netlify scheduled function."

---

## Шаг 9: netlify/functions/kesha-test.mts

HTTP endpoint для ручного тестирования.

Логика:
- GET запрос с ?secret=VALUE
- Проверяет secret === env.TEST_SECRET
- Тот же generatePost() + sendToChannel(post, TELEGRAM_TEST_CHAT_ID)
- Возвращает JSON: { success, draft, review, rssContext, finalPost, validationErrors, timing }

Промт для Claude Code:
"Создай netlify/functions/kesha-test.mts. HTTP GET function. Проверяет query param secret === env.TEST_SECRET. Вызывает generatePost(), отправляет в TELEGRAM_TEST_CHAT_ID. Возвращает JSON со всеми промежуточными результатами пайплайна."

---

## Шаг 10: Финализация и деплой

Промт для Claude Code:
"Проверь проект перед деплоем:
- netlify.toml корректен (schedule, функции)
- package.json имеет все зависимости
- tsconfig.json работает для Netlify Functions
- .gitignore включает .env и node_modules
- .env.example содержит все переменные
- README.md описывает: что это, как настроить, как задеплоить, архитектуру пайплайна
Помоги сделать git init, первый коммит и push на GitHub."

---

## Последовательность разработки

Рекомендуемый порядок:

1. Инициализация проекта (шаг 1)
2. Конфигурационные файлы (шаг 2) - САМЫЙ ВАЖНЫЙ, итерировать промты!
3. RSS-модуль (шаг 3)
4. Claude API обертка (шаг 4)
5. Валидатор (шаг 5)
6. Telegram обертка (шаг 6)
7. Пайплайн (шаг 7) - соединяет все
8. Scheduled function (шаг 8)
9. Тестовый endpoint (шаг 9)
10. Финализация и деплой (шаг 10)

Время: один-два вечера.

---

## Бюджет на API

Один цикл (3 вызова Sonnet): ~$1-1.5 за пост
В месяц (4 поста): ~$4-6
Апгрейд ревью на Opus: ~$2-3 за пост, ~$8-12/месяц
Переключение модели - одна строчка в pipeline.json.

---

## Что потом (после запуска)

- Обновлять kesha-persona.txt для арки развития (раз в 1-2 месяца)
- Если ревью Sonnet не хватает - апгрейд на Opus в pipeline.json
- Добавить новые RSS-фиды в sources.json
- Логирование в Notion/Google Sheets (опционально)
- Развитие: Кеша отвечает на комменты (webhook)
- Развитие: "Кеша vs Степан" - один топик, два поста
- Развитие: аудитория голосует за тему
