/*
  Edge LLM I/O (docs/spec/07-LLM-IO.md).

  Store: src/lib/llm/* (observe / prompt / client / agent) + simStore `llm`, `updateLlm`, `llmAgent`, `llmStatus`;
  proxy: src/app/api/llm/chat/route.ts; UI: SettingsModal "Edge LLM" section (`llm-section`, `llm-mode-*`, `llm-pos-*`,
  `llm-endpoint`, `llm-model`, `llm-record`, `llm-export`, `llm-test`, `llm-status`, `llm-probe`).

  The model is mocked with page.route on /api/llm/chat: it answers the first open request in the observation it is
  sent, so the assertions cover the whole loop (observation → reply → command path → comm log / engine) without a model.
*/
import { test, expect } from './fixtures/test';
import type { Page } from '@playwright/test';
import { readLocalStorageJson } from './fixtures/storage';

import type {} from '@/components/atc/simStore';   // the global window.__atcSim typing

const APP = { icao: 'KSFO', spawn: 'none', position: 'tower' } as const;

/** Mock model: answer the first REQUEST line with its first canonical answer (runway placeholder filled from the aircraft line). */
async function mockModel(page: Page, seen: { bodies: Array<{ messages: { role: string; content: string }[] }> }, fixed?: string) {
  await page.route('**/api/llm/chat', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const body = route.request().postDataJSON() as { messages: { role: string; content: string }[] };
    seen.bodies.push(body);
    const obs = body.messages[1]?.content ?? '';
    let reply = fixed ?? 'NOOP';
    if (!fixed) {
      const m = obs.match(/^- ([A-Z0-9]+): ".*?" \(\d+s\) · answers: ([^|\n]+)/m);
      if (m) { const rwy = (obs.match(new RegExp(`^- ${m[1]} .*?rwy (\\w+)`, 'm')) ?? [])[1] ?? '28L'; reply = `${m[1]} ${m[2].trim().replace('<rwy>', rwy).replace(' VIA <twys>', '')}`; }
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ model: 'mock-edge', choices: [{ message: { role: 'assistant', content: `\`\`\`\n${reply}\n\`\`\`` } }], usage: { prompt_tokens: 420, completion_tokens: 9 } }) });
  });
}

test.describe('edge LLM', () => {
  test('control mode: the observation carries the request and the valid actions, the model line is executed on GROUND and logged as LLM, status and I/O log update @full', async ({ openGame, sim, page }) => {
    await openGame(APP);
    await sim.spawnAt({ callsign: 'AFR851', type: 'B752', kind: 'departure', phase: 'parked', gate: 'F18' });
    await sim.request('AFR851', 'pushback');
    const seen = { bodies: [] as Array<{ messages: { role: string; content: string }[] }> };
    await mockModel(page, seen);
    await page.evaluate(() => window.__atcSim!.updateLlm({ mode: 'control', positions: ['ground'], model: 'mock-edge', intervalS: 4, record: true }));
    await sim.advance(2);
    await page.evaluate(() => window.__atcSim!.llmAgent.tick('ground'));
    await expect.poll(() => page.evaluate(() => window.__atcSim!.llmStatus().calls)).toBe(1);

    // the prompt: system rules + the observation for GROUND with the request and its answers
    expect(seen.bodies).toHaveLength(1);
    const [sys, user] = seen.bodies[0].messages;
    expect(sys.role).toBe('system'); expect(sys.content).toContain('POSITION: GROUND');
    expect(user.content).toMatch(/^SKYCONTROL KSFO · you are GROUND/);
    expect(user.content).toMatch(/^REQUESTS ON GROUND \(1\)/m);
    expect(user.content).toMatch(/^- AFR851: ".*request pushback.*" \(\d+s\) · answers: PUSHBACK APPROVED \| STANDBY \| UNABLE/m);
    expect(user.content).toMatch(/^- AFR851 B752\/M DEP · Parked at stand.*· can: PUSHBACK APPROVED/m);

    // executed on GROUND (the player is on TOWER): the request is answered, the line is tagged LLM in the comm log
    const radio = await sim.radio();
    const llmLine = radio.find((l) => l.who === 'LLM');
    expect(llmLine?.text).toMatch(/Air France eight fifty-one, pushback approved/i);
    expect(llmLine?.position).toBe('ground');
    expect((await sim.aircraftOrFail('AFR851')).requests ?? []).toHaveLength(0);
    await sim.advanceUntilOk("s => s.aircraft.find(a => a.callsign === 'AFR851')?.phase === 'pushback'", 20);
    await page.getByTestId('log-filter-all').click();   // the player is on TOWER; the LLM spoke on GROUND
    await expect(page.locator('[data-testid="comm-log"] [data-who="LLM"]').first()).toBeVisible();

    const status = await page.evaluate(() => window.__atcSim!.llmStatus());
    expect(status.errors).toBe(0); expect(status.model).toBe('mock-edge'); expect(status.lastReply).toContain('AFR851 PUSHBACK APPROVED'); expect(status.tokens.prompt).toBe(420);
    // the I/O log holds the model call, and (recording on) the player's own commands with the observation they saw
    await sim.command('AFR851 WIND CHECK');
    const log = await page.evaluate(() => window.__atcSim!.llmAgent.log.map((r) => ({ source: r.source, reply: r.reply, ok: r.actions[0]?.ok })));
    expect(log[0]).toEqual({ source: 'model', reply: '```\nAFR851 PUSHBACK APPROVED\n```', ok: true });
    expect(log.some((r) => r.source === 'player' && r.reply === 'AFR851 WIND CHECK' && r.ok)).toBe(true);
    const jsonl = await page.evaluate(() => window.__atcSim!.llmAgent.exportJsonl());
    const first = JSON.parse(jsonl.split('\n')[0]);
    expect(first.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user', 'assistant']);
    expect(first.meta.position).toBe('ground');
  });

  test('advise mode posts suggestions only; a rejected line comes back to the model as REJECTED with the reason @full', async ({ openGame, sim, page }) => {
    await openGame(APP);
    await sim.spawnAt({ callsign: 'AFR851', type: 'B752', kind: 'departure', phase: 'parked', gate: 'F18' });
    await sim.request('AFR851', 'pushback');
    const seen = { bodies: [] as Array<{ messages: { role: string; content: string }[] }> };
    await mockModel(page, seen);
    await page.evaluate(() => window.__atcSim!.updateLlm({ mode: 'advise', positions: ['ground'], model: 'mock-edge' }));
    await page.evaluate(() => window.__atcSim!.llmAgent.tick('ground'));
    await expect.poll(() => page.evaluate(() => window.__atcSim!.llmStatus().calls)).toBe(1);
    const radio = await sim.radio();
    expect(radio.find((l) => l.who === 'LLM')?.text).toBe('▸ AFR851 PUSHBACK APPROVED');
    expect((await sim.aircraftOrFail('AFR851')).requests?.length ?? 0).toBe(1);   // nothing was transmitted

    // control mode with a line the parser refuses: the SYS error line appears and the next observation carries the reason
    await page.unroute('**/api/llm/chat');
    await mockModel(page, seen, 'AFR851 CLEARED FOR TAKEOFF 99');
    await page.evaluate(() => window.__atcSim!.updateLlm({ mode: 'control' }));
    await page.evaluate(() => window.__atcSim!.llmAgent.tick('ground'));
    await expect.poll(() => page.evaluate(() => window.__atcSim!.llmStatus().calls)).toBe(2);
    expect((await sim.radio()).some((l) => l.who === 'SYS' && /CLEARED FOR TAKEOFF 99/.test(l.text))).toBe(true);
    await page.evaluate(() => window.__atcSim!.llmAgent.tick('ground'));
    await expect.poll(() => page.evaluate(() => window.__atcSim!.llmStatus().calls)).toBe(3);
    expect(seen.bodies[seen.bodies.length - 1].messages[1].content).toMatch(/^YOUR LAST ACTIONS\n- "AFR851 CLEARED FOR TAKEOFF 99" → REJECTED: .+/m);
  });

  test('settings modal: the Edge LLM section edits and persists its own blob; the proxy refuses foreign endpoints @full', async ({ openGame, game, page }) => {
    await openGame(APP);
    await game.settingsBtn().click();
    const section = page.getByTestId('llm-section');
    await expect(section).toBeVisible();
    await page.getByTestId('llm-mode-advise').click();
    await page.getByTestId('llm-pos-tower').click();
    await page.getByTestId('llm-endpoint').fill('http://127.0.0.1:11434/v1');
    await page.getByTestId('llm-model').fill('qwen2.5:3b');
    await expect(page.getByTestId('llm-mode-advise')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('llm-pos-tower')).toHaveAttribute('aria-pressed', 'true');
    const stored = await readLocalStorageJson<{ mode: string; positions: string[]; endpoint: string; model: string }>(page, 'skycontrol_llm');
    expect(stored).toMatchObject({ mode: 'advise', positions: ['ground', 'tower'], endpoint: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:3b' });
    // the position tabs show the AI dot for LLM-controlled positions only in control mode
    await page.getByTestId('llm-mode-control').click();
    await expect(page.getByTestId('mode-tab-ground')).toHaveAttribute('data-ai', 'true');
    await page.getByTestId('llm-mode-off').click();
    await expect(page.getByTestId('mode-tab-ground')).toHaveAttribute('data-ai', 'false');
    // reload keeps the config
    await page.reload();
    await expect.poll(() => page.evaluate(() => window.__atcSim?.llm.model ?? null)).toBe('qwen2.5:3b');
    // proxy: a request naming a public host is refused (403); a bad body is 400
    const bad = await page.request.post('/api/llm/chat', { data: { messages: [{ role: 'user', content: 'x' }], endpoint: 'https://example.com/v1' } });
    expect(bad.status()).toBe(403);
    const empty = await page.request.post('/api/llm/chat', { data: { messages: [] } });
    expect(empty.status()).toBe(400);
  });
});
