// Browser-global stubs for the headless store tests (node:test, no DOM).
// Imported FIRST by store.test.ts so the simStore singleton sees a `window`
// with localStorage / location / requestAnimationFrame before it is created.
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = process.cwd();

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number { return this.map.size; }
  clear(): void { this.map.clear(); }
  getItem(key: string): string | null { return this.map.has(key) ? this.map.get(key)! : null; }
  key(index: number): string | null { return [...this.map.keys()][index] ?? null; }
  removeItem(key: string): void { this.map.delete(key); }
  setItem(key: string, value: string): void { this.map.set(key, String(value)); }
}

export const rafCalls: Array<(t: number) => void> = [];
export const localStorageStub = new MemoryStorage();

const g = globalThis as unknown as Record<string, unknown>;
g.localStorage = localStorageStub;
g.location = { search: '' };
g.requestAnimationFrame = (cb: (t: number) => void) => { rafCalls.push(cb); return rafCalls.length; };
g.cancelAnimationFrame = () => { /* no-op */ };
// `window` is the global object itself (like a browser) so window.localStorage / window.location resolve.
g.window = globalThis;

/** Serve /maps/osm/*.geojson and /airspace/*.txt from public/. */
g.fetch = async (input: unknown) => {
  const url = String(input);
  const rel = url.startsWith('/') ? url.slice(1) : url;
  const file = path.join(ROOT, 'public', rel);
  const exists = (url.startsWith('/maps/osm/') || url.startsWith('/airspace/')) && fs.existsSync(file);
  if (!exists) return { ok: false, status: 404, json: async () => { throw new Error('404'); }, text: async () => '' };
  return { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(file, 'utf8')), text: async () => fs.readFileSync(file, 'utf8') };
};

export function setUrlSearch(search: string): void { (g.location as { search: string }).search = search; }
