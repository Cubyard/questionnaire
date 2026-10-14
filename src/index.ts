import { type Answers, type PollInput, type Question, SLUG_RE, validateAnswers, validatePoll } from "./schema";
import { tally, toCsv } from "./results";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  SUBMIT_LIMITER: RateLimit;
  ADMIN_TOKEN: string;
  IP_SALT: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET?: string;
}

interface PollRow {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  questions: string;
  settings: string;
  status: PollInput["status"];
  closes_at: string | null;
  created_at: string;
  updated_at: string;
}

const MAX_BODY_BYTES = 64 * 1024;

class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

async function readJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, "too_large", "Request body is too large.");
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, "too_large", "Request body is too large.");
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be JSON.");
  }
}

function now(): string {
  return new Date().toISOString();
}

function randomSlug(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  // Compare digests so length differences leak nothing either.
  const [da, db] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < da.length; i++) diff |= da.charCodeAt(i) ^ db.charCodeAt(i);
  return diff === 0 && a.length > 0;
}

function toPoll(row: PollRow) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description ?? undefined,
    questions: JSON.parse(row.questions) as Question[],
    settings: JSON.parse(row.settings) as PollInput["settings"],
    status: row.status,
    closesAt: row.closes_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type Poll = ReturnType<typeof toPoll>;

function isOpen(poll: Poll): boolean {
  return poll.status === "open" && (!poll.closesAt || Date.parse(poll.closesAt) > Date.now());
}

function publicPoll(poll: Poll, env: Env) {
  return {
    slug: poll.slug,
    title: poll.title,
    description: poll.description,
    questions: poll.questions,
    showResults: poll.settings.showResults,
    allowMultipleResponses: poll.settings.allowMultipleResponses,
    confirmationMessage: poll.settings.confirmationMessage,
    theme: poll.settings.theme,
    open: isOpen(poll),
    closesAt: poll.closesAt,
    turnstileSiteKey: env.TURNSTILE_SITE_KEY || undefined,
  };
}

async function getPollBy(env: Env, column: "id" | "slug", value: string): Promise<Poll | null> {
  const row = await env.DB.prepare(`SELECT * FROM polls WHERE ${column} = ?`).bind(value).first<PollRow>();
  return row ? toPoll(row) : null;
}

async function requirePoll(env: Env, idOrSlug: string): Promise<Poll> {
  const poll = (await getPollBy(env, "id", idOrSlug)) ?? (await getPollBy(env, "slug", idOrSlug));
  if (!poll) throw new HttpError(404, "not_found", "No poll with that id or slug.");
  return poll;
}

async function loadResponses(env: Env, pollId: string) {
  const { results } = await env.DB.prepare(
    "SELECT id, answers, created_at FROM responses WHERE poll_id = ? ORDER BY created_at",
  )
    .bind(pollId)
    .all<{ id: string; answers: string; created_at: string }>();
  return results.map((r) => ({ id: r.id, createdAt: r.created_at, answers: JSON.parse(r.answers) as Answers }));
}

async function countResponses(env: Env, pollId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM responses WHERE poll_id = ?")
    .bind(pollId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

function pollUrl(origin: string, slug: string) {
  return `${origin}/p/${slug}`;
}

// ---------------------------------------------------------------- public API

async function handlePublic(request: Request, env: Env, parts: string[], url: URL): Promise<Response> {
  // parts: ["polls", slug, ...]
  const slug = parts[1];
  if (!slug || !SLUG_RE.test(slug)) throw new HttpError(404, "not_found", "Poll not found.");
  const poll = await getPollBy(env, "slug", slug);
  if (!poll || poll.status === "draft") throw new HttpError(404, "not_found", "Poll not found.");

  if (parts.length === 2 && request.method === "GET") {
    return json(publicPoll(poll, env));
  }

  if (parts[2] === "responses" && parts.length === 3 && request.method === "POST") {
    return submit(request, env, poll);
  }

  if (parts[2] === "results" && parts.length === 3 && request.method === "GET") {
    const mode = poll.settings.showResults;
    if (mode === "never") throw new HttpError(403, "results_private", "Results for this poll are private.");
    if (mode === "after_submit") {
      const rid = url.searchParams.get("respondentId") ?? "";
      const seen = rid
        ? await env.DB.prepare("SELECT 1 FROM responses WHERE poll_id = ? AND respondent_id = ? LIMIT 1")
            .bind(poll.id, rid)
            .first()
        : null;
      if (!seen) throw new HttpError(403, "respond_first", "Results show up once you've answered.");
    }
    const responses = await loadResponses(env, poll.id);
    return json(tally(poll.questions, responses.map((r) => r.answers), false));
  }

  throw new HttpError(404, "not_found", "Not found.");
}

async function verifyTurnstile(env: Env, token: unknown, ip: string): Promise<boolean> {
  if (typeof token !== "string" || token.length === 0 || token.length > 4096) return false;
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET!);
  form.append("response", token);
  form.append("remoteip", ip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
  const data = (await res.json()) as { success?: boolean };
  return data.success === true;
}

async function submit(request: Request, env: Env, poll: Poll): Promise<Response> {
  if (!isOpen(poll)) throw new HttpError(409, "closed", "This poll isn't taking responses anymore.");

  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const { success } = await env.SUBMIT_LIMITER.limit({ key: ip });
  if (!success) throw new HttpError(429, "rate_limited", "Too many submissions. Try again in a minute.");

  const body = (await readJson(request)) as Record<string, unknown>;
  if (typeof body !== "object" || body === null) throw new HttpError(400, "invalid_body", "Body must be an object.");

  // Honeypot: real browsers leave this hidden field empty. Pretend it worked.
  if (typeof body.website === "string" && body.website.length > 0) {
    return json({ ok: true, responseId: crypto.randomUUID() }, 201);
  }

  if (env.TURNSTILE_SECRET && !(await verifyTurnstile(env, body.turnstileToken, ip))) {
    throw new HttpError(403, "challenge_failed", "We couldn't confirm you're a person. Refresh and try again.");
  }

  const respondentId = typeof body.respondentId === "string" ? body.respondentId : "";
  if (!/^[A-Za-z0-9-]{16,64}$/.test(respondentId)) {
    throw new HttpError(400, "invalid_respondent", "respondentId must be 16-64 letters, digits or hyphens.");
  }

  const checked = validateAnswers(poll.questions, body.answers);
  if (checked.errors) throw new HttpError(400, "invalid_answers", "Some answers need another look.", checked.errors);

  const max = poll.settings.maxResponses;
  if (max && (await countResponses(env, poll.id)) >= max) {
    throw new HttpError(409, "full", "This poll has all the responses it needs.");
  }

  const id = crypto.randomUUID();
  const ipHash = await sha256Hex(`${env.IP_SALT}:${ip}`);
  const values = [id, poll.id, respondentId, ipHash, JSON.stringify(checked.answers), now()];
  // One statement so two quick submits from the same browser can't both land.
  const sql = poll.settings.allowMultipleResponses
    ? "INSERT INTO responses (id, poll_id, respondent_id, ip_hash, answers, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    : `INSERT INTO responses (id, poll_id, respondent_id, ip_hash, answers, created_at)
       SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS
       (SELECT 1 FROM responses WHERE poll_id = ?2 AND respondent_id = ?3)`;
  const result = await env.DB.prepare(sql).bind(...values).run();
  if (result.meta.changes === 0) {
    throw new HttpError(409, "already_responded", "You've already answered this poll.");
  }

  const showResults = poll.settings.showResults !== "never";
  const results = showResults
    ? tally(poll.questions, (await loadResponses(env, poll.id)).map((r) => r.answers), false)
    : undefined;
  return json({ ok: true, responseId: id, results }, 201);
}

// ----------------------------------------------------------------- admin API

async function handleAdmin(request: Request, env: Env, parts: string[], url: URL): Promise<Response> {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!env.ADMIN_TOKEN || !(await timingSafeEqual(token, env.ADMIN_TOKEN))) {
    throw new HttpError(401, "unauthorized", "A valid admin token is required.");
  }

  // parts: ["admin", "polls", id?, sub?]
  if (parts[1] !== "polls") throw new HttpError(404, "not_found", "Not found.");
  const id = parts[2];
  const sub = parts[3];

  if (!id) {
    if (request.method === "GET") {
      const { results } = await env.DB.prepare(
        `SELECT p.*, (SELECT COUNT(*) FROM responses r WHERE r.poll_id = p.id) AS response_count
         FROM polls p ORDER BY p.created_at DESC`,
      ).all<PollRow & { response_count: number }>();
      return json({
        polls: results.map((row) => {
          const p = toPoll(row);
          return {
            id: p.id,
            slug: p.slug,
            title: p.title,
            status: p.status,
            open: isOpen(p),
            closesAt: p.closesAt,
            questionCount: p.questions.length,
            responseCount: row.response_count,
            url: pollUrl(url.origin, p.slug),
            createdAt: p.createdAt,
            updatedAt: p.updatedAt,
          };
        }),
      });
    }
    if (request.method === "POST") return createPoll(request, env, url);
    throw new HttpError(405, "method_not_allowed", "Use GET or POST.");
  }

  const poll = await requirePoll(env, id);

  if (!sub) {
    if (request.method === "GET") {
      return json({ ...poll, url: pollUrl(url.origin, poll.slug), responseCount: await countResponses(env, poll.id) });
    }
    if (request.method === "PUT" || request.method === "PATCH") return updatePoll(request, env, url, poll);
    if (request.method === "DELETE") {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM responses WHERE poll_id = ?").bind(poll.id),
        env.DB.prepare("DELETE FROM polls WHERE id = ?").bind(poll.id),
      ]);
      return json({ ok: true, deleted: poll.id });
    }
    throw new HttpError(405, "method_not_allowed", "Use GET, PATCH, PUT or DELETE.");
  }

  if (sub === "results" && request.method === "GET") {
    const responses = await loadResponses(env, poll.id);
    return json({ poll: { id: poll.id, slug: poll.slug, title: poll.title }, ...tally(poll.questions, responses.map((r) => r.answers), true) });
  }

  if (sub === "responses" && request.method === "GET") {
    const responses = await loadResponses(env, poll.id);
    if (url.searchParams.get("format") === "csv") {
      return new Response(toCsv(poll.questions, responses), {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="${poll.slug}-responses.csv"`,
          "cache-control": "no-store",
        },
      });
    }
    return json({ poll: { id: poll.id, slug: poll.slug, title: poll.title, questions: poll.questions }, responses });
  }

  if (sub === "responses" && request.method === "DELETE") {
    const r = await env.DB.prepare("DELETE FROM responses WHERE poll_id = ?").bind(poll.id).run();
    return json({ ok: true, deleted: r.meta.changes });
  }

  throw new HttpError(404, "not_found", "Not found.");
}

async function createPoll(request: Request, env: Env, url: URL): Promise<Response> {
  const checked = validatePoll(await readJson(request));
  if (checked.errors) throw new HttpError(400, "invalid_poll", "The poll definition has problems.", checked.errors);
  const p = checked.poll;
  const slug = p.slug ?? randomSlug();
  if (await getPollBy(env, "slug", slug)) throw new HttpError(409, "slug_taken", "That slug is already used.");
  const id = crypto.randomUUID();
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO polls (id, slug, title, description, questions, settings, status, closes_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, slug, p.title, p.description ?? null, JSON.stringify(p.questions), JSON.stringify(p.settings), p.status, p.closesAt ?? null, ts, ts)
    .run();
  const poll = (await getPollBy(env, "id", id))!;
  return json({ ...poll, url: pollUrl(url.origin, slug) }, 201);
}

async function updatePoll(request: Request, env: Env, url: URL, existing: Poll): Promise<Response> {
  const body = await readJson(request);
  // PUT replaces the definition; PATCH merges over it.
  const base = request.method === "PATCH" ? { ...existing, slug: existing.slug } : undefined;
  const checked = validatePoll(body, base);
  if (checked.errors) throw new HttpError(400, "invalid_poll", "The poll definition has problems.", checked.errors);
  const p = checked.poll;
  const slug = p.slug ?? existing.slug;
  if (slug !== existing.slug && (await getPollBy(env, "slug", slug))) {
    throw new HttpError(409, "slug_taken", "That slug is already used.");
  }
  await env.DB.prepare(
    `UPDATE polls SET slug = ?, title = ?, description = ?, questions = ?, settings = ?, status = ?, closes_at = ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(slug, p.title, p.description ?? null, JSON.stringify(p.questions), JSON.stringify(p.settings), p.status, p.closesAt ?? null, now(), existing.id)
    .run();
  const poll = (await getPollBy(env, "id", existing.id))!;
  return json({ ...poll, url: pollUrl(url.origin, poll.slug) });
}

// -------------------------------------------------------------------- router

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.startsWith("/p/")) {
      // Every poll URL serves the same page; it loads its poll from the API.
      return env.ASSETS.fetch(new Request(new URL("/poll", url), request));
    }

    if (!path.startsWith("/api/")) return env.ASSETS.fetch(request);

    const parts = path.slice(5).split("/").filter(Boolean);
    try {
      if (parts[0] === "admin") return await handleAdmin(request, env, parts, url);
      if (parts[0] === "polls") return await handlePublic(request, env, parts, url);
      if (parts[0] === "health") return json({ ok: true });
      throw new HttpError(404, "not_found", "Not found.");
    } catch (err) {
      if (err instanceof HttpError) {
        return json({ error: { code: err.code, message: err.message, details: err.details } }, err.status);
      }
      console.error(err);
      return json({ error: { code: "server_error", message: "Something went wrong on our side." } }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
