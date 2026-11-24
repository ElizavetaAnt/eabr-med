// Supabase Edge Function: quiz-notify
//
// Принимает обезличенный результат прохождения тренажёра «МедЗнания»
// и пересылает уведомление автору через Bot API мессенджера.
// Токен бота и chat_id хранятся только в секретах функции:
//   supabase secrets set BOT_TOKEN=... CHAT_ID=...
// Необязательно: ALLOWED_ORIGINS=https://example.org,https://other.example
// (дополнительные источники для CORS через запятую).
//
// Деплой: supabase functions deploy quiz-notify --no-verify-jwt

const MAX_BODY_BYTES = 8 * 1024;

const DEFAULT_ORIGINS = ["https://med.ea-brmed.ru"];
const LOCALHOST_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

const ROLE_NAMES: Record<string, string> = {
  doctor: "Врач",
  nurse: "Медицинская сестра",
  admin: "Администратор / Руководитель",
  student: "Студент",
};
const LEVEL_NAMES = ["", "Базовый", "Практический", "Продвинутый", "Эксперт"];
const STARS = ["", "★", "★★", "★★★", "★★★★"];
const SOURCES: Record<string, string> = {
  med: "ЕАБР med",
  medznania323: "МедЗнания 323",
};

const ALLOWED_KEYS = new Set([
  "source",
  "role",
  "correct",
  "total",
  "maxLevel",
  "strong",
  "weak",
]);

// Простое ограничение частоты в памяти инстанса (best effort).
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 10;
const hits = new Map<string, number[]>();

function rateLimited(key: string): boolean {
  const now = Date.now();
  const list = (hits.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  list.push(now);
  hits.set(key, list);
  if (hits.size > 5000) hits.clear();
  return list.length > RATE_MAX;
}

function allowedOrigins(): string[] {
  const extra = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/i.test(s));
  return [...DEFAULT_ORIGINS, ...extra];
}

function isAllowedOrigin(origin: string | null): origin is string {
  if (!origin) return false;
  return allowedOrigins().includes(origin) || LOCALHOST_RE.test(origin);
}

function corsHeaders(origin: string | null): Record<string, string> {
  const h: Record<string, string> = {
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
  if (isAllowedOrigin(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

function json(status: number, body: unknown, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Убираем управляющие символы и обрезаем по длине.
function cleanStr(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (!s || s.length > max) return null;
  return s;
}

function isInt(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}

async function readLimited(req: Request): Promise<string | null> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BODY_BYTES) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(buf);
}

type Strong = { law: string; n: number };
type Weak = { topic: string; laws: string[] };
type Payload = {
  source: string;
  role: string;
  correct: number;
  total: number;
  maxLevel: number;
  strong: Strong[];
  weak: Weak[];
};

function validate(raw: unknown): Payload | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!ALLOWED_KEYS.has(k)) return null;

  const source = typeof o.source === "string" && o.source in SOURCES
    ? o.source
    : null;
  const role = typeof o.role === "string" && o.role in ROLE_NAMES
    ? o.role
    : null;
  if (!source || !role) return null;
  if (!isInt(o.total, 1, 500) || !isInt(o.correct, 0, o.total)) return null;
  if (!isInt(o.maxLevel, 0, LEVEL_NAMES.length - 1)) return null;

  const strongIn = o.strong ?? [];
  const weakIn = o.weak ?? [];
  if (!Array.isArray(strongIn) || strongIn.length > 40) return null;
  if (!Array.isArray(weakIn) || weakIn.length > 60) return null;

  const strong: Strong[] = [];
  for (const it of strongIn) {
    if (!it || typeof it !== "object") return null;
    const r = it as Record<string, unknown>;
    if (Object.keys(r).some((k) => k !== "law" && k !== "n")) return null;
    const law = cleanStr(r.law, 60);
    if (!law || !isInt(r.n, 1, 500)) continue; // плохой элемент пропускаем
    strong.push({ law, n: r.n });
  }

  const weak: Weak[] = [];
  for (const it of weakIn) {
    if (!it || typeof it !== "object") return null;
    const r = it as Record<string, unknown>;
    if (Object.keys(r).some((k) => k !== "topic" && k !== "laws")) return null;
    const topic = cleanStr(r.topic, 160);
    const lawsIn = r.laws ?? [];
    if (!Array.isArray(lawsIn) || lawsIn.length > 12) return null;
    if (!topic) continue; // пустую тему пропускаем
    const laws: string[] = [];
    for (const l of lawsIn) {
      const s = cleanStr(l, 60);
      if (s) laws.push(s);
    }
    weak.push({ topic, laws });
  }

  return {
    source,
    role,
    correct: o.correct,
    total: o.total,
    maxLevel: o.maxLevel,
    strong,
    weak,
  };
}

function buildText(p: Payload): string {
  const pct = Math.round((p.correct / p.total) * 100);
  const date = new Date().toISOString().slice(0, 10);
  const strongStr = p.strong.length
    ? p.strong.map((s) => `${escapeHtml(s.law)}: ${s.n} верно`).join(" · ")
    : "нет";
  const weakStr = p.weak.length
    ? p.weak
      .map((w) =>
        `• ${escapeHtml(w.topic)}` +
        (w.laws.length ? ` [${w.laws.map(escapeHtml).join(", ")}]` : "")
      )
      .join("\n")
    : "нет";
  const level = p.maxLevel
    ? `${STARS[p.maxLevel]} ${LEVEL_NAMES[p.maxLevel]}`
    : "нет";

  return `📊 <b>${escapeHtml(SOURCES[p.source])}: новое прохождение</b>\n\n` +
    `👤 Роль: <b>${escapeHtml(ROLE_NAMES[p.role])}</b>\n` +
    `✅ Результат: <b>${p.correct}/${p.total} (${pct}%)</b>\n` +
    `⭐ Макс. уровень: <b>${escapeHtml(level)}</b>\n` +
    `📅 Дата: ${date}\n\n` +
    `✔️ <b>Знает хорошо:</b> ${strongStr}\n\n` +
    `❌ <b>Слабые темы:</b>\n${weakStr}`;
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");

  if (req.method === "OPTIONS") {
    if (!isAllowedOrigin(origin)) return new Response(null, { status: 403 });
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (req.method !== "POST") {
    return json(405, { ok: false, error: "method_not_allowed" }, origin);
  }
  if (!isAllowedOrigin(origin)) {
    return json(403, { ok: false, error: "forbidden_origin" }, origin);
  }
  const ctype = req.headers.get("content-type") ?? "";
  if (!ctype.toLowerCase().startsWith("application/json")) {
    return json(415, { ok: false, error: "unsupported_media_type" }, origin);
  }

  // Берём последний адрес цепочки: его добавляет шлюз, а не клиент.
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",").pop()?.trim() ||
    "unknown";
  if (rateLimited(ip)) {
    return json(429, { ok: false, error: "too_many_requests" }, origin);
  }

  let text: string | null;
  try {
    text = await readLimited(req);
  } catch {
    return json(400, { ok: false, error: "bad_body" }, origin);
  }
  if (text === null) {
    return json(413, { ok: false, error: "payload_too_large" }, origin);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return json(400, { ok: false, error: "bad_json" }, origin);
  }
  const payload = validate(parsed);
  if (!payload) return json(422, { ok: false, error: "invalid_payload" }, origin);

  const token = Deno.env.get("BOT_TOKEN");
  const chatId = Deno.env.get("CHAT_ID");
  if (!token || !chatId) {
    console.error("quiz-notify: BOT_TOKEN or CHAT_ID is not configured");
    return json(500, { ok: false, error: "not_configured" }, origin);
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: buildText(payload).slice(0, 4000),
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      // Тело ответа не логируем целиком, только статус.
      console.error("quiz-notify: upstream status", res.status);
      return json(502, { ok: false, error: "upstream_error" }, origin);
    }
  } catch {
    console.error("quiz-notify: upstream request failed");
    return json(502, { ok: false, error: "upstream_unreachable" }, origin);
  }

  return json(200, { ok: true }, origin);
});
