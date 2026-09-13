/*
  /api/llm/chat — server-side proxy to an OpenAI-compatible LLM endpoint (docs/spec/07-LLM-IO.md §4).

  POST { model?, messages, temperature?, max_tokens?, endpoint?, apiKey? }  →  the upstream chat completion JSON
  GET  ?probe=1[&endpoint=]                                               →  the upstream /models list

  The upstream base URL is LLM_BASE_URL (default: Ollama on this host), the key LLM_API_KEY, the default model LLM_MODEL.
  A request may name its own endpoint only when it points at this machine / the private LAN or a host listed in
  LLM_ALLOW_HOSTS (comma separated) — the proxy must not become an open relay.
*/
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_BASE = process.env.LLM_BASE_URL || 'http://127.0.0.1:11434/v1';

function allowed(endpoint: string): boolean {
  let u: URL;
  try { u = new URL(endpoint); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === 'host.docker.internal') return true;
  if (/^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  const list = (process.env.LLM_ALLOW_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (list.includes('*') || list.includes(h)) return true;
  try { return new URL(DEFAULT_BASE).hostname.toLowerCase() === h; } catch { return false; }
}

function resolveBase(requested: string | undefined): { base: string } | { error: string } {
  const base = (requested || DEFAULT_BASE).replace(/\/+$/, '');
  if (requested && !allowed(base)) return { error: `endpoint not allowed: ${base} (LLM_ALLOW_HOSTS)` };
  return { base };
}

function upstreamHeaders(key: string | undefined): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  const k = key || process.env.LLM_API_KEY;
  if (k) h.authorization = `Bearer ${k}`;
  return h;
}

export async function POST(req: Request): Promise<Response> {
  let body: { model?: string; messages?: unknown; temperature?: number; max_tokens?: number; endpoint?: string; apiKey?: string; stream?: boolean };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 }); }
  if (!Array.isArray(body.messages) || !body.messages.length) return NextResponse.json({ error: 'messages[] required' }, { status: 400 });
  const r = resolveBase(body.endpoint);
  if ('error' in r) return NextResponse.json({ error: r.error }, { status: 403 });
  const model = body.model || process.env.LLM_MODEL || undefined;
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 60_000);
  try {
    const up = await fetch(`${r.base}/chat/completions`, {
      method: 'POST', headers: upstreamHeaders(body.apiKey), signal: ctl.signal,
      body: JSON.stringify({ model, messages: body.messages, temperature: body.temperature ?? 0.1, max_tokens: body.max_tokens ?? 200, stream: false }),
    });
    const text = await up.text();
    return new Response(text, { status: up.status, headers: { 'content-type': up.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' } });
  } catch (err) {
    const msg = err instanceof Error ? (err.name === 'AbortError' ? 'upstream timeout (60 s)' : err.message) : String(err);
    return NextResponse.json({ error: `upstream ${r.base}: ${msg}` }, { status: 502 });
  } finally { clearTimeout(timer); }
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const r = resolveBase(url.searchParams.get('endpoint') || undefined);
  if ('error' in r) return NextResponse.json({ error: r.error }, { status: 403 });
  if (!url.searchParams.get('probe')) return NextResponse.json({ ok: true, base: r.base, model: process.env.LLM_MODEL ?? null });
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 8_000);
  try {
    const up = await fetch(`${r.base}/models`, { headers: upstreamHeaders(req.headers.get('x-llm-key') ?? undefined), signal: ctl.signal });
    const text = await up.text();
    return new Response(text, { status: up.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  } catch (err) {
    return NextResponse.json({ error: `upstream ${r.base}: ${err instanceof Error ? err.message : String(err)}` }, { status: 502 });
  } finally { clearTimeout(timer); }
}
