/*
  LLM I/O — the transport (docs/spec/07-LLM-IO.md §4).

  One request shape for every backend: an OpenAI-compatible chat completion (Ollama, llama.cpp server, vLLM, LM Studio,
  OpenAI itself all speak it). By default the browser posts to the game's own /api/llm/chat, which forwards to the
  configured endpoint server-side (no CORS, the key never leaves the server); `direct` posts to the endpoint from the
  browser for servers that allow it (or in-browser models exposed on localhost).
*/
import type { PlayerPosition } from '../sim/types';

export interface LlmConfig {
  mode: 'off' | 'advise' | 'control';
  /** Positions the model works (control) or advises on (advise). */
  positions: PlayerPosition[];
  /** OpenAI-compatible base URL ending in /v1 ('' = the server's LLM_BASE_URL). */
  endpoint: string;
  model: string;
  apiKey: string;
  /** Seconds between calls per position (a new request or alert triggers a call sooner). */
  intervalS: number;
  temperature: number;
  maxTokens: number;
  /** Call the endpoint straight from the browser instead of through /api/llm/chat. */
  direct: boolean;
  /** Log observation → action pairs (the player's and the model's) for fine-tuning. */
  record: boolean;
}

export const DEFAULT_LLM_CONFIG: LlmConfig = {
  mode: 'off', positions: ['ground'], endpoint: '', model: '', apiKey: '', intervalS: 8, temperature: 0.1, maxTokens: 200, direct: false, record: false,
};

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface ChatResult { text: string; model: string | null; ms: number; usage: { prompt: number; completion: number } | null }

/** One chat completion. Throws with a readable message on transport / HTTP / shape errors. */
export async function chatComplete(cfg: LlmConfig, messages: ChatMessage[], signal?: AbortSignal): Promise<ChatResult> {
  const t0 = Date.now();
  const body = { model: cfg.model || undefined, messages, temperature: cfg.temperature, max_tokens: cfg.maxTokens, stream: false };
  let url: string; const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cfg.direct) {
    url = `${cfg.endpoint.replace(/\/+$/, '')}/chat/completions`;
    if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  } else {
    url = '/api/llm/chat';
    Object.assign(body, { endpoint: cfg.endpoint || undefined, apiKey: cfg.apiKey || undefined });
  }
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  const raw = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${raw.slice(0, 200)}`);
  let json: { choices?: { message?: { content?: string | null }; text?: string }[]; model?: string; usage?: { prompt_tokens?: number; completion_tokens?: number }; error?: { message?: string } | string };
  try { json = JSON.parse(raw); } catch { throw new Error(`non-JSON reply: ${raw.slice(0, 120)}`); }
  if (json.error) throw new Error(typeof json.error === 'string' ? json.error : json.error.message ?? 'error');
  const c = json.choices?.[0];
  const text = (c?.message?.content ?? c?.text ?? '').trim();
  return { text, model: json.model ?? null, ms: Date.now() - t0, usage: json.usage ? { prompt: json.usage.prompt_tokens ?? 0, completion: json.usage.completion_tokens ?? 0 } : null };
}

/** GET /models on the endpoint (through the proxy unless direct) — a cheap connectivity probe. */
export async function probeEndpoint(cfg: LlmConfig, signal?: AbortSignal): Promise<{ ok: boolean; models: string[]; error: string | null; ms: number }> {
  const t0 = Date.now();
  try {
    let res: Response;
    if (cfg.direct) res = await fetch(`${cfg.endpoint.replace(/\/+$/, '')}/models`, { headers: cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : undefined, signal });
    else res = await fetch(`/api/llm/chat?probe=1${cfg.endpoint ? `&endpoint=${encodeURIComponent(cfg.endpoint)}` : ''}`, { headers: cfg.apiKey ? { 'x-llm-key': cfg.apiKey } : undefined, signal });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, models: [], error: `${res.status} ${json?.error ?? ''}`.trim(), ms: Date.now() - t0 };
    const models: string[] = Array.isArray(json?.data) ? json.data.map((m: { id?: string }) => m.id ?? '').filter(Boolean) : Array.isArray(json?.models) ? json.models.map((m: { name?: string; id?: string }) => m.name ?? m.id ?? '').filter(Boolean) : [];
    return { ok: true, models, error: null, ms: Date.now() - t0 };
  } catch (err) {
    return { ok: false, models: [], error: err instanceof Error ? err.message : String(err), ms: Date.now() - t0 };
  }
}
