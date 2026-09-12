/*
  Browser console / page-error collector (05-TEST-STRATEGY §6.3).

  Attached to every page of the test's context. `console.error` messages and uncaught `pageerror`s
  fail the test at teardown unless they match the allowlist below. Everything else (log / warn / info)
  is recorded and attached to the report on failure for triage.
*/
import type { BrowserContext, ConsoleMessage, Page, TestInfo } from '@playwright/test';

export interface CollectedEntry {
  kind: 'console' | 'pageerror';
  type: string;
  text: string;
  url?: string;
  at: number;
}

/** Messages that are noise in this environment, never product defects. */
export const CONSOLE_ALLOWLIST: RegExp[] = [
  /favicon/i,                                   // favicon 404 (no route)
  /AbortError/i,                                // MapLibre cancels tile / style fetches on style swap and unmount
  /GPU stall due to ReadPixels/i,               // swiftshader performance notice (MapLibre readPixels in headless GL)
  /\[\.WebGL-[^\]]*\]\s*GL Driver Message/i,    // any other GL driver "performance" line under swiftshader
  /Download the React DevTools/i,
  /Fast Refresh/i,
  /preloaded (using|with) link preload/i,       // Next "preloaded CSS not used" dev warning
  /net::ERR_ABORTED/i,                          // navigation away while a request was in flight
];

export class ConsoleCollector {
  readonly entries: CollectedEntry[] = [];
  readonly extraAllow: RegExp[] = [];
  private started = Date.now();

  constructor(readonly context: BrowserContext) {
    for (const p of context.pages()) this.attach(p);
    context.on('page', (p) => this.attach(p));
  }

  /** Allow one more pattern for the rest of this test (use sparingly; explain why in the spec). */
  allow(re: RegExp): void { this.extraAllow.push(re); }

  private attach(page: Page): void {
    page.on('console', (msg: ConsoleMessage) => {
      let url: string | undefined;
      try { url = msg.location()?.url; } catch { url = undefined; }
      this.entries.push({ kind: 'console', type: msg.type(), text: msg.text(), url, at: Date.now() - this.started });
    });
    page.on('pageerror', (err: Error) => {
      this.entries.push({ kind: 'pageerror', type: 'pageerror', text: `${err.name}: ${err.message}\n${err.stack ?? ''}`, at: Date.now() - this.started });
    });
  }

  private allowed(e: CollectedEntry): boolean {
    const hay = `${e.text} ${e.url ?? ''}`;
    return [...CONSOLE_ALLOWLIST, ...this.extraAllow].some((re) => re.test(hay));
  }

  /** Entries that count as failures. */
  failures(): CollectedEntry[] {
    return this.entries.filter((e) => (e.kind === 'pageerror' || e.type === 'error') && !this.allowed(e));
  }

  /** Human-readable dump for attachments. */
  dump(): string {
    return this.entries.map((e) => `[${String(e.at).padStart(6)}ms] ${e.kind === 'pageerror' ? 'PAGEERROR' : e.type.toUpperCase()} ${e.text}${e.url ? `  (${e.url})` : ''}`).join('\n');
  }

  /** Attach the log to the report and throw if any disallowed error was seen. */
  async finish(testInfo: TestInfo): Promise<void> {
    const failures = this.failures();
    if (this.entries.length && (failures.length || testInfo.status !== testInfo.expectedStatus)) {
      await testInfo.attach('browser-console', { body: this.dump(), contentType: 'text/plain' });
    }
    if (failures.length) {
      const lines = failures.map((f) => `  - ${f.kind === 'pageerror' ? 'pageerror' : 'console.error'}: ${f.text.split('\n')[0]}${f.url ? ` (${f.url})` : ''}`);
      throw new Error(`Browser reported ${failures.length} error(s) during the test:\n${lines.join('\n')}\n(allowlist: tests/e2e/fixtures/console.ts)`);
    }
  }
}
