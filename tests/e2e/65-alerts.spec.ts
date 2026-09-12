/*
  Alerts (05-TEST-STRATEGY §4.7 SF1-SF4 + UX 04 §5 alert catalogue, adapted to the code).

  Engine: src/lib/sim/alerts.ts (AlertEngine.step: STCA / MSAW / runway incursion / ground conflict / emergency mirror,
  hysteresis `resolveHoldS` = 5 s, ack / resolve), src/lib/sim/engine.ts stepAlerts (the AlertStepCtx the engine hands in).
  UI: src/game/AlertStack (stack cards `toast-{alertId}` with -ack / -select / -locate / -mute / -pair-{cs}, acked pills
  `alert-pill-{id}`, resolved pills `alert-resolved-{id}`, `toast-overflow`, the bell drawer `alerts-drawer` with
  `alerts-row-{id}(-state)` and filters), StripCard (`data-alert`, `data-conflict`, `strip-{cs}-alert`), CommandPanel
  (`panel-alert-banner[data-kind|data-severity]`, `panel-alert-geometry`, `panel-alert-ack`, `panel-alert-pair-{cs}`),
  NavBar (`alerts-bell[data-count]` = unacked non-info, `nav[data-escalated]`).

  Geometry: a head-on pair on the 27L extended centreline 8 NM apart at the same level closes at 440 kt, so the
  3 NM / 1000 ft infringement is predicted ~40 s out (STCA stage 1, warning) and inside 30 s (stage 2, critical) about
  12 s later. Every scenario boots `/play?icao=EGLL&seed=7&spawn=none&test=1`; time moves only through `sim`.
*/
import { test, expect, type SpawnSpec, type SimApi } from './fixtures/test';

const APP = { icao: 'EGLL', spawn: 'none', position: 'approach' } as const;

function inbound(callsign: string, o: { alongNM: number; altFt: number; heading: number; offsetNM?: number; speedKts?: number }): SpawnSpec {
  return {
    callsign, type: 'A320', kind: 'arrival', phase: 'descent',
    posRel: { fromRunway: '27L', alongNM: o.alongNM, offsetNM: o.offsetNM ?? 0, altFt: o.altFt },
    heading: o.heading, speedKts: o.speedKts ?? 220, plan: { runway: '27L' },
  };
}
/** STA1 20 NM out heading east, STA2 28 NM out heading west: 8 NM apart, nose to nose, both level. */
async function headOnPair(sim: SimApi, altB = 5000): Promise<void> {
  await sim.spawnAt(inbound('STA1', { alongNM: -20, altFt: 5000, heading: 90 }));
  await sim.spawnAt(inbound('STA2', { alongNM: -28, altFt: altB, heading: 270 }));
}
async function stcaAlert(sim: SimApi) {
  const al = (await sim.activeAlerts()).find((x) => x.kind === 'stca');
  expect(al, 'an STCA alert is active').toBeTruthy();
  return al!;
}
/** Two departures taxiing out of the same stand: 5 m apart, one rolling -> GROUND CONFLICT (never escalates, never auto-resolves until they part). */
async function groundPair(sim: SimApi): Promise<void> {
  await sim.spawnAt({ callsign: 'GC1', type: 'A320', kind: 'departure', phase: 'taxi', gate: '512', taxiTo: '27R' });
  await sim.spawnAt({ callsign: 'GC2', type: 'A320', kind: 'departure', phase: 'taxi', gate: '512' });
}
const distM = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

test.describe('alerts: STCA', () => {
  test('converging pair: predicted STCA card with the pair, strip tags, panel banner and bell; ACK on the card acknowledges the engine alert @smoke', async ({ openGame, sim }) => {
    const game = await openGame(APP);
    await headOnPair(sim);
    await expect(game.alertStack()).toHaveCount(0);
    await expect(game.alertsBell()).toHaveAttribute('data-count', '0');
    await sim.advance(1);

    // engine: one predicted (stage 1) alert for the pair
    const stca = await sim.stca();
    expect(stca.active).toBe(true);
    expect(stca.pairs.map((p) => [...p].sort())).toEqual([['STA1', 'STA2']]);
    const al = await stcaAlert(sim);
    expect(al.severity).toBe('warning');
    expect(al.predicted).toBe(true);
    expect(al.title).toBe('STCA');
    expect(al.subjects.slice().sort()).toEqual(['STA1', 'STA2']);
    expect(al.subjectIds).toHaveLength(2);
    expect(al.detail).toMatch(/^\d\.\d NM \/ 0 ft, closing \d+ s \(CPA \d\.\d NM\)$/);
    expect(al.geometry.cpaS).toBeGreaterThan(30);
    expect(al.geometry.cpaS).toBeLessThanOrEqual(60);
    expect(al.ack).toBe(false);
    expect((await sim.aircraftOrFail('STA1')).conflict, 'predicted only: no separation loss yet').toBe(false);

    // UI: the stack card (kind, severity, title, geometry, pair chips, actions), the bell, both strips
    await expect(game.stcaAlert()).toBeVisible();
    await expect(game.alertCard(al.id)).toHaveAttribute('data-kind', 'stca');
    await expect(game.alertCard(al.id)).toHaveAttribute('data-severity', 'warning');
    await expect(game.alertItem(al.id)).toHaveAttribute('data-severity', 'warning');
    await expect(game.alertItem(al.id)).toContainText('STCA');
    await expect(game.alertItem(al.id)).toContainText(al.detail);
    await expect(game.alertCardPair(al.id, 'STA1')).toBeVisible();
    await expect(game.alertCardPair(al.id, 'STA2')).toBeVisible();
    await expect(game.alertCardAck(al.id)).toBeVisible();
    await expect(game.alertCardSelect(al.id)).toBeVisible();
    await expect(game.alertCardLocate(al.id)).toBeVisible();
    await expect(game.alertCardMute(al.id), 'mute is a critical-only action').toHaveCount(0);
    await expect(game.alertsBell()).toHaveAttribute('data-count', '1');
    for (const cs of ['STA1', 'STA2']) {
      await expect(game.strip(cs)).toHaveAttribute('data-alert', 'stca');
      await expect(game.strip(cs)).toHaveAttribute('data-conflict', 'true');
      await expect(game.stripAlert(cs)).toHaveText('STCA');
    }

    // UI: the panel banner for one of the pair, its pair button selects the other
    await game.openPanelFor('STA1');
    await expect(game.panelAlertBanner()).toHaveAttribute('data-kind', 'stca');
    await expect(game.panelAlertBanner()).toHaveAttribute('data-severity', 'warning');
    await expect(game.panelAlertBanner()).toContainText('STCA');
    await expect(game.panelAlertGeometry()).toHaveText(al.detail);
    await expect(game.panelAlertAck()).toBeVisible();
    await expect(game.panelAlertPair('STA2')).toBeVisible();
    await expect(game.panelAlertPair('STA1')).toHaveCount(0);
    await game.panelAlertPair('STA2').click();
    await expect(game.panel()).toHaveAttribute('data-callsign', 'STA2');
    await expect(game.strip('STA2')).toHaveAttribute('data-selected', 'true');
    await expect(game.panelAlertPair('STA1')).toBeVisible();

    // ACK on the stack card: engine ack, bell clears at once; the card collapses into the acked pill on the next sim second
    await game.alertCardAck(al.id).click();
    const acked = (await sim.alertById(al.id))!;
    expect(acked.ack).toBe(true);
    expect(acked.ackAt).not.toBeNull();
    expect(acked.resolvedAt, 'acknowledging does not resolve').toBeNull();
    expect((await sim.stca()).active, 'the pair is still converging').toBe(true);
    await expect(game.alertsBell()).toHaveAttribute('data-count', '0');
    await sim.advance(1);                                               // (see the "collapses at once" fixme below)
    await expect(game.alertCard(al.id)).toHaveCount(0);
    await expect(game.alertPill(al.id)).toBeVisible();
    await expect(game.alertPill(al.id)).toContainText('STCA');
    await expect(game.alertPill(al.id)).toContainText(/STA1\/STA2|STA2\/STA1/);
    await expect(game.panelAlertAck()).toHaveCount(0);
    await expect(game.panelAlertBanner()).toContainText(/acknowledged/i);
    for (const cs of ['STA1', 'STA2']) await expect(game.strip(cs)).toHaveAttribute('data-alert', 'stca');
  });

  test('ACK on the stack card collapses it into the acked pill at once (no sim tick needed) @full', async ({ openGame, sim }) => {
    const game = await openGame(APP);
    await headOnPair(sim);
    // a critical card: no wall-clock auto-dismiss can mask the missing re-render (warning cards hide after 12 s anyway)
    await sim.advanceUntilOk("s => window.__atcTest.alerts().some(a => a.kind === 'stca' && a.severity === 'critical')", 40);
    const al = await stcaAlert(sim);
    await game.openPanelFor('STA1');
    await expect(game.panelAlertAck()).toBeVisible();
    await game.alertCardAck(al.id).click();
    expect((await sim.alertById(al.id))?.ack).toBe(true);
    await expect(game.alertsBell()).toHaveAttribute('data-count', '0');
    await expect(game.alertCard(al.id)).toHaveCount(0, { timeout: 2_000 });
    await expect(game.alertPill(al.id)).toBeVisible({ timeout: 2_000 });
    await expect(game.panelAlertAck()).toHaveCount(0, { timeout: 2_000 });
  });

  test('escalation: the warning turns critical inside 30 s, re-arms the acknowledgement, tints the top bar after 10 s and becomes SEPARATION LOSS @full', async ({ openGame, sim }) => {
    const game = await openGame(APP);
    await headOnPair(sim);
    await sim.advance(1);
    const al = await stcaAlert(sim);
    expect(al.severity).toBe('warning');
    expect(await sim.ackAlert(al.id)).toBe(true);
    await sim.advance(1);
    await expect(game.alertPill(al.id)).toBeVisible();
    await expect(game.alertsBell()).toHaveAttribute('data-count', '0');

    // inside 30 s of the infringement: stage 2 (critical), same alert id, ack cleared
    await sim.advanceUntilOk("s => window.__atcTest.alerts().some(a => a.kind === 'stca' && a.resolvedAt == null && a.severity === 'critical')", 40);
    const red = (await sim.alertById(al.id))!;
    expect(red.severity).toBe('critical');
    expect(red.predicted).toBe(true);
    expect(red.ack, 'escalation re-arms the acknowledgement').toBe(false);
    expect(red.ackAt).toBeNull();
    expect(red.geometry.cpaS).toBeLessThanOrEqual(30);
    expect((await sim.activeAlerts()).filter((x) => x.kind === 'stca'), 'still one alert for the pair').toHaveLength(1);
    await expect(game.alertCard(al.id)).toBeVisible();
    await expect(game.alertCard(al.id)).toHaveAttribute('data-severity', 'critical');
    await expect(game.alertItem(al.id)).toHaveAttribute('data-severity', 'critical');
    await expect(game.alertCardMute(al.id)).toBeVisible();
    await expect(game.alertPill(al.id)).toHaveCount(0);
    await expect(game.alertsBell()).toHaveAttribute('data-count', '1');
    await game.openPanelFor('STA2');
    await expect(game.panelAlertBanner()).toHaveAttribute('data-severity', 'critical');
    await expect(game.panelAlertAck()).toBeVisible();

    // unacked critical older than 10 s (counted from the alert's creation, alerts.ts escalated()): the top bar escalates
    expect((await sim.time()) - red.createdAt).toBeGreaterThan(10);
    await expect(game.topBar()).toHaveAttribute('data-escalated', 'true');
    expect(await sim.ackAlert(al.id)).toBe(true);
    await sim.advance(1);
    await expect(game.topBar()).toHaveAttribute('data-escalated', 'false');
    await expect(game.alertPill(al.id)).toBeVisible();

    // actual loss: the same alert becomes SEPARATION LOSS, the engine scores it once, both strips tint
    await sim.advanceUntilOk("s => s.aircraft.some(a => a.conflict)", 60);
    const loss = (await sim.alertById(al.id))!;
    expect(loss.resolvedAt).toBeNull();
    expect(loss.predicted).toBe(false);
    expect(loss.title).toBe('SEPARATION LOSS');
    expect(loss.detail).toMatch(/separation lost/);
    await sim.advance(1);
    await expect(game.alertPill(al.id), 'an actual loss on an already-critical alert keeps the acknowledgement').toBeVisible();
    await game.openAlertsDrawer();
    await expect(game.alertsRow(al.id)).toContainText('SEPARATION LOSS');
    await expect(game.alertsRowState(al.id)).toHaveAttribute('data-state', 'acked');
    await game.closeAlertsDrawer();
    await game.waitRadio(/SEPARATION LOSS: (STA1 \/ STA2|STA2 \/ STA1)/, { who: 'SYS' });
    expect((await sim.scoreEvents()).filter((e) => e.code === 'SEPARATION_LOSS')).toHaveLength(1);
    for (const cs of ['STA1', 'STA2']) await expect(game.strip(cs)).toHaveAttribute('data-conflict', 'true');
    await expect(game.panel()).toHaveAttribute('data-conflict', 'true');
  });

  test('resolution: once the pair is separated the alert resolves after the 5 s hold; card leaves, resolved pill, +5, drawer state, clear resolved @full', async ({ openGame, sim }) => {
    const game = await openGame(APP);
    await headOnPair(sim);
    await sim.advance(1);
    const al = await stcaAlert(sim);
    await sim.clearEvents();

    // 4000 ft apart: the predicted infringement is gone, but the alert holds for resolveHoldS
    await sim.setState('STA2', { altitude: 9000, targetAltitude: 9000, cmdAltitude: 9000 });
    await sim.advance(3);
    expect((await sim.alertById(al.id))?.resolvedAt, 'hysteresis: not resolved after 3 s').toBeNull();
    await expect(game.alertCard(al.id)).toBeVisible();
    await sim.advance(3);
    const done = (await sim.alertById(al.id))!;
    expect(done.resolvedAt).not.toBeNull();
    expect(done.resolvedAt! - done.createdAt).toBeGreaterThanOrEqual(5);
    expect((await sim.stca()).active).toBe(false);
    expect((await sim.activeAlerts())).toHaveLength(0);
    expect((await sim.scoreEvents()).some((e) => e.code === 'STCA_RESOLVED' && e.points === 5), 'a resolved predicted STCA scores +5').toBe(true);

    // UI: card gone, resolved pill (3 s wall clock), success toast, strips clean, bell 0
    await expect(game.alertCard(al.id)).toHaveCount(0);
    await expect(game.alertResolvedPill(al.id)).toBeVisible();
    await expect(game.alertResolvedPill(al.id)).toContainText(/Resolved/);
    await expect(game.toast('success').filter({ hasText: /Resolved · STCA/ })).toBeVisible();
    await expect(game.alertsBell()).toHaveAttribute('data-count', '0');
    for (const cs of ['STA1', 'STA2']) {
      await expect(game.strip(cs)).toHaveAttribute('data-alert', '');
      await expect(game.strip(cs)).toHaveAttribute('data-conflict', 'false');
      await expect(game.stripAlert(cs)).toHaveCount(0);
    }
    await game.openPanelFor('STA1');
    await expect(game.panelAlertBanner()).toHaveCount(0);

    // drawer: the resolved row with its duration and score, then "Clear resolved" empties the session list
    await game.openAlertsDrawer();
    await expect(game.alertsRow(al.id)).toBeVisible();
    await expect(game.alertsRowState(al.id)).toHaveAttribute('data-state', 'resolved');
    await expect(game.alertsRow(al.id)).toContainText('STCA');
    await expect(game.alertsRow(al.id)).toContainText('STA1 · STA2');
    await expect(game.alertsClearResolved()).toBeEnabled();
    await game.alertsClearResolved().click();
    await expect(game.alertsRow(al.id)).toHaveCount(0);
    await expect(game.alertsEmpty()).toBeVisible();
    expect(await sim.alerts()).toHaveLength(0);
    await game.closeAlertsDrawer();
  });

  test('a pair separated by 1100 ft never raises STCA (SF4) @full', async ({ openGame, sim }) => {
    const game = await openGame(APP);
    await headOnPair(sim, 6100);
    await sim.advance(30);
    expect((await sim.stca())).toEqual({ pairs: [], active: false });
    expect(await sim.alerts()).toHaveLength(0);
    expect((await sim.aircraftOrFail('STA1')).conflict).toBe(false);
    await expect(game.alertStack()).toHaveCount(0);
    await expect(game.stcaAlert()).toHaveCount(0);
    await expect(game.alertsBell()).toHaveAttribute('data-count', '0');
    for (const cs of ['STA1', 'STA2']) {
      await expect(game.strip(cs)).toHaveAttribute('data-alert', '');
      await expect(game.strip(cs)).toHaveAttribute('data-conflict', 'false');
    }
    // they pass abeam each other and diverge: still no STCA and no separation loss
    await sim.advance(40);
    const a = await sim.aircraftOrFail('STA1'), b = await sim.aircraftOrFail('STA2');
    expect(distM(a.pos, b.pos) / 1852, 'inside 3 NM laterally while vertically separated').toBeLessThan(3);
    expect((await sim.stca())).toEqual({ pairs: [], active: false });
    expect((await sim.alerts()).filter((x) => x.kind === 'stca')).toHaveLength(0);
    expect(a.conflict || b.conflict).toBe(false);
    expect((await sim.scoreEvents()).filter((e) => e.code === 'SEPARATION_LOSS')).toHaveLength(0);
    await expect(game.stcaAlert()).toHaveCount(0);
  });

  test('a head-on pair passing abeam 1100 ft apart in heading mode raises no WAKE alert @full', async ({ openGame, sim }) => {
    const game = await openGame(APP);
    await headOnPair(sim, 6100);
    await sim.advance(70);
    const a = await sim.aircraftOrFail('STA1'), b = await sim.aircraftOrFail('STA2');
    expect(a.ilsCaptured || b.ilsCaptured).toBe(false);
    expect(a.navMode).toBe('heading');
    expect((await sim.alerts()).filter((x) => x.kind === 'wake')).toHaveLength(0);
    await expect(game.alertStack()).toHaveCount(0);
    await expect(game.alertsBell()).toHaveAttribute('data-count', '0');
  });
});

test.describe('alerts: MSAW, runway incursion, ground conflict', () => {
  test('MSAW: an arrival below the 1500 ft AGL floor more than 5 NM out (not on an approach) raises a critical MSAW alert @full', async ({ openGame, sim }) => {
    const game = await openGame(APP);
    await sim.spawnAt(inbound('MSA1', { alongNM: -14, offsetNM: 5, altFt: 1200, heading: 270, speedKts: 200 }));
    await sim.advance(5);
    const a = await sim.aircraftOrFail('MSA1');
    expect(a.navMode).toBe('heading');
    expect(a.altitude).toBeLessThan(1500);
    const al = (await sim.activeAlerts()).find((x) => x.kind === 'msaw');
    expect(al).toBeTruthy();
    expect(al!.severity).toBe('critical');
    expect(al!.subjects).toEqual(['MSA1']);
    expect(al!.detail).toMatch(/below MSA 1500 ft/);
    await expect(game.alertCard(al!.id)).toHaveAttribute('data-kind', 'msaw');
    await expect(game.strip('MSA1')).toHaveAttribute('data-alert', 'msaw');
    await expect(game.stripAlert('MSA1')).toHaveText('MSAW');
    await expect(game.alertsBell()).toHaveAttribute('data-count', '1');
    // climbing above the floor resolves it after the hold
    await game.sendOk('MSA1 CLIMB 3000');
    await sim.advanceUntilOk("s => (s.aircraft.find(a => a.callsign === 'MSA1')?.altitude ?? 0) > 1600", 120);
    await sim.advance(6);
    expect((await sim.alertById(al!.id))?.resolvedAt).not.toBeNull();
    await expect(game.alertCard(al!.id)).toHaveCount(0);
  });

  test('runway incursion: a lined-up departure with an arrival inside 2 NM raises a critical RUNWAY INCURSION naming both; ACK from the panel banner; resolves when the arrival goes around @smoke', async ({ openGame, sim, browserConsole }) => {
    // The incursion, the NO LANDING CLEARANCE and the go-around advisories on FIN1 resolve in the same tick: AlertStack keys
    // their resolved pills with one Date.now() (AlertStack.tsx:114) — covered by the "distinct resolved pills" fixme below; tolerated here.
    browserConsole.allow(/Encountered two children with the same key/);
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'tower' });
    await sim.spawnAt({ callsign: 'LU1', type: 'A320', kind: 'departure', phase: 'lineup', runway: '27L', onFrequency: 'tower' });
    const nm = 1.6;
    const gsAlt = Math.round(nm * 1852 * Math.tan((3 * Math.PI) / 180) * 3.28084 / 100) * 100;
    await sim.spawnAt({ callsign: 'FIN1', type: 'A320', kind: 'arrival', phase: 'approach', posRel: { fromRunway: '27L', alongNM: -nm, altFt: Math.max(200, gsAlt - 60) }, speedKts: 150, ils: '27L', onFrequency: 'tower' });
    await sim.advance(1);

    // engine: the runway-in-use branch names the occupant and the arrival
    const al = (await sim.activeAlerts()).find((x) => x.kind === 'runway_incursion');
    expect(al, 'runway incursion raised').toBeTruthy();
    expect(al!.severity).toBe('critical');
    expect(al!.title).toBe('RUNWAY INCURSION');
    expect(al!.subjects).toEqual(['LU1', 'FIN1']);
    expect(al!.geometry.runway).toBe('27L');
    expect(al!.detail).toBe('LU1 lined up on runway 27L, FIN1 inside 2 NM');
    expect((await sim.runwayStates()).find((r) => r.name === '27L')?.occupiedBy.map((o) => o.callsign)).toContain('LU1');

    // UI: critical card with both chips, RWY tag on the occupant's strip, bell, panel banner with the pair
    await expect(game.alertCard(al!.id)).toHaveAttribute('data-kind', 'runway_incursion');
    await expect(game.alertCard(al!.id)).toHaveAttribute('data-severity', 'critical');
    await expect(game.alertItem(al!.id)).toContainText('RUNWAY INCURSION');
    await expect(game.alertItem(al!.id)).toContainText(al!.detail);
    await expect(game.alertCardPair(al!.id, 'LU1')).toBeVisible();
    await expect(game.alertCardPair(al!.id, 'FIN1')).toBeVisible();
    await expect(game.alertCardPair(al!.id, 'FIN1')).toContainText('RWY 27L');
    await expect(game.alertCardMute(al!.id)).toBeVisible();
    expect(await game.bellCount()).toBeGreaterThanOrEqual(1);
    await expect(game.strip('LU1')).toHaveAttribute('data-alert', 'runway_incursion');
    await expect(game.strip('LU1')).toHaveAttribute('data-conflict', 'true');
    await expect(game.stripAlert('LU1')).toHaveText('RWY');
    await game.openPanelFor('LU1');
    await expect(game.panelAlertBanner()).toHaveAttribute('data-kind', 'runway_incursion');
    await expect(game.panelAlertBanner()).toHaveAttribute('data-severity', 'critical');
    await expect(game.panelAlertGeometry()).toHaveText(al!.detail);
    await expect(game.panelAlertPair('FIN1')).toBeVisible();

    // ACK from the panel banner
    await game.panelAlertAck().click();
    expect((await sim.alertById(al!.id))?.ack).toBe(true);
    await sim.advance(1);
    await expect(game.panelAlertAck()).toHaveCount(0);
    await expect(game.panelAlertBanner()).toContainText(/acknowledged/i);
    await expect(game.alertCard(al!.id)).toHaveCount(0);
    await expect(game.alertPill(al!.id)).toContainText('RWY LU1/FIN1');

    // the uncleared arrival goes around on its own; once it is no longer inside 2 NM the incursion resolves
    await sim.advanceUntilOk(`s => window.__atcTest.alerts().find(a => a.id === '${al!.id}')?.resolvedAt != null`, 90);
    expect((await sim.aircraftOrFail('FIN1')).goAround).toBe(true);
    await expect(game.strip('LU1')).toHaveAttribute('data-alert', '');
    await expect(game.stripAlert('LU1')).toHaveCount(0);
    await expect(game.alertPill(al!.id)).toHaveCount(0);
    await expect(game.panelAlertBanner()).toHaveCount(0);
    await game.openAlertsDrawer();
    await expect(game.alertsRowState(al!.id)).toHaveAttribute('data-state', 'resolved');
  });

  test('ground conflict: two taxiing aircraft inside 60 m raise a warning GROUND CONFLICT, tint both strips and the panel; it resolves as they part @full', async ({ openGame, sim }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'ground' });
    await groundPair(sim);
    await sim.clearEvents();
    await sim.advance(3);

    const a = await sim.aircraftOrFail('GC1'), b = await sim.aircraftOrFail('GC2');
    expect(a.speed).toBeGreaterThan(1);
    expect(distM(a.pos, b.pos)).toBeLessThan(60);
    const al = (await sim.activeAlerts()).find((x) => x.kind === 'ground_conflict');
    expect(al, 'ground conflict raised').toBeTruthy();
    expect(al!.severity).toBe('warning');
    expect(al!.title).toBe('GROUND CONFLICT');
    expect(al!.subjects.slice().sort()).toEqual(['GC1', 'GC2']);
    expect(al!.detail).toMatch(/^\d+ m/);
    expect(a.conflict && b.conflict, 'the engine separation check flags both').toBe(true);
    // the engine scores the pair once (SF1) and logs it once
    await game.waitRadio(/GROUND CONFLICT: (GC1 \/ GC2|GC2 \/ GC1)/, { who: 'SYS' });
    expect((await sim.scoreEvents()).filter((e) => e.code === 'GROUND_CONFLICT')).toHaveLength(1);
    await sim.advance(5);
    expect((await sim.radio()).filter((l) => l.who === 'SYS' && /GROUND CONFLICT:/.test(l.text)), 'counted once while it persists').toHaveLength(1);
    expect((await sim.activeAlerts()).filter((x) => x.kind === 'ground_conflict')).toHaveLength(1);

    await expect(game.alertCard(al!.id)).toHaveAttribute('data-kind', 'ground_conflict');
    await expect(game.alertCard(al!.id)).toHaveAttribute('data-severity', 'warning');
    await expect(game.alertItem(al!.id)).toContainText('GROUND CONFLICT');
    await expect(game.alertsBell()).toHaveAttribute('data-count', '1');
    for (const cs of ['GC1', 'GC2']) {
      await expect(game.strip(cs)).toHaveAttribute('data-conflict', 'true');
      await expect(game.strip(cs)).toHaveAttribute('data-alert', 'ground_conflict');
      await expect(game.stripAlert(cs)).toBeVisible();
    }
    await game.openPanelFor('GC2');
    await expect(game.panel()).toHaveAttribute('data-conflict', 'true');
    await expect(game.panelAlertBanner()).toHaveAttribute('data-kind', 'ground_conflict');
    await expect(game.panelAlertPair('GC1')).toBeVisible();

    // GC1 drives on: beyond 60 m the condition clears and the alert resolves after the hold
    await sim.advanceUntilOk(`s => window.__atcTest.alerts().find(a => a.id === '${al!.id}')?.resolvedAt != null`, 90);
    const a2 = await sim.aircraftOrFail('GC1'), b2 = await sim.aircraftOrFail('GC2');
    expect(distM(a2.pos, b2.pos)).toBeGreaterThan(60);
    expect((await sim.activeAlerts())).toHaveLength(0);
    await expect(game.alertCard(al!.id)).toHaveCount(0);
    await expect(game.toast('success').filter({ hasText: /Resolved · GROUND CONFLICT/ })).toBeVisible();
    for (const cs of ['GC1', 'GC2']) {
      await expect(game.strip(cs)).toHaveAttribute('data-conflict', 'false');
      await expect(game.strip(cs)).toHaveAttribute('data-alert', '');
    }
    await expect(game.panel()).not.toHaveAttribute('data-conflict', 'true');
    await expect(game.panelAlertBanner()).toHaveCount(0);
  });
});

test.describe('alerts: stack, drawer and acknowledgement', () => {
  test('ordering and styling: critical above warning above info, only non-info on the bell, +N overflow, drawer families and filters @full', async ({ openGame, sim }) => {
    const game = await openGame(APP);
    await sim.spawnAt(inbound('STA3', { alongNM: -14, altFt: 4000, heading: 90 }));
    await sim.spawnAt(inbound('STA4', { alongNM: -22, altFt: 4000, heading: 270 }));
    await sim.forceEmergency('STA3', 'general');                       // critical (emergency)
    await sim.advance(2);                                               // + warning (predicted STCA STA3/STA4)
    await sim.setRunwayStatus('27R', 'closed');                         // + info (runway status advisory)
    await sim.advance(1);
    const alerts = await sim.activeAlerts();
    const em = alerts.find((x) => x.kind === 'emergency')!, st = alerts.find((x) => x.kind === 'stca')!, rw = alerts.find((x) => x.kind === 'runway_status')!;
    expect([em?.severity, st?.severity, rw?.severity]).toEqual(['critical', 'warning', 'info']);
    expect(rw.subjects).toEqual(['09L/27R']);

    // stack order is by severity, then age; every card carries its severity; the bell ignores the advisory
    await expect(game.alertCards()).toHaveCount(3);
    expect(await game.alertCards().evaluateAll((els) => els.map((e) => `${e.getAttribute('data-kind')}:${e.getAttribute('data-severity')}`))).toEqual(['emergency:critical', 'stca:warning', 'runway_status:info']);
    await expect(game.alertItem(em.id)).toHaveAttribute('data-severity', 'critical');
    await expect(game.alertItem(st.id)).toHaveAttribute('data-severity', 'warning');
    await expect(game.alertItem(rw.id)).toHaveAttribute('data-severity', 'info');
    await expect(game.alertCardMute(em.id)).toBeVisible();
    await expect(game.alertCardMute(st.id)).toHaveCount(0);
    await expect(game.alertCardSelect(rw.id), 'an advisory without aircraft has no select / locate').toHaveCount(0);
    await expect(game.alertsBell()).toHaveAttribute('data-count', '2');

    // a fourth unacknowledged alert overflows the 3-card stack into "+1 more", which opens the drawer
    await sim.setRunwayStatus('27L', 'inspection');
    await sim.advance(1);
    await expect(game.alertCards()).toHaveCount(3);
    await expect(game.alertOverflow()).toHaveText('+1 more');
    await game.alertOverflow().click();
    await expect(game.alertsDrawer()).toBeVisible();

    // drawer: every alert grouped by family, active state, filters per severity
    await expect(game.alertsRows()).toHaveCount(4);
    for (const id of [em.id, st.id, rw.id]) await expect(game.alertsRowState(id)).toHaveAttribute('data-state', 'active');
    await expect(game.alertsDrawer()).toContainText('Emergency');
    await expect(game.alertsDrawer()).toContainText('Separation');
    await expect(game.alertsDrawer()).toContainText('Runway');
    await game.alertsFilter('info').click();
    await expect(game.alertsFilter('info')).toHaveAttribute('aria-pressed', 'false');
    await expect(game.alertsRows()).toHaveCount(2);
    await expect(game.alertsRow(rw.id)).toHaveCount(0);
    await game.alertsFilter('critical').click();
    await expect(game.alertsRows()).toHaveCount(1);
    await expect(game.alertsRow(st.id)).toBeVisible();
    await game.alertsFilter('info').click();
    await game.alertsFilter('critical').click();
    await expect(game.alertsRows()).toHaveCount(4);
    await expect(game.alertsClearResolved(), 'nothing resolved yet').toBeDisabled();
    await game.closeAlertsDrawer();
  });

  test('Select cycles through the pair, Locate centres the radar on the subject, a drawer row selects and locates @full', async ({ openGame, sim }) => {
    const game = await openGame(APP);
    await headOnPair(sim);
    await sim.advance(1);
    const al = await stcaAlert(sim);
    expect((await sim.snapshot()).selectedId).toBeNull();

    await game.alertCardSelect(al.id).click();
    await expect(game.panel()).toHaveAttribute('data-callsign', 'STA2');
    await expect(game.strip('STA2')).toHaveAttribute('data-selected', 'true');
    expect((await sim.snapshot()).selectedId).toBe((await sim.aircraftOrFail('STA2')).id);
    await game.alertCardSelect(al.id).click();
    await expect(game.panel()).toHaveAttribute('data-callsign', 'STA1');
    await expect(game.strip('STA1')).toHaveAttribute('data-selected', 'true');

    // move the camera away, then Locate: the radar centres on the current subject
    const cam0 = await sim.camera() as { x: number; y: number; zoom: number };
    await sim.setCamera({ x: cam0.x + 20_000, y: cam0.y + 20_000, zoom: cam0.zoom });
    const sta1 = await sim.aircraftOrFail('STA1');
    expect(distM(await sim.camera() as { x: number; y: number }, sta1.pos)).toBeGreaterThan(10_000);
    await game.alertCardLocate(al.id).click();
    await expect.poll(async () => distM(await sim.camera() as { x: number; y: number }, (await sim.aircraftOrFail('STA1')).pos)).toBeLessThan(300);
    await expect(game.panel()).toHaveAttribute('data-callsign', 'STA1');

    // the drawer row does the same for its first subject
    await sim.select(null);
    await expect(game.shell()).toHaveAttribute('data-has-panel', 'false');
    await sim.setCamera({ x: cam0.x - 20_000, y: cam0.y, zoom: cam0.zoom });
    await game.openAlertsDrawer();
    await game.alertsRow(al.id).click();
    await expect(game.panel()).toHaveAttribute('data-callsign', al.subjects[0]);
    await expect(game.strip(al.subjects[0])).toHaveAttribute('data-selected', 'true');
    await expect.poll(async () => distM(await sim.camera() as { x: number; y: number }, (await sim.aircraftOrFail(al.subjects[0])).pos)).toBeLessThan(300);
  });

  test('acknowledgement persists while the condition continues: same id, acked pill, drawer state, no re-raise @full', async ({ openGame, sim }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'ground' });
    await groundPair(sim);
    await sim.advance(3);
    const al = (await sim.activeAlerts()).find((x) => x.kind === 'ground_conflict')!;
    expect(al).toBeTruthy();
    await game.alertCardAck(al.id).click();
    const t0 = await sim.time();
    expect((await sim.alertById(al.id))?.ack).toBe(true);
    await expect(game.alertsBell()).toHaveAttribute('data-count', '0');

    // 8 s later the pair is still inside 60 m: the same alert, still acknowledged, no duplicate raised
    await sim.advance(8);
    const a = await sim.aircraftOrFail('GC1'), b = await sim.aircraftOrFail('GC2');
    expect(distM(a.pos, b.pos)).toBeLessThan(60);
    const all = await sim.alerts();
    expect(all.filter((x) => x.kind === 'ground_conflict')).toHaveLength(1);
    const same = all.find((x) => x.id === al.id)!;
    expect(same.ack).toBe(true);
    expect(same.ackAt).toBeLessThanOrEqual(t0);
    expect(same.resolvedAt).toBeNull();
    expect(same.updatedAt, 'the geometry keeps updating under the acknowledgement').toBeGreaterThan(al.updatedAt);
    await expect(game.alertCard(al.id)).toHaveCount(0);
    await expect(game.alertPill(al.id)).toBeVisible();
    await expect(game.alertPill(al.id)).toContainText('GND');
    await expect(game.alertsBell()).toHaveAttribute('data-count', '0');
    for (const cs of ['GC1', 'GC2']) await expect(game.strip(cs)).toHaveAttribute('data-conflict', 'true');
    await game.openAlertsDrawer();
    await expect(game.alertsRows()).toHaveCount(1);
    await expect(game.alertsRowState(al.id)).toHaveAttribute('data-state', 'acked');
    await game.closeAlertsDrawer();
    // clicking the acked pill selects the first subject
    await game.alertPill(al.id).click();
    await expect(game.panel()).toHaveAttribute('data-callsign', al.subjects[0]);
  });

  test('critical alert with sound off: no audio errors, Mute 1 min disables itself and leaves the sound setting off @full', async ({ openGame, sim }) => {
    const game = await openGame(APP);
    expect((await sim.storeSettings()).sound, 'the harness seeds sound off').toBe(false);
    await sim.spawnAt(inbound('BAW1', { alongNM: -14, altFt: 4000, heading: 270 }));
    await sim.forceEmergency('BAW1', 'smoke');
    const em = (await sim.activeAlerts()).find((x) => x.kind === 'emergency')!;
    await expect(game.alertCard(em.id)).toHaveAttribute('data-severity', 'critical');
    await expect(game.alertCardMute(em.id)).toHaveText('Mute 1 min');
    await expect(game.alertCardMute(em.id)).toBeEnabled();
    await game.alertCardMute(em.id).click();
    await expect(game.alertCardMute(em.id)).toHaveText('Muted');
    await expect(game.alertCardMute(em.id)).toBeDisabled();
    expect((await sim.storeSettings()).sound).toBe(false);
    // a second critical alert while muted shares the mute
    await headOnPair(sim);
    await sim.advanceUntilOk("s => window.__atcTest.alerts().some(a => a.kind === 'stca' && a.severity === 'critical')", 40);
    const st = await stcaAlert(sim);
    await expect(game.alertCardMute(st.id)).toHaveText('Muted');
    await expect(game.alertCardMute(st.id)).toBeDisabled();
    expect((await sim.storeSettings()).sound).toBe(false);
    // the alert itself stays unacknowledged and on the bell: muting is not acknowledging
    expect((await sim.alertById(em.id))?.ack).toBe(false);
    await expect(game.alertsBell()).toHaveAttribute('data-count', '2');
  });

  test('two alerts resolving in the same tick keep distinct resolved pills (no duplicate React keys) @full', async ({ openGame, sim }) => {
    const game = await openGame(APP);
    await sim.spawnAt(inbound('STA3', { alongNM: -14, altFt: 4000, heading: 90 }));
    await sim.spawnAt(inbound('STA4', { alongNM: -22, altFt: 4000, heading: 270 }));
    await sim.forceEmergency('STA3', 'general');
    await sim.advance(2);
    const em = (await sim.activeAlerts()).find((x) => x.kind === 'emergency')!;
    const st = await stcaAlert(sim);
    await sim.remove('STA3');
    await sim.advance(1);
    expect((await sim.alertById(em.id))?.resolvedAt).not.toBeNull();
    expect((await sim.alertById(st.id))?.resolvedAt).not.toBeNull();
    await expect(game.alertResolvedPill(em.id)).toBeVisible();
    await expect(game.alertResolvedPill(st.id)).toBeVisible();
  });
});
