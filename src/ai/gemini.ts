/**
 * Minimal Gemini API client for the FREE tier only (Google AI Studio key on a project without billing).
 *
 * - One shared FIFO queue with a self-imposed requests-per-minute cap (GEMINI_RPM, default 8) and a daily
 *   cap (GEMINI_RPD, default 400) counted per Pacific day, below the free-tier quota of the default model.
 * - 429 RESOURCE_EXHAUSTED: honours the server's RetryInfo delay (short waits are retried, per-day quota
 *   stops all AI calls until the Pacific midnight reset). 5xx: exponential backoff.
 * - Only free-tier "flash" class models are accepted; anything else falls back to the default model.
 * - The key goes in the x-goog-api-key header (never in the URL) and is never logged.
 */
import { log } from '../log.js';
import { backoffMs, RateLimiter, sleep } from '../data/ratelimit.js';

export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';
/** Free-tier text+vision models. Pro / Carbon / Neon / Argon / Omni / image / TTS / live models are refused. */
export function freeTierModel(model: string | undefined): string {
  const m = (model ?? '').trim();
  if (!m) return DEFAULT_GEMINI_MODEL;
  const ok = /^(gemini-[\d.]+-flash(-lite)?|gemini-4-hydrogen|gemini-flash(-lite)?-latest)$/.test(m);
  if (!ok) log.warn(`GEMINI_MODEL=${m} is not a free-tier flash model; using ${DEFAULT_GEMINI_MODEL}`);
  return ok ? m : DEFAULT_GEMINI_MODEL;
}

export type GeminiErrorKind = 'noKey' | 'badKey' | 'busy' | 'quota' | 'blocked' | 'failed';
export class GeminiError extends Error {
  constructor(public kind: GeminiErrorKind, message: string, public status?: number) { super(message); this.name = 'GeminiError'; }
}

export interface UsageStore { aiUsage(day: string, model: string): number; bumpAiUsage(day: string, model: string, by?: number): void }
export type Part = { text: string } | { inline_data: { mime_type: string; data: string } };
export interface GenerateOptions { system?: string; schema?: unknown; temperature?: number; maxOutputTokens?: number }

/** Day key in America/Los_Angeles: the free-tier daily quota resets at Pacific midnight. */
export const pacificDay = (ms = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));

/** "37s" / "1.5s" → ms. */
export function parseRetryDelay(body: unknown): number | null {
  const details = (body as { error?: { details?: { '@type'?: string; retryDelay?: string }[] } })?.error?.details ?? [];
  for (const d of details) {
    const m = /^([\d.]+)s$/.exec(d.retryDelay ?? '');
    if (m) return Math.ceil(Number(m[1]) * 1000);
  }
  return null;
}
const isDailyQuota = (body: unknown) => /PerDay|per day|daily/i.test(JSON.stringify((body as { error?: unknown })?.error ?? ''));

export interface GeminiOptions {
  apiKey: string; model?: string; rpm?: number; rpd?: number; maxQueue?: number; store?: UsageStore;
  fetch?: typeof fetch; now?: () => number; wait?: (ms: number) => Promise<void>; base?: string;
}

export class Gemini {
  readonly model: string;
  private limiter: RateLimiter;
  private queued = 0;
  private exhaustedDay: string | null = null;
  private memUsage = new Map<string, number>();
  constructor(private o: GeminiOptions) {
    this.model = freeTierModel(o.model);
    this.limiter = new RateLimiter(Math.max(1, o.rpm ?? 8), 60_000, o.now ?? Date.now, o.wait ?? sleep);
  }
  get available() { return !!this.o.apiKey; }
  get rpd() { return this.o.rpd ?? 400; }
  usedToday(): number {
    const day = pacificDay(this.now());
    return this.o.store ? this.o.store.aiUsage(day, this.model) : this.memUsage.get(day) ?? 0;
  }
  private now() { return (this.o.now ?? Date.now)(); }
  private bump() {
    const day = pacificDay(this.now());
    if (this.o.store) this.o.store.bumpAiUsage(day, this.model, 1);
    else this.memUsage.set(day, (this.memUsage.get(day) ?? 0) + 1);
  }

  /** Generate text (or JSON text when `schema` is given). Throws GeminiError with a kind the UI can localize. */
  async generate(parts: Part[], g: GenerateOptions = {}): Promise<string> {
    if (!this.o.apiKey) throw new GeminiError('noKey', 'GEMINI_API_KEY is not set');
    const day = pacificDay(this.now());
    if (this.exhaustedDay === day || this.usedToday() >= this.rpd) throw new GeminiError('quota', `daily cap reached (${this.rpd}/day)`);
    if (this.queued >= (this.o.maxQueue ?? 6)) throw new GeminiError('busy', 'AI queue is full');
    this.queued++;
    try {
      const body = {
        contents: [{ role: 'user', parts }],
        ...(g.system ? { systemInstruction: { parts: [{ text: g.system }] } } : {}),
        generationConfig: {
          temperature: g.temperature ?? 0.2,
          maxOutputTokens: g.maxOutputTokens ?? 2048,
          ...(g.schema ? { responseMimeType: 'application/json', responseSchema: g.schema } : {}),
        },
      };
      const f = this.o.fetch ?? fetch;
      const wait = this.o.wait ?? sleep;
      const url = `${this.o.base ?? 'https://generativelanguage.googleapis.com'}/v1beta/models/${encodeURIComponent(this.model)}:generateContent`;
      for (let attempt = 0; ; attempt++) {
        await this.limiter.acquire();
        if (this.usedToday() >= this.rpd) throw new GeminiError('quota', `daily cap reached (${this.rpd}/day)`);
        this.bump();
        let res: Response;
        try {
          res = await f(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': this.o.apiKey }, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000) });
        } catch (e) {
          if (attempt < 2) { await wait(backoffMs(attempt, 2000, 15_000)); continue; }
          throw new GeminiError('failed', `network: ${(e as Error).message}`);
        }
        const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (res.status === 429) {
          if (isDailyQuota(json)) { this.exhaustedDay = day; throw new GeminiError('quota', 'free-tier daily quota exhausted', 429); }
          const delay = parseRetryDelay(json) ?? backoffMs(attempt, 5000, 60_000);
          this.limiter.pause(delay);
          if (attempt < 2 && delay <= 65_000) { log.warn(`gemini 429: retrying in ${Math.round(delay / 1000)}s`); continue; }
          throw new GeminiError('busy', 'rate limited', 429);
        }
        if (res.status >= 500) {
          if (attempt < 2) { await wait(backoffMs(attempt, 3000, 20_000)); continue; }
          throw new GeminiError('failed', `HTTP ${res.status}`, res.status);
        }
        if (res.status === 400 || res.status === 401 || res.status === 403) {
          const msg = String((json.error as { message?: string })?.message ?? `HTTP ${res.status}`);
          if (/api key|API_KEY|permission|unauthori[sz]ed/i.test(msg) || res.status !== 400) throw new GeminiError('badKey', msg.slice(0, 200), res.status);
          throw new GeminiError('failed', msg.slice(0, 200), res.status);
        }
        if (!res.ok) throw new GeminiError('failed', `HTTP ${res.status}`, res.status);
        const cand = (json.candidates as { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[] | undefined)?.[0];
        const blocked = (json.promptFeedback as { blockReason?: string } | undefined)?.blockReason;
        if (blocked || cand?.finishReason === 'SAFETY' || cand?.finishReason === 'PROHIBITED_CONTENT') throw new GeminiError('blocked', blocked ?? cand?.finishReason ?? 'blocked');
        const text = (cand?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? '').join('').trim();
        if (!text) throw new GeminiError('failed', `empty answer (${cand?.finishReason ?? 'no candidate'})`);
        return text;
      }
    } finally {
      this.queued--;
    }
  }

  /** generate() + JSON.parse (tolerates ```json fences). */
  async json<T = unknown>(parts: Part[], g: GenerateOptions & { schema: unknown }): Promise<T> {
    const text = await this.generate(parts, g);
    const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    try { return JSON.parse(clean) as T; } catch { throw new GeminiError('failed', 'answer was not valid JSON'); }
  }
}
