# eabr-med

Тренажёр «МедЗнания» (med.ea-brmed.ru, GitHub Pages).

## Уведомления о прохождении (серверная функция quiz-notify)

Клиент не хранит токен бота и chat_id. После прохождения теста страница
отправляет POST с обезличенными результатами (роль, балл, максимальный уровень,
сильные и слабые темы) на Supabase Edge Function `quiz-notify`, а функция уже
сама отправляет уведомление автору. Код функции: `supabase/functions/quiz-notify/index.ts`.

Функция принимает только POST с `Content-Type: application/json`, тело до 8 КБ,
поля строго по белому списку, CORS разрешён для `https://med.ea-brmed.ru`
и `http://localhost` / `http://127.0.0.1` (для локального теста).

### Деплой

1. Установить Supabase CLI и войти: `supabase login`.
2. Привязать проект: `supabase link --project-ref <PROJECT_REF>`.
3. Задать секреты (значения не коммитить, в репозитории их нет):

   ```bash
   supabase secrets set BOT_TOKEN=... CHAT_ID=...
   ```

   Необязательно: дополнительные источники для CORS через запятую, например
   для страницы тренажёра из репозитория medznania323:

   ```bash
   supabase secrets set ALLOWED_ORIGINS=https://elizavetaant.github.io
   ```

   Укажите здесь реальный адрес, где опубликована страница medznania323
   (GitHub Pages или свой домен), иначе браузер заблокирует запрос по CORS.

4. Задеплоить функцию без проверки JWT (страница публичная, ключ в клиенте не нужен):

   ```bash
   supabase functions deploy quiz-notify --no-verify-jwt
   ```

5. В клиенте заменить `<PROJECT_REF>` в константе `NOTIFY_URL`
   (`index.html`, `js/app.js`, а также `index.html` и `medznania.html` в репозитории medznania323):

   ```js
   const NOTIFY_URL = 'https://<PROJECT_REF>.supabase.co/functions/v1/quiz-notify';
   ```

   Пока там плейсхолдер, клиент ничего не отправляет и страница работает как обычно.
   Если запрос к функции не удался, ошибка тихо игнорируется.

### Проверка

```bash
curl -i -X POST 'https://<PROJECT_REF>.supabase.co/functions/v1/quiz-notify' \
  -H 'Origin: https://med.ea-brmed.ru' -H 'Content-Type: application/json' \
  -d '{"source":"med","role":"doctor","correct":7,"total":10,"maxLevel":2,"strong":[{"law":"323-ФЗ","n":5}],"weak":[{"topic":"Согласие","laws":["323-ФЗ ст. 20"]}]}'
```

Ожидаемый ответ: `{"ok":true}`.

### Важно

Старый токен бота был опубликован в клиентском коде и истории git.
Его нужно отозвать у BotFather (`/revoke`) и выпустить новый, который хранить только
в секретах функции.
