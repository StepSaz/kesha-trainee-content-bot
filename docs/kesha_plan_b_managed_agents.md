# Кеша-бот: План Б - Claude Managed Agents

Альтернативная архитектура для сравнения с Планом А (Netlify + pipeline).

---

## Чем отличается от Плана А

| | План А (pipeline) | План Б (Managed Agents) |
|---|---|---|
| Архитектура | 3 отдельных API-вызова с разными промтами | 1 agent session, агент сам оркестрирует |
| Код | ~6 модулей (claude.ts, rss.ts, pipeline.ts, validator.ts, telegram.ts, kesha-post.mts) | ~2 модуля (trigger function + telegram.ts) |
| Контроль | Точный: разные temperature, промты, модели на каждом шаге | Меньший: один промт, агент сам решает как итерировать |
| Инфраструктура | Netlify Functions + cron | Netlify cron (триггер) + Managed Agents (исполнение) |
| Web search | Через tool в API | Встроен в agent runtime |
| RSS парсинг | Свой модуль rss.ts | Агент сам через bash/fetch |
| Валидация | Свой модуль validator.ts | Агент сам проверяет по инструкции |
| Self-review | 3 вызова: write → review → rewrite | Агент инструктирован ревьювить себя в одной сессии |
| Сложность кода | Средняя | Низкая |
| Стоимость | ~$1-1.5/пост (3 вызова Sonnet) | Токены + $0.08/session-hour (оценка: ~$1-2/пост) |
| Стабильность | Production-ready API | Beta (header managed-agents-2026-04-01) |

---

## Архитектура

```
СРЕДА 10:00 (Варшава)
       |
       v
[NETLIFY CRON TRIGGER]
       |
       v
[СОЗДАТЬ MANAGED AGENT SESSION]
  Системный промт Кеши + инструкция к self-review
  Tools: web_search, web_fetch, bash, file ops
       |
       v
[АГЕНТ РАБОТАЕТ АВТОНОМНО]
  1. Fetch RSS через bash/fetch
  2. Web search для свежих новостей
  3. Пишет черновик
  4. Ревьювит себя по чеклисту
  5. Переписывает если нужно
  6. Проверяет формат (тире, markdown, длина)
  7. Записывает финальный пост в файл
       |
       v
[ЗАБРАТЬ РЕЗУЛЬТАТ ИЗ СЕССИИ]
  Прочитать файл с постом
       |
       v
[БАЗОВАЯ ВАЛИДАЦИЯ В КОДЕ]
  Нет тире? Есть 🐤? Длина ок?
       |
       v
[TELEGRAM API]
  sendToChannel()
```

---

## Структура проекта

```
kesha-bot-managed/
  netlify/
    functions/
      kesha-post.mts          # Cron trigger → create session → get result → post
      kesha-test.mts          # HTTP trigger для тестов
  src/
    config/
      kesha-agent-prompt.txt   # Единый промт: персонаж + self-review + валидация
      sources.json             # RSS фиды и поисковые запросы (для промта)
    lib/
      managed-agent.ts         # Обертка Managed Agents API
      telegram.ts              # Обертка Telegram Bot API (та же что в Плане А)
      validator.ts             # Минимальная валидация (та же что в Плане А)
  netlify.toml
  package.json
  tsconfig.json
  .env.example
  .gitignore
  README.md
```

Заметь: в 2 раза меньше файлов чем в Плане А. Нет claude.ts, rss.ts, pipeline.ts.

---

## Ключевой файл: kesha-agent-prompt.txt

Единый системный промт, который включает ВСЕ - и персонаж, и self-review, и валидацию.

Структура промта:

```
[Персонаж Кеши - тот же что в Плане А]

[Тематика, формат, антислоп-правила - те же]

ТВОЙ РАБОЧИЙ ПРОЦЕСС:

Шаг 1: Сбор информации
- Через bash выполни: curl https://shir-man.com/api/rss и распарси XML
- Через web search найди: AI news this week, new AI tools, Claude/ChatGPT/Gemini updates, vibe coding news
- Выбери 3-7 самых интересных новостей/тем за неделю

Шаг 2: Написание черновика
- Выбери формат (дайджест / один пост / "нашел штуку" / "вопрос к шефу")
- Напиши черновик поста от лица Кеши
- Запиши черновик в файл /tmp/draft.txt

Шаг 3: Self-review
Переключись в режим "строгий редактор" и ответь на вопросы:
1. Интересно ли это? Или generic дайджест, который есть в любом канале?
2. Звучит ли Кеша как персонаж, или как безликий бот?
3. Есть ли конкретика - цифры, названия, ссылки?
4. Нет ли AI-slop: шаблонных фраз, рубленых предложений, наполнителей?
5. Нет ли длинных тире (—), markdown (**, ##, ```)?
6. Длина в пределах (до 2000, макс 3500)?
Запиши ревью в /tmp/review.txt

Шаг 4: Переписывание
Если ревью выявило проблемы - перепиши пост с учетом замечаний.
Сохрани свой голос и характер Кеши.
Запиши финальный пост в /tmp/final_post.txt

Шаг 5: Финальная проверка
Прочитай /tmp/final_post.txt и убедись:
- Есть дисклеймер "Я МАЛЕНЬКИЙ БОТ, Я ТОЛЬКО УЧУСЬ"
- Есть "Кеша на проводе🐤"
- Есть 🐤 минимум 1 раз
- НЕТ символа — (длинное тире, U+2014)
- НЕТ markdown: **, ##, ```
- Длина до 4000 символов
- Есть вопрос к аудитории или тег @psyreq в конце
Если что-то не так - исправь и перезапиши /tmp/final_post.txt

ВАЖНО: Финальный пост ВСЕГДА должен быть в /tmp/final_post.txt
```

---

## Шаг 1: managed-agent.ts

Обертка для Managed Agents API.

Функции:

1. createAgent() - создать агента (один раз, потом переиспользовать по ID)
   - model: claude-sonnet-4-20250514
   - system_prompt: из kesha-agent-prompt.txt
   - tools: ["bash", "web_search", "web_fetch", "file_read", "file_write"]

2. createEnvironment() - создать окружение (один раз)
   - packages: []  (ничего специального не нужно)
   - network: разрешить shir-man.com (для RSS)

3. runSession(agentId, environmentId) - запустить сессию
   - Отправить user event: "Сегодня {дата}, среда. Выполни свой рабочий процесс и подготовь пост."
   - Дождаться завершения (stream SSE events)
   - Прочитать /tmp/final_post.txt из контейнера
   - Вернуть текст поста

Промт для Claude Code:
"Создай src/lib/managed-agent.ts. Три функции:
1. createAgent() - создает Managed Agent через API с системным промтом из kesha-agent-prompt.txt. Tools: bash, web_search, web_fetch, file ops. Возвращает agent_id.
2. createEnvironment() - создает environment. Возвращает environment_id.
3. runSession(agentId, envId) - создает session, отправляет user event с датой, стримит SSE events до завершения, читает файл /tmp/final_post.txt из контейнера, возвращает текст поста.
Используй @anthropic-ai/sdk. Beta header: managed-agents-2026-04-01. API key из env."

---

## Шаг 2: kesha-post.mts (Managed Agents версия)

Логика:
1. Cron триггер
2. Прочитать agent_id и environment_id из env (создаются один раз при setup)
3. runSession() - получить текст поста
4. validatePost() - минимальная техническая проверка
5. Если валидный - sendToChannel()
6. Если невалидный - один retry (новая сессия)
7. Логирование

---

## Шаг 3: Setup (один раз)

При первом деплое нужно создать agent и environment:

1. Запустить скрипт setup:
   - createAgent() → сохранить AGENT_ID в Netlify env
   - createEnvironment() → сохранить ENVIRONMENT_ID в Netlify env

2. Или создать через Claude Console UI (если доступно)

Environment Variables (дополнительно к Плану А):
- MANAGED_AGENT_ID = создается при setup
- MANAGED_ENVIRONMENT_ID = создается при setup

---

## Сравнительный тест: как проводить

Запускаем оба плана параллельно на 4 недели (4 поста каждый).

Неделя 1: План А постит в среду, План Б постит в четверг (или наоборот)
Неделя 2: Меняем дни
...и так далее.

Оба поста идут в тестовый чат (не в канал!). Ты оцениваешь.

Критерии сравнения:

| Критерий | Как оцениваем |
|---|---|
| Качество текста | Субъективно: интерес, голос Кеши, конкретика (1-10) |
| Антислоп | Сколько AI-маркеров в посте (0 = идеально) |
| Стабильность | Сколько из 4 постов прошли без retry |
| Стоимость | Суммарный расход API за 4 поста |
| Время генерации | Сколько секунд от триггера до готового поста |
| Свежесть контента | Нашел ли бот реально свежие новости (да/нет) |
| Валидация | Сколько постов прошли техническую валидацию с первого раза |

После 4 недель - выбираем победителя и пускаем в канал.

---

## Риски Плана Б

1. BETA API
   Managed Agents в beta. Может измениться, может быть нестабилен.
   Митигация: План А всегда остается как fallback.

2. МЕНЬШЕ КОНТРОЛЯ
   Self-review в одном промте менее надежен, чем три отдельных вызова.
   Агент может "забыть" сделать ревью или сделать его формально.
   Митигация: файлы draft.txt, review.txt, final_post.txt - можно проверить все шаги.

3. TIMEOUT
   Managed Agent session может работать долго (минуты).
   Netlify cron function может не дождаться.
   Митигация: использовать Netlify Background Functions (до 15 мин) или async pattern (запустить сессию, потом отдельным вызовом проверить результат).

4. DEBUGGING СЛОЖНЕЕ
   В Плане А видно каждый шаг отдельно.
   В Плане Б - один лог сессии со всеми events.
   Митигация: файлы draft/review/final дают промежуточные результаты.

---

## Бюджет на тест

4 недели × 2 подхода × 1 пост = 8 постов

План А: ~$1.5 × 4 = ~$6
План Б: ~$2 × 4 = ~$8 (оценка, зависит от длины сессии)

Итого на тест: ~$14. Меньше одного ланча.

---

## Порядок разработки

1. Сначала: доделать План А (он почти готов как план)
2. Потом: добавить managed-agent.ts и альтернативный kesha-post
3. Оба варианта в одном репозитории, переключение через env variable:
   KESHA_MODE=pipeline или KESHA_MODE=managed

Или два отдельных cron-функции:
- kesha-post-pipeline.mts (План А)
- kesha-post-managed.mts (План Б)
- kesha-test.mts с параметром ?mode=pipeline|managed

Так можно тестировать оба в одном деплое.
