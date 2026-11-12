/*
  /api/report: crash reports and "Report a problem" notes from the live site, one JSON line each in
  <REPORTS_DIR>/<YYYY-MM-DD>.jsonl (default: data/reports of the checkout). Read them with scripts/reports.sh.
  Public and unauthenticated, so it is rate-limited per client, capped in size and only ever appends.
*/
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { RateLimiter, clientKey } from '../voice/stt/handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX = 64 * 1024;
const g = globalThis as unknown as { __openatcReports?: RateLimiter };
const limiter = (g.__openatcReports ??= new RateLimiter(12, 6));

function reportsDir(): string {
  if (process.env.REPORTS_DIR) return process.env.REPORTS_DIR;
  const cwd = process.cwd();
  return cwd.endsWith(path.join('.next', 'standalone')) ? path.join(cwd, '..', '..', 'data', 'reports') : path.join(cwd, 'data', 'reports');
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export async function POST(req: Request) {
  if (!limiter.take(clientKey(req.headers))) return json({ error: 'too many reports' }, 429);
  const text = await req.text();
  if (text.length > MAX) return json({ error: 'too large' }, 413);
  let body: Record<string, unknown>;
  try { body = JSON.parse(text); } catch { return json({ error: 'bad json' }, 400); }
  if (!body || typeof body !== 'object' || (body.kind !== 'error' && body.kind !== 'report')) return json({ error: 'bad kind' }, 400);
  const now = new Date();
  const id = `${body.kind === 'report' ? 'r' : 'e'}-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const line = JSON.stringify({ id, at: now.toISOString(), country: req.headers.get('cf-ipcountry') ?? undefined, ...body }) + '\n';
  const dir = reportsDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(path.join(dir, `${now.toISOString().slice(0, 10)}.jsonl`), line);
  return json({ ok: true, id });
}
