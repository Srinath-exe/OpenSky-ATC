/* Crash reports and "Report a problem": what the page was doing, the last radio lines and what the speech engine
   heard, posted to /api/report (stored on the server, read with scripts/reports.sh). No audio, no personal data. */
import { recentAttempts } from './voice/asr-diag';

type Store = { radio?: Array<{ who: string; text: string; at: number; status?: string; callsign?: string }>; icao?: string; position?: string; paused?: boolean; rate?: number };

function context() {
  const w = window as unknown as { __atcSim?: Store; __coach?: { state?: { stage?: string; id?: string } } };
  const s = w.__atcSim;
  let prefs: Record<string, string | null> = {};
  try { prefs = { look: localStorage.getItem('skycontrol_world_look'), models: localStorage.getItem('skycontrol_models_v1')?.slice(0, 400) ?? null }; } catch { /* storage blocked */ }
  return {
    url: location.pathname + location.search,
    ua: navigator.userAgent,
    screen: `${innerWidth}x${innerHeight}@${devicePixelRatio}`,
    lang: navigator.language,
    build: (document.querySelector('meta[name="build"]') as HTMLMetaElement | null)?.content,
    sim: s ? { icao: s.icao, position: s.position, paused: s.paused, rate: s.rate } : undefined,
    coach: w.__coach?.state ? { stage: w.__coach.state.stage, id: w.__coach.state.id } : undefined,
    radio: s?.radio?.slice(-20).map((l) => ({ who: l.who, text: l.text.slice(0, 200), at: Math.round(l.at), status: l.status })),
    speech: recentAttempts(),
    prefs,
  };
}

function post(body: Record<string, unknown>): Promise<string | null> {
  return fetch('/api/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), keepalive: true })
    .then((r) => r.ok ? r.json().then((j: { id?: string }) => j.id ?? null) : null).catch(() => null);
}

/** The player's own report. Resolves to the report id, or null when it could not be sent. */
export function reportProblem(note: string): Promise<string | null> {
  return post({ kind: 'report', note: note.slice(0, 4000), ...context() });
}

let installed = false;
const seen = new Set<string>();
/** Uncaught errors and rejected promises: each distinct message once per page load, at most 8. */
export function installErrorReporting(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const send = (message: string, stack?: string) => {
    if (!message || seen.has(message) || seen.size >= 8) return;
    if (/ResizeObserver loop|Script error\.?$|chrome-extension:|moz-extension:/.test(message + (stack ?? ''))) return;
    seen.add(message);
    void post({ kind: 'error', message: message.slice(0, 500), stack: stack?.slice(0, 3000), ...context() });
  };
  window.addEventListener('error', (e) => send(e.message, e.error instanceof Error ? e.error.stack : `${e.filename}:${e.lineno}:${e.colno}`));
  window.addEventListener('unhandledrejection', (e) => { const r = e.reason; send(r instanceof Error ? r.message : String(r), r instanceof Error ? r.stack : undefined); });
}
