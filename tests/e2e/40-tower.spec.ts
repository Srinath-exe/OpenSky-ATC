/*
  TOWER position (05-TEST-STRATEGY §4.5 T-series, adapted to the shipped command tree / ids):

    line up (hold -> LUAW, aligned on the runway) · takeoff refused (runway occupied R3 / arrival < 2 NM R4:
    hard block on the confirm step, nothing transmitted) · wake timer running (UX 04 §G3: soft amber,
    pilot answers unable) · cleared for takeoff -> roll -> airborne -> auto handoff + strip moves bays ·
    cancel takeoff (RTO < 80 kt; R5 past abort speed) · landing clearance mandatory (no clearance -> pilot query
    at 4 NM, go-around at 2 NM with the reason logged) · cleared to land -> touchdown -> rollout -> exit picker ->
    vacate -> taxi-in request · go around by click · wind check · runway config dialog (active runways + ATIS
    letter) · runway closed via the ATIS panel -> takeoff refused (R14) · wake timer after a heavy rotates.

  Every test boots `/play?icao=EGLL&seed=7&spawn=none&test=1&position=tower` (no traffic, no RAF) and builds its
  own scenario with `sim.spawnAt`; sim time only moves through `sim.advance*`. Engine state is asserted through
  the test API, visibility through data-testid locators (aria-pressed / data-state / data-value / data-reason).
  Departures spawned at `hold_short` are on the tower frequency and call "ready for departure" 3 s later;
  arrivals spawned with `ils` + `onFrequency: 'tower'` capture the localizer on the first tick.
*/
import { test, expect, expectPhase, type GamePage, type SimApi } from './fixtures/test';
import type { Fixtures } from './fixtures/test';

const ICAO = 'EGLL';
const RWY = '27L';
const RWY_OTHER = '27R';
const MISSED_APPROACH_ALT = 3000;

/** Arrival on the extended centreline `nm` out, ILS armed (captures immediately), tower frequency (tests/engine/helpers.ts spawnOnFinal). */
async function spawnOnFinal(sim: SimApi, callsign: string, nm: number, o: { type?: string; landingCleared?: boolean; speedKts?: number } = {}) {
  const gsAlt = Math.round(nm * 1852 * Math.tan((3 * Math.PI) / 180) * 3.28084 / 100) * 100;
  return sim.spawnAt({
    callsign, type: o.type ?? 'A320', kind: 'arrival', phase: 'approach',
    posRel: { fromRunway: RWY, alongNM: -nm, altFt: Math.max(200, gsAlt - 60) },
    speedKts: o.speedKts ?? 170, ils: RWY, onFrequency: 'tower', landingCleared: o.landingCleared,
  });
}

/** Departure holding short of `runway` (tower frequency, "ready" request after 3 s). */
function spawnAtHold(sim: SimApi, callsign: string, runway = RWY, type = 'A320') {
  return sim.spawnAt({ callsign, type, kind: 'departure', phase: 'hold_short', runway, onFrequency: 'tower' });
}
/** Departure lined up and waiting on `runway`. */
function spawnLinedUp(sim: SimApi, callsign: string, runway = RWY, type = 'A320') {
  return sim.spawnAt({ callsign, type, kind: 'departure', phase: 'lineup', runway, onFrequency: 'tower' });
}

const angleDiff = (a: number, b: number) => { const d = Math.abs((((a - b) % 360) + 540) % 360 - 180); return d; };
const findSrc = (cs: string) => `s.aircraft.find(a => a.callsign === ${JSON.stringify(cs)})`;

/** Count of ATC lines in the unfiltered radio log for `cs` (nothing transmitted == unchanged). */
async function atcLineCount(sim: SimApi, cs: string): Promise<number> {
  return (await sim.radio()).filter((l) => l.who === 'ATC' && l.callsign === cs).length;
}

async function openTower(openGame: Fixtures['openGame']): Promise<GamePage> {
  const game = await openGame({ icao: ICAO, spawn: 'none', position: 'tower' });
  expect(await game.position()).toBe('tower');
  return game;
}

test.describe('tower', () => {
  // ───────────────────────────────────────────────────────────────────────────
  test('line up and wait: the departure taxis onto the runway aligned with it @smoke @full', async ({ openGame, sim }) => {
    const game = await openTower(openGame);
    await spawnAtHold(sim, 'BAW1');
    const hdg = (await sim.runwayStates()).find((r) => r.name === RWY)!.headingTrue;

    // strip in the AT_HOLD bay, panel offers Line up (enabled) with the W box open
    await expect(game.strip('BAW1')).toHaveAttribute('data-bay', 'AT_HOLD');
    await expect(game.strip('BAW1')).toHaveAttribute('data-stage', 'hold_short_dep');
    await game.openPanelFor('BAW1');
    await expect(game.panelStage()).toHaveAttribute('data-stage', 'hold_short_dep');
    expect(await game.actionState('action-lineup')).toEqual({ state: 'enabled', reason: '' });
    await expect(game.page.getByTestId('strip-BAW1-box-W')).toHaveAttribute('aria-pressed', 'false');

    await game.action('action-lineup');
    expect(await game.stepType()).toBe('runway');
    await expect(game.page.getByTestId(`picker-runway-${RWY}`)).toHaveAttribute('aria-pressed', 'true'); // locked default
    await game.next();                                    // optional "behind landing aircraft" step
    expect(await game.stepType()).toBe('aircraft');
    await game.next();
    await expect(game.confirmSummary()).toContainText(/line up and wait/i);
    const tx = await game.transmit();
    expect(tx.status).toBe('ok');
    expect(tx.code).toBe('ok_queued');
    expect(tx.tx).toMatch(/line up and wait/i);
    await game.waitRadio(/line up and wait/i, { who: 'ATC', callsign: 'BAW1' });

    // pilot delay -> readback -> onto the runway
    await sim.advance(3.5);
    await game.waitRadio(/line up|lining up/i, { who: 'PILOT', callsign: 'BAW1' });
    await expectPhase(sim, 'BAW1', 'lineup');
    await expect(game.strip('BAW1')).toHaveAttribute('data-bay', 'LINED_UP');
    await expect(game.page.getByTestId('strip-BAW1-box-W')).toHaveAttribute('aria-pressed', 'true');
    await sim.advanceUntilOk(`s => { const a = ${findSrc('BAW1')}; return !!a && a.phase === 'lineup' && a.speed < 0.5 && a.distAlong >= a.pathTotal - 1; }`, 120);
    const a = await sim.aircraftOrFail('BAW1');
    expect(angleDiff(a.heading, hdg)).toBeLessThanOrEqual(3);
    expect((await sim.runways()).find((r) => r.name === RWY)?.occupied).toBe(true);
    expect((await sim.runwayStates()).find((r) => r.name === RWY)?.occupiedBy.map((o) => o.callsign)).toEqual(['BAW1']);
    await expect(game.panelStage()).toHaveAttribute('data-stage', 'lineup');
    expect(await game.actionState('action-lineup')).toEqual({ state: 'disabled', reason: 'Already cleared' });   // R18
    expect(await game.actionState('action-takeoff')).toEqual({ state: 'enabled', reason: '' });
  });

  // ───────────────────────────────────────────────────────────────────────────
  test('takeoff refused while the runway is occupied (R3): hard block, nothing transmitted @full', async ({ openGame, sim }) => {
    const game = await openTower(openGame);
    await spawnLinedUp(sim, 'OCC1');
    await spawnAtHold(sim, 'BAW2');
    await sim.advance(3.5);                                // BAW2 calls "ready for departure"
    const before = await atcLineCount(sim, 'BAW2');

    await game.openPanelFor('BAW2');
    // §G8: with the runway occupied the "ready" request pre-highlights Line up, not Take off
    await expect(game.reqBand()).toHaveAttribute('data-request', 'ready');
    await expect(game.actionBtn('action-lineup')).toHaveAttribute('data-primary', 'true');
    await game.action('action-takeoff');
    await game.next();
    await expect(game.blockedReason()).toHaveAttribute('data-reason', `Runway ${RWY} occupied by OCC1`);
    await expect(game.page.getByTestId('confirm-transmit')).toHaveCount(0);
    await expect(game.transmitAnyway()).toHaveCount(0);

    // nothing left the panel: no ATC line, no clearance, no pending command
    await sim.advance(1);
    expect(await atcLineCount(sim, 'BAW2')).toBe(before);
    expect((await sim.aircraftOrFail('BAW2')).pendingCmds).toHaveLength(0);
    expect((await sim.runwayStates()).find((r) => r.name === RWY)?.takeoffClearance).toBeNull();
    await expectPhase(sim, 'BAW2', 'hold_short');
    await expect(game.result()).toHaveCount(0);
  });

  // ───────────────────────────────────────────────────────────────────────────
  test('takeoff refused with an arrival inside 2 NM (R4): hard block, nothing transmitted @full', async ({ openGame, sim }) => {
    const game = await openTower(openGame);
    await spawnAtHold(sim, 'BAW3');
    await spawnOnFinal(sim, 'DAL1', 1.5, { landingCleared: true });
    await sim.advance(1);                                  // localizer captured on the first tick
    const arr = await sim.aircraftOrFail('DAL1');
    expect(arr.ilsCaptured).toBe(true);
    const before = await atcLineCount(sim, 'BAW3');

    await game.openPanelFor('BAW3');
    await game.action('action-takeoff');
    await game.next();
    await expect(game.blockedReason()).toHaveAttribute('data-reason', /^Arrival DAL1 1\.\d NM final$/);
    await expect(game.page.getByTestId('confirm-transmit')).toHaveCount(0);
    await expect(game.transmitAnyway()).toHaveCount(0);

    await sim.advance(1);
    expect(await atcLineCount(sim, 'BAW3')).toBe(before);
    expect((await sim.aircraftOrFail('BAW3')).pendingCmds).toHaveLength(0);
    expect((await sim.runwayStates()).find((r) => r.name === RWY)?.takeoffClearance).toBeNull();
    // the engine agrees (typed path, same guard): silent runway_occupied, SYS reason, no ATC line
    const r = await sim.command(`BAW3 CLEARED FOR TAKEOFF ${RWY}`);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('runway_occupied');
    expect(r.transmission).toBe('');
    expect(await atcLineCount(sim, 'BAW3')).toBe(before);
  });

  // ───────────────────────────────────────────────────────────────────────────
  test('takeoff with the wake timer running: amber warning with the countdown, pilot answers unable @full', async ({ openGame, sim }) => {
    const game = await openTower(openGame);
    await spawnLinedUp(sim, 'HVY1', RWY, 'B77W');
    await spawnAtHold(sim, 'BAW4');
    expect((await sim.aircraftOrFail('HVY1')).wakeCategory).toBe('HEAVY');
    expect((await sim.aircraftOrFail('BAW4')).wakeCategory).toBe('MEDIUM');

    // the heavy departs: wake timer starts at rotation (both ends of the runway)
    const t = await sim.command(`HVY1 CLEARED FOR TAKEOFF ${RWY}`);
    expect(t.code).toBe('ok_queued');
    await sim.advanceUntilOk(`s => { const a = ${findSrc('HVY1')}; return !!a && a.altitude > 50; }`, 120);
    const timers = await sim.wakeTimers();
    expect(timers[RWY]?.leader).toBe('HVY1');
    expect(timers[RWY].remainingS).toBeGreaterThan(100);
    await game.waitRadio(new RegExp(`Wake timer runway ${RWY}: HVY1 \\(HEAVY\\) departed`), { who: 'SYS' });
    await sim.advance(10);

    // UX §G3: a running wake timer is a SOFT block — amber TRANSMIT ANYWAY with the countdown
    await game.openPanelFor('BAW4');
    await game.action('action-takeoff');
    await game.next();
    const warnings = await game.confirmWarnings();
    expect(warnings.some((w) => /^Wake turbulence — \d+ s remaining$/.test(w))).toBe(true);
    await expect(game.transmitAnyway()).toBeVisible();
    await expect(game.page.getByTestId('confirm-transmit')).toHaveCount(0);
    const remaining = (await sim.wakeTimers())[RWY].remainingS;
    expect(warnings.find((w) => /^Wake turbulence/.test(w))).toBe(`Wake turbulence — ${remaining} s remaining`);

    // transmitting anyway: the clearance goes out and the pilot refuses it (engine `unable`, 03 §2.7)
    const before = await atcLineCount(sim, 'BAW4');
    const tx = await game.holdTransmitAnyway();
    expect(tx.status).toBe('unable');
    expect(tx.code).toBe('unable');
    await expect(game.page.getByTestId('panel-result-status')).toHaveText(/pilot unable/i);
    expect(await atcLineCount(sim, 'BAW4')).toBe(before + 1);
    await sim.advance(3.5);                                // the "unable" readback lands after the pilot delay
    const rb = await game.waitRadio(/unable/i, { who: 'PILOT', callsign: 'BAW4' });
    expect(rb.status).toBe('unable');
    await expect(game.resultRb()).toContainText(/unable/i);
    await expectPhase(sim, 'BAW4', 'hold_short');
    expect((await sim.aircraftOrFail('BAW4')).takeoffCleared).toBe(false);
    expect((await sim.runwayStates()).find((r) => r.name === RWY)?.takeoffClearance).toBeNull();

    // after the timer expires the same clearance is accepted
    await sim.advance(remaining + 1);
    expect((await sim.wakeTimers())[RWY]).toBeUndefined();
    const ok = await sim.command(`BAW4 CLEARED FOR TAKEOFF ${RWY}`);
    expect(ok.code).toBe('ok_queued');
  });

  // ───────────────────────────────────────────────────────────────────────────
  test('cleared for takeoff: roll, airborne, handoff to departure, strip moves LINED_UP -> ROLLING_AIRBORNE -> off the bay @smoke @full', async ({ openGame, sim }) => {
    const game = await openTower(openGame);
    await spawnLinedUp(sim, 'BAW5');
    await expect(game.strip('BAW5')).toHaveAttribute('data-bay', 'LINED_UP');
    await game.openPanelFor('BAW5');

    await game.action('action-takeoff');
    expect(await game.stepType()).toBe('runway');
    await game.next();
    await expect(game.confirmSummary()).toContainText(/cleared for takeoff/i);
    expect(await game.blockedReasonText()).toBeNull();
    const tx = await game.transmit();
    expect(tx.code).toBe('ok_queued');
    expect(tx.tx).toMatch(/wind .* runway .* cleared for takeoff/i);
    expect((await sim.runwayStates()).find((r) => r.name === RWY)?.takeoffClearance).toBe('BAW5');
    expect((await sim.aircraftOrFail('BAW5')).pendingCmds.map((c) => c.kind)).toEqual(['takeoff']);
    await expect(game.panelPending()).toHaveText(/1 pending/);

    // readback after the pilot delay, then the roll starts (spool-up 8-15 s) and the strip moves bays
    await sim.advance(3.5);
    const rb = await game.waitRadio(/cleared for takeoff/i, { who: 'PILOT', callsign: 'BAW5' });
    expect(rb.status).toBe('executed');
    await expectPhase(sim, 'BAW5', 'takeoff');
    await expect(game.page.getByTestId('strip-BAW5-box-O')).toHaveAttribute('aria-pressed', 'true');
    await expect(game.strip('BAW5')).toHaveAttribute('data-stage', 'takeoff_roll');
    await expect(game.strip('BAW5')).toHaveAttribute('data-bay', 'ROLLING_AIRBORNE');
    await sim.advanceUntilOk(`s => { const a = ${findSrc('BAW5')}; return !!a && a.takeoffCleared && a.speed > 40; }`, 60);
    await game.waitRadio(/rolling runway/i, { who: 'PILOT', callsign: 'BAW5' });

    // airborne: PILOT "airborne" line, wake timer not set for a MEDIUM leader, runway free again
    await sim.advanceUntilOk(`s => { const a = ${findSrc('BAW5')}; return !!a && a.altitude > 50; }`, 90);
    await expect(game.strip('BAW5')).toHaveAttribute('data-stage', 'takeoff_air');
    await expect(game.strip('BAW5')).toHaveAttribute('data-bay', 'ROLLING_AIRBORNE');
    expect((await sim.events()).some((e) => e.type === 'airborne' && e.callsign === 'BAW5')).toBe(true);
    expect((await sim.runways()).find((r) => r.name === RWY)?.occupied).toBe(false);
    await expect(game.stripAlt('BAW5')).toHaveAttribute('data-value', /^\d+$/);

    // auto handoff to departure at 3000 ft (clearance.autoHandoffAlt): handoff event, off the tower bay
    await sim.advanceUntilOk(`s => { const a = ${findSrc('BAW5')}; return !!a && a.onFrequency === 'departure'; }`, 400);
    const ho = (await sim.events()).find((e) => e.type === 'handoff' && e.callsign === 'BAW5');
    expect(ho?.data).toMatchObject({ type: 'handoff', from: 'tower', to: 'departure' });
    expect(ho?.message).toMatch(/^BAW5 contact Heathrow Departure/);
    // the line is stamped with the NEW frequency, so the TWR-filtered log hides it until ALL is selected
    expect((await sim.radio()).some((l) => l.who === 'SYS' && l.callsign === 'BAW5' && /contact Heathrow Departure/.test(l.text))).toBe(true);
    expect((await game.radioRows()).some((l) => /contact Heathrow Departure/.test(l.text))).toBe(false);
    await game.showAllFrequencies();
    await game.waitRadio(/BAW5 contact Heathrow Departure/, { who: 'SYS', callsign: 'BAW5' });
    const a = await sim.aircraftOrFail('BAW5');
    expect(a.altitude).toBeGreaterThanOrEqual(2900);
    expect(['climb', 'cruise']).toContain(a.phase);
    await expect(game.strip('BAW5')).toHaveCount(0);
    await expect(game.page.getByTestId('strip-BAW5-box-F')).toHaveCount(0);
    // the strip lives on the APPROACH tab now (CLIMB_OUT), with the F box ticked
    await game.setPosition('approach');
    await expect(game.strip('BAW5')).toHaveAttribute('data-bay', 'CLIMB_OUT');
    await expect(game.page.getByTestId('strip-BAW5-box-F')).toHaveAttribute('aria-pressed', 'true');
  });

  // ───────────────────────────────────────────────────────────────────────────
  test('cancel takeoff below 80 kt is a rejected takeoff; past 80 kt the action is disabled (R5) @full', async ({ openGame, sim }) => {
    const game = await openTower(openGame);
    await spawnLinedUp(sim, 'BAW6', RWY);
    await spawnLinedUp(sim, 'BAW7', RWY_OTHER);
    expect((await sim.command(`BAW6 CLEARED FOR TAKEOFF ${RWY}`)).code).toBe('ok_queued');
    expect((await sim.command(`BAW7 CLEARED FOR TAKEOFF ${RWY_OTHER}`)).code).toBe('ok_queued');

    // BAW6 rolling at 30-79 kt: Cancel takeoff enabled -> "stop immediately", RTO, back to the line-up
    await sim.advanceUntilOk(`s => { const a = ${findSrc('BAW6')}; return !!a && a.phase === 'takeoff' && a.takeoffCleared && a.speed >= 30; }`, 60, 0.25);
    const rolling = await sim.aircraftOrFail('BAW6');
    expect(rolling.speed).toBeLessThan(80);
    await game.openPanelFor('BAW6');
    await expect(game.panelStage()).toHaveAttribute('data-stage', 'takeoff_roll');
    expect(await game.actionState('action-cancel-takeoff')).toEqual({ state: 'enabled', reason: '' });
    expect(await game.actionState('action-takeoff')).toEqual({ state: 'disabled', reason: 'Already cleared' });
    await game.action('action-cancel-takeoff');
    expect(await game.stepType()).toBe('confirm');
    const tx = await game.transmit();
    expect(tx.status).toBe('ok');
    expect(tx.tx).toMatch(/stop immediately/i);
    const rto = await sim.state('BAW6');
    expect(rto?.rto).not.toBeNull();
    expect(rto?.rto?.speedKt).toBeLessThan(80);
    expect((await sim.runwayStates()).find((r) => r.name === RWY)?.takeoffClearance).toBeNull();
    await game.waitRadio(/rejected takeoff at \d+ kt/i, { who: 'SYS', callsign: 'BAW6' });
    expect((await sim.radio()).some((l) => /high speed/i.test(l.text) && l.callsign === 'BAW6')).toBe(false);
    await sim.advanceUntilOk(`s => { const a = ${findSrc('BAW6')}; return !!a && a.phase === 'lineup' && a.speed < 0.3; }`, 60);
    await expect(game.strip('BAW6')).toHaveAttribute('data-stage', 'lineup');
    expect((await sim.aircraftOrFail('BAW6')).takeoffCleared).toBe(false);
    expect((await sim.runwayStates()).find((r) => r.name === RWY)?.status).toBe('open');   // low-speed RTO: no inspection
    await game.waitRadio(/stopped on runway/i, { who: 'SYS', callsign: 'BAW6' });

    // BAW7 past 80 kt: R5
    await sim.advanceUntilOk(`s => { const a = ${findSrc('BAW7')}; return !!a && a.phase === 'takeoff' && a.speed >= 85 && a.altitude < 50; }`, 60, 0.25);
    await game.openPanelFor('BAW7');
    expect(await game.actionState('action-cancel-takeoff')).toEqual({ state: 'disabled', reason: 'Past abort speed' });
    await expect(game.actionBtn('action-cancel-takeoff')).toBeDisabled();
  });

  // ───────────────────────────────────────────────────────────────────────────
  test('landing clearance is mandatory: pilot queries at 4 NM, goes around at 2 NM with the reason in the log @full', async ({ openGame, sim }) => {
    const game = await openTower(openGame);
    await spawnOnFinal(sim, 'DAL5', 6);
    await sim.advance(1);
    const a0 = await sim.aircraftOrFail('DAL5');
    expect(a0.ilsCaptured).toBe(true);
    expect(a0.landingCleared).toBe(false);
    await expect(game.strip('DAL5')).toHaveAttribute('data-bay', 'FINAL');
    await expect(game.page.getByTestId('strip-DAL5-box-L')).toHaveAttribute('aria-pressed', 'false');

    // 4 NM: "confirm cleared to land?" request, REQ chip on the strip, Land pre-highlighted in the panel
    await sim.advanceUntilOk(`s => { const a = ${findSrc('DAL5')}; return !!a && a.requests.some(r => r.kind === 'confirm_cleared'); }`, 120);
    await expect(game.stripReq('DAL5')).toHaveAttribute('data-kind', 'confirm_cleared');
    await game.waitRadio(/confirm.*cleared to land|cleared to land\?/i, { who: 'PILOT', callsign: 'DAL5' });
    await game.openPanelFor('DAL5');
    await expect(game.reqBand()).toHaveAttribute('data-request', 'confirm_cleared');
    await expect(game.actionBtn('action-land')).toHaveAttribute('data-primary', 'true');
    await game.closePanel();

    // 2 NM without clearance: forced go-around, reason "no landing clearance"
    const ga = await sim.advanceUntil(`s => ${findSrc('DAL5')}?.phase === 'go_around'`, 120, 0.25);
    expect(ga.ok).toBe(true);
    const ev = (await sim.events()).find((e) => e.type === 'go_around' && e.callsign === 'DAL5');
    expect(ev?.message).toMatch(/going around — no landing clearance/);
    const line = await game.waitRadio(/going around — no landing clearance/, { who: 'PILOT', callsign: 'DAL5' });
    expect(line.text).toContain('DAL5');
    const a = await sim.aircraftOrFail('DAL5');
    expect(a.goAround).toBe(true);
    expect(a.stage).toBe('go_around');
    expect(a.ilsCaptured).toBe(false);
    expect(a.landingCleared).toBe(false);
    expect(a.targetAltitude).toBe(MISSED_APPROACH_ALT);
    expect(a.navMode).toBe('heading');
    await expect(game.strip('DAL5')).toHaveAttribute('data-stage', 'go_around');
    // scored against the player (GA_UNHANDLED) and the toast says so
    expect((await sim.events()).some((e) => e.type === 'score' && e.data?.type === 'score' && e.data.score.code === 'GA_UNHANDLED')).toBe(true);
    expect((await sim.alerts()).some((al) => al.kind === 'go_around' && al.subjects.includes('DAL5'))).toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────────────
  test('cleared to land -> exit picker on final -> touchdown -> rollout -> vacate -> taxi-in request @smoke @full', async ({ openGame, sim }) => {
    const game = await openTower(openGame);
    await spawnOnFinal(sim, 'DAL6', 7);
    await sim.advance(1);
    await game.openPanelFor('DAL6');
    await expect(game.panelStage()).toHaveAttribute('data-stage', 'arr_final');
    expect(await game.actionState('action-land')).toEqual({ state: 'enabled', reason: '' });

    // cleared to land (runway locked to the assigned one)
    await game.action('action-land');
    expect(await game.stepType()).toBe('runway');
    await expect(game.page.getByTestId(`picker-runway-${RWY}`)).toHaveAttribute('aria-pressed', 'true');
    await game.next();
    await expect(game.confirmSummary()).toContainText(/cleared to land/i);
    const tx = await game.transmit();
    expect(tx.code).toBe('ok_queued');
    expect(tx.tx).toMatch(/wind .* cleared to land/i);
    await sim.advance(3.5);
    const rb = await game.waitRadio(/cleared to land/i, { who: 'PILOT', callsign: 'DAL6' });
    expect(rb.status).toBe('executed');
    const cleared = await sim.aircraftOrFail('DAL6');
    expect(cleared.landingCleared).toBe(true);
    expect((await sim.runwayStates()).find((r) => r.name === RWY)?.landingClearances).toEqual(['DAL6']);
    await expect(game.page.getByTestId('strip-DAL6-box-L')).toHaveAttribute('aria-pressed', 'true');
    // a repeated clearance is refused by the engine (silent `already`), nothing transmitted
    const again = await sim.command(`DAL6 CLEARED TO LAND ${RWY}`);
    expect(again.code).toBe('already');
    expect(again.transmission).toBe('');

    // exit picker on final (UX §1.4 "Exit at / next available exit L/R"): "next exit right" = the north side of 27L
    await sim.advanceUntilPhase('DAL6', 'landing', 120);
    await expect(game.panelStage()).toHaveAttribute('data-stage', 'arr_final');
    expect(await game.actionState('action-exit')).toEqual({ state: 'enabled', reason: '' });
    await game.action('action-exit');
    expect(await game.stepType()).toBe('taxiway');
    await expect(game.page.getByTestId('picker-exit-next-left')).toBeVisible();
    await game.page.getByTestId('picker-exit-next-right').click();
    await expect(game.page.getByTestId('picker-exit-next-right')).toHaveAttribute('aria-pressed', 'true');
    await game.next();
    expect(await game.stepType()).toBe('text');
    await game.next();
    await expect(game.confirmSummary()).toContainText(/next available exit on the right/i);
    const ex = await game.transmit();
    expect(ex.status).toBe('ok');
    expect(ex.tx).toMatch(/take the next available exit on the right/i);
    await sim.advance(3.5);
    const exRb = await game.waitRadio(/next available right/i, { who: 'PILOT', callsign: 'DAL6' });
    expect(exRb.status).toBe('executed');
    expect((await sim.state('DAL6'))?.exitDir).toBe('R');
    await expect(game.panelPending()).toHaveCount(0);

    // touchdown -> rollout (runway occupied), clearance consumed, decelerating
    await sim.advanceUntilPhase('DAL6', 'rollout', 300);
    expect((await sim.events()).some((e) => e.type === 'touchdown' && e.callsign === 'DAL6')).toBe(true);
    await game.waitRadio(new RegExp(`touchdown runway ${RWY}`), { who: 'PILOT', callsign: 'DAL6' });
    await expect(game.strip('DAL6')).toHaveAttribute('data-bay', 'LANDED_ROLLOUT');
    await expect(game.panelStage()).toHaveAttribute('data-stage', 'rollout');
    expect((await sim.runways()).find((r) => r.name === RWY)?.occupied).toBe(true);
    expect((await sim.runwayStates()).find((r) => r.name === RWY)?.occupiedBy.map((o) => o.kind)).toEqual(['rollout']);
    expect((await sim.aircraftOrFail('DAL6')).landingCleared).toBe(false);
    expect((await sim.runwayStates()).find((r) => r.name === RWY)?.landingClearances).toEqual([]);
    const v0 = (await sim.aircraftOrFail('DAL6')).speed;
    await sim.advanceUntilOk(`s => { const a = ${findSrc('DAL6')}; return !!a && a.phase === 'rollout' && a.speed < ${v0} - 20; }`, 60);
    expect(await game.actionState('action-land')).toEqual({ state: 'disabled', reason: 'Already cleared' });     // R18 at rollout
    expect(await game.actionState('action-goaround')).toEqual({ state: 'disabled', reason: 'On the ground' });    // R17

    // vacates on the right-hand (N) side: PILOT "exiting via N..", "runway vacated", LANDED scored, runway free
    await sim.advanceUntilOk(`s => s.radio.some(l => l.callsign === 'DAL6' && /runway ${RWY} vacated/.test(l.text))`, 200);
    const exiting = await game.waitRadio(/exiting via (N\w+)/, { who: 'PILOT', callsign: 'DAL6' });
    expect(exiting.text).toMatch(/exiting via N/);
    await game.waitRadio(new RegExp(`runway ${RWY} vacated`), { who: 'PILOT', callsign: 'DAL6' });
    expect((await sim.runways()).find((r) => r.name === RWY)?.occupied).toBe(false);
    expect((await sim.events()).some((e) => e.type === 'score' && e.data?.type === 'score' && e.data.score.code === 'LANDED' && e.data.score.primary === 'DAL6')).toBe(true);
    await expect(game.score()).toHaveAttribute('data-value', /^[1-9]\d*$/);

    // taxi-in request once stopped clear of the runway (on ground frequency), strip in TO_GROUND with the REQ chip
    await sim.advanceUntilOk(`s => { const a = ${findSrc('DAL6')}; return !!a && a.requests.some(r => r.kind === 'taxi_in'); }`, 120);
    const a = await sim.aircraftOrFail('DAL6');
    expect(a.phase).toBe('taxi');
    expect(a.stage).toBe('taxi_in');
    expect(a.onFrequency).toBe('ground');
    expect(a.speed).toBeLessThan(0.5);
    // the request is made on the ground frequency: hidden by the TWR filter, visible under ALL
    expect((await game.radioRows()).some((l) => /runway vacated, request taxi/.test(l.text))).toBe(false);
    await game.showAllFrequencies();
    await game.waitRadio(/Heathrow Ground, .*runway vacated, request taxi/i, { who: 'PILOT', callsign: 'DAL6' });
    await expect(game.strip('DAL6')).toHaveAttribute('data-bay', 'TO_GROUND');
    await expect(game.stripReq('DAL6')).toHaveAttribute('data-kind', 'taxi_in');
    await expect(game.page.getByTestId('strip-DAL6-box-E')).toHaveAttribute('aria-pressed', 'true');
    await expect(game.page.getByTestId('strip-DAL6-box-F')).toHaveAttribute('aria-pressed', 'true');
  });

  test.fixme('exit picker during the rollout: "next exit right" makes the aircraft vacate @full', async ({ openGame, sim }) => {
    // BUG (engine): an exit instruction given DURING the rollout never vacates. src/lib/sim/engine.ts execExitAt
    // (~1947-1951) replaces `scratch.exitPlan` with chooseExit(...) but leaves `a.path.holdAt` / `a.cmdIas` at the
    // touchdown plan's values (onTouchdown ~3092-3095 sets both), so a 90-degree exit chosen for "next exit L/R"
    // (exit speed 15 kt) is passed at the old 30 kt target; the aircraft rolls to the end of the runway and sits
    // there in `rollout` at 30 kt forever (never < 0.3 kt, so no "stopped on the runway" request either).
    // Related: cmdExitAt (~1932-1935) re-checks reachability with the current speed and the 40 m margin, which
    // refuses the pilot's OWN just-in-time exit: "VACATE VIA N10" -> unable_exit "Unable N10, we'll take N10".
    const game = await openTower(openGame);
    await spawnOnFinal(sim, 'DAL9', 7, { landingCleared: true });
    await sim.advanceUntilPhase('DAL9', 'rollout', 300);
    const v0 = (await sim.aircraftOrFail('DAL9')).speed;
    await sim.advanceUntilOk(`s => { const a = ${findSrc('DAL9')}; return !!a && a.phase === 'rollout' && a.speed < ${v0} - 20; }`, 60);
    await game.openPanelFor('DAL9');
    await game.action('action-exit');
    await game.page.getByTestId('picker-exit-next-right').click();
    await game.next();
    await game.next();
    const ex = await game.transmit();
    expect(ex.status).toBe('ok');
    await sim.advance(3.5);
    expect((await sim.state('DAL9'))?.exitDir).toBe('R');
    await sim.advanceUntilOk(`s => s.radio.some(l => l.callsign === 'DAL9' && /runway ${RWY} vacated/.test(l.text))`, 150);
    expect((await sim.runways()).find((r) => r.name === RWY)?.occupied).toBe(false);
    await sim.advanceUntilOk(`s => { const a = ${findSrc('DAL9')}; return !!a && a.requests.some(r => r.kind === 'taxi_in'); }`, 120);
  });


  // ───────────────────────────────────────────────────────────────────────────
  test('go around by click: TOGA to the missed-approach altitude, ILS and landing clearance dropped @smoke @full', async ({ openGame, sim }) => {
    const game = await openTower(openGame);
    await spawnOnFinal(sim, 'DAL7', 5, { landingCleared: true });
    await sim.advance(1);
    await game.openPanelFor('DAL7');
    await expect(game.panelStage()).toHaveAttribute('data-stage', 'arr_final');
    expect(await game.actionState('action-goaround')).toEqual({ state: 'enabled', reason: '' });

    await game.action('action-goaround');
    expect(await game.stepType()).toBe('confirm');
    await expect(game.confirmSummary()).toContainText(/go around/i);
    const tx = await game.transmit();
    expect(tx.status).toBe('ok');
    expect(tx.code).toBe('ok_queued');
    expect(tx.tx).toMatch(/go around, I say again, go around/i);
    // no pilot delay: applyAt == now, executes on the next substep
    expect((await sim.aircraftOrFail('DAL7')).pendingCmds[0]?.applyAt).toBeCloseTo(await sim.time(), 2);
    await sim.advance(0.1);

    const a = await sim.aircraftOrFail('DAL7');
    expect(a.phase).toBe('go_around');
    expect(a.goAround).toBe(true);
    expect(a.stage).toBe('go_around');
    expect(a.ilsCaptured).toBe(false);
    expect(a.ilsArmed).toBe(false);
    expect(a.landingCleared).toBe(false);
    expect(a.targetAltitude).toBe(MISSED_APPROACH_ALT);
    expect(a.cmdAltitude).toBe(MISSED_APPROACH_ALT);
    expect((await sim.runwayStates()).find((r) => r.name === RWY)?.landingClearances).toEqual([]);
    await expect(game.strip('DAL7')).toHaveAttribute('data-stage', 'go_around');
    await expect(game.strip('DAL7')).toHaveAttribute('data-bay', 'FINAL');
    await expect(game.panelStage()).toHaveAttribute('data-stage', 'go_around');
    expect(await game.actionState('action-goaround')).toEqual({ state: 'disabled', reason: 'Already cleared' });
    expect(await game.actionState('action-land')).toEqual({ state: 'disabled', reason: 'Not positioned — vector first' });
    await game.waitRadio(/going around/i, { who: 'PILOT', callsign: 'DAL7' });
    expect((await sim.events()).some((e) => e.type === 'go_around' && e.callsign === 'DAL7' && /ATC instruction/.test(e.message))).toBe(true);

    // climbs on runway heading; handed back to approach near 3000 ft and leaves the tower bay
    const before = a.altitude;
    await sim.advance(30);
    const up = await sim.aircraftOrFail('DAL7');
    expect(up.altitude).toBeGreaterThan(before + 500);
    await expect(game.metricTarget('alt')).toHaveAttribute('data-value', String(MISSED_APPROACH_ALT));
    await sim.advanceUntilOk(`s => ${findSrc('DAL7')}?.onFrequency === 'approach'`, 300);
    await expect(game.strip('DAL7')).toHaveCount(0);
  });

  // ───────────────────────────────────────────────────────────────────────────
  test('wind check: transmits the current wind, immediate result, nav chip agrees @full', async ({ openGame, sim }) => {
    const game = await openTower(openGame);
    await sim.setWind(250, 12);
    await spawnAtHold(sim, 'BAW8');
    await game.openPanelFor('BAW8');
    expect(await game.actionState('action-wind-check')).toEqual({ state: 'enabled', reason: '' });
    await game.action('action-wind-check');
    expect(await game.stepType()).toBe('confirm');
    await expect(game.confirmSummary()).toContainText(/wind/i);
    const tx = await game.transmit();
    expect(tx.status).toBe('ok');
    expect(tx.code).toBe('ok');
    expect(tx.tx).toMatch(/wind .+ degrees .+ knots/i);
    expect(tx.tx).toMatch(/one two knots/i);
    const line = await game.waitRadio(/wind .+ degrees .+ knots/i, { who: 'ATC', callsign: 'BAW8' });
    expect(line.status).toBe('executed');
    await expect(game.wind()).toHaveText(/^\d{3}\/12/);
    const atis = await sim.atis();
    expect(atis.wind.kts).toBe(12);
    await expect(game.wind()).toHaveText(`${String(Math.round(atis.wind.dir)).padStart(3, '0')}/12`);
  });

  // ───────────────────────────────────────────────────────────────────────────
  test('runway config dialog changes the active runways and advances the ATIS letter @full', async ({ openGame, sim }) => {
    const game = await openTower(openGame);
    const before = await sim.atis();
    await expect(game.atisChip()).toContainText(`ATIS ${before.letter}`);
    const wasDep = (await sim.runwayStates()).filter((r) => r.activeDep).map((r) => r.name).sort();
    expect(wasDep).toContain(RWY);

    await game.openRunwayConfig();
    await expect(game.rwycfgEnd(RWY, 'dep')).toHaveAttribute('aria-pressed', 'true');
    await expect(game.rwycfgEnd(RWY, 'arr')).toHaveAttribute('aria-pressed', 'true');
    // §G4 guard: no departure runway at all blocks Apply
    for (const r of wasDep) await game.rwycfgEnd(r, 'dep').click();
    await expect(game.rwycfgBlockedReason()).toHaveText(/at least one departure runway/i);
    await expect(game.rwycfgApply()).toBeDisabled();
    await game.rwycfgEnd(RWY_OTHER, 'dep').click();
    await expect(game.rwycfgEnd(RWY_OTHER, 'dep')).toHaveAttribute('aria-pressed', 'true');
    await expect(game.rwycfgBlockedReason()).toHaveCount(0);
    await expect(game.rwycfgApply()).toBeEnabled();
    await game.rwycfgApply().click();
    await expect(game.runwayConfigDialog()).toHaveCount(0);

    // engine: 27R the only departure runway, arrivals unchanged; ATIS letter +1 and re-broadcast in the log
    const after = (await sim.runwayStates());
    expect(after.filter((r) => r.activeDep).map((r) => r.name)).toEqual([RWY_OTHER]);
    expect(after.find((r) => r.name === RWY)?.activeArr).toBe(true);
    const atis = await sim.atis();
    expect(atis.letter).toBe(String.fromCharCode(before.letter.charCodeAt(0) + 1));
    expect(atis.activeRunways).toContain(RWY_OTHER);
    await expect(game.atisChip()).toContainText(`ATIS ${atis.letter}`);
    await game.waitRadio(new RegExp(`Runway change: departures ${RWY_OTHER}`), { who: 'SYS' });
    await sim.advance(1);                                  // the weather model queues the ATIS event for the next step
    await game.waitRadio(new RegExp(`ATIS ${atis.letter} — runway change`), { who: 'SYS' });
    await game.openAtis();
    await expect(game.atisLetter()).toContainText(`Information ${atis.letter}`);
    await expect(game.atisDep(RWY_OTHER)).toBeVisible();
    await expect(game.atisDep(RWY)).toHaveCount(0);
    await expect(game.atisArr(RWY)).toBeVisible();
    await game.closeAtis();

    // a departure planned for 27L now gets the R22 soft warning on its takeoff clearance (27L not active for dep)
    await spawnAtHold(sim, 'BAW9', RWY);
    await game.openPanelFor('BAW9');
    await game.action('action-takeoff');
    await game.next();
    expect(await game.confirmWarnings()).toContain(`Runway ${RWY} not active for dep`);
    await expect(game.transmitAnyway()).toBeVisible();
  });

  // ───────────────────────────────────────────────────────────────────────────
  test('runway closed from the ATIS panel: takeoff refused with R14, ATIS remark, runway reopens @full', async ({ openGame, sim }) => {
    const game = await openTower(openGame);
    await spawnAtHold(sim, 'BAW10', RWY);
    const letter0 = (await sim.atis()).letter;

    await game.setRunwayStatusViaAtis(RWY, 'close');
    const closed = await sim.runwayStates();
    expect(closed.find((r) => r.name === RWY)?.status).toBe('closed');
    expect(closed.find((r) => r.name === '09R')?.status).toBe('closed');     // both ends of the physical runway
    expect(closed.find((r) => r.name === RWY_OTHER)?.status).toBe('open');
    await game.waitRadio(/Runway 09R\/27L closed/, { who: 'SYS' });
    expect((await sim.atis()).letter).toBe(String.fromCharCode(letter0.charCodeAt(0) + 1));
    expect((await sim.alerts()).some((al) => al.kind === 'runway_status' && al.subjects.includes('09R/27L'))).toBe(true);
    await game.closeAtis();

    // the departure holding at 27L: the runway chip is disabled with R14 and the confirm step is hard-blocked
    const before = await atcLineCount(sim, 'BAW10');
    await game.openPanelFor('BAW10');
    await game.action('action-takeoff');
    await expect(game.page.getByTestId(`picker-runway-${RWY}`)).toHaveAttribute('data-state', 'disabled');
    await expect(game.page.getByTestId(`picker-runway-${RWY}`)).toHaveAttribute('data-reason', `Runway ${RWY} closed`);
    await game.next();
    await expect(game.blockedReason()).toHaveAttribute('data-reason', `Runway ${RWY} closed`);
    await expect(game.page.getByTestId('confirm-transmit')).toHaveCount(0);
    await expect(game.transmitAnyway()).toHaveCount(0);
    expect(await atcLineCount(sim, 'BAW10')).toBe(before);
    // typed path: silent runway_closed
    const r = await sim.command(`BAW10 CLEARED FOR TAKEOFF ${RWY}`);
    expect(r.code).toBe('runway_closed');
    expect(r.transmission).toBe('');
    await expectPhase(sim, 'BAW10', 'hold_short');
    await game.cancel();

    // reopen: chip back to open, alert resolved, takeoff allowed again
    await game.setRunwayStatusViaAtis(RWY, 'open');
    expect((await sim.runwayStates()).find((r) => r.name === RWY)?.status).toBe('open');
    await game.closeAtis();
    await game.action('action-takeoff');
    await expect(game.page.getByTestId(`picker-runway-${RWY}`)).toHaveAttribute('data-state', 'enabled');
    await game.next();
    expect(await game.blockedReasonText()).toBeNull();
    await expect(game.page.getByTestId('confirm-transmit')).toHaveAttribute('data-state', 'enabled');
  });

  // ───────────────────────────────────────────────────────────────────────────
  test('wake timer after a heavy rotates: engine timer + SYS line + follower countdown warning @full', async ({ openGame, sim }) => {
    const game = await openTower(openGame);
    await spawnLinedUp(sim, 'HVY2', RWY, 'B77W');
    await spawnAtHold(sim, 'BAW11', RWY);
    expect(await sim.wakeTimers()).toEqual({});
    expect((await sim.command(`HVY2 CLEARED FOR TAKEOFF ${RWY}`)).code).toBe('ok_queued');
    await sim.advanceUntilOk(`s => { const a = ${findSrc('HVY2')}; return !!a && a.altitude > 50; }`, 120);

    const timers = await sim.wakeTimers();
    expect(timers[RWY]).toMatchObject({ runway: RWY, leader: 'HVY2' });
    expect(timers[RWY].remainingS).toBeGreaterThan(110);
    expect(timers[RWY].remainingS).toBeLessThanOrEqual(120);
    expect(timers['09R']?.leader).toBe('HVY2');
    const wake = (await sim.events()).find((e) => e.type === 'wake');
    expect(wake?.data).toMatchObject({ type: 'wake', runway: RWY, leader: 'HVY2' });
    await game.waitRadio(new RegExp(`Wake timer runway ${RWY}: HVY2 \\(HEAVY\\) departed, 120 s`), { who: 'SYS' });

    // counts down with sim time and clears
    await sim.advance(30);
    const later = (await sim.wakeTimers())[RWY].remainingS;
    expect(later).toBeGreaterThanOrEqual(timers[RWY].remainingS - 31);
    expect(later).toBeLessThanOrEqual(timers[RWY].remainingS - 29);
    await game.openPanelFor('BAW11');
    await game.action('action-takeoff');
    await game.next();
    expect(await game.confirmWarnings()).toContain(`Wake turbulence — ${(await sim.wakeTimers())[RWY].remainingS} s remaining`);
    await game.cancel();
    await sim.advance(later + 1);
    expect((await sim.wakeTimers())[RWY]).toBeUndefined();
    await game.action('action-takeoff');
    await game.next();
    expect((await game.confirmWarnings()).some((w) => /Wake turbulence/.test(w))).toBe(false);
  });

  test.fixme('strip E box ticks after a "next exit left/right" instruction @full', async ({ openGame, sim }) => {
    // BUG: src/game/StripBay/StripCard.tsx:38 ARR_BOXES "E" (UX 04 §3.1 "E exit given") is `done` only when
    // `a.exitTaxiway != null`; a directional exit ("take the next available exit on the right", `a.exitDir = 'R'`,
    // engine execExitAt) leaves the box unticked although the exit instruction was given and read back.
    const game = await openTower(openGame);
    await sim.spawnAt({ callsign: 'DAL8', type: 'A320', kind: 'arrival', phase: 'rollout', runway: RWY, onFrequency: 'tower' });
    await expect(game.page.getByTestId('strip-DAL8-box-E')).toHaveAttribute('aria-pressed', 'false');
    const r = await sim.command('DAL8 TAKE NEXT EXIT RIGHT');
    expect(r.code).toBe('ok_queued');
    await sim.advance(3.5);
    expect((await sim.state('DAL8'))?.exitDir).toBe('R');
    await expect(game.page.getByTestId('strip-DAL8-box-E')).toHaveAttribute('aria-pressed', 'true');
  });

  test.fixme('wake timer chip is visible on the tower view after a heavy rotates @full', async ({ openGame, sim }) => {
    // BUG: no DOM wake-timer indicator exists. 03-ATC-FEATURE-SPEC §2.7 "UI: countdown ring on the runway entry marker;
    // strip badge WT 1:23" and 05-TEST-STRATEGY §3.1 reserve `wake-timer-{rwy}` (T11), but src/game/StripBay/StripCard.tsx
    // renders no wake badge and src/components/atc/GroundView/render.ts:171-209 only labels closed/sterile/inspection
    // runways (the W2 report lists the tower runway-occupancy bars as not implemented). Engine + SYS line are covered above.
    const game = await openTower(openGame);
    await spawnLinedUp(sim, 'HVY3', RWY, 'B77W');
    expect((await sim.command(`HVY3 CLEARED FOR TAKEOFF ${RWY}`)).code).toBe('ok_queued');
    await sim.advanceUntilOk(`s => { const a = ${findSrc('HVY3')}; return !!a && a.altitude > 50; }`, 120);
    const t = (await sim.wakeTimers())[RWY];
    expect(t?.leader).toBe('HVY3');
    const chip = game.page.getByTestId(`wake-timer-${RWY}`);
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute('data-value', String(t.remainingS));
    await sim.advance(10);
    await expect(chip).toHaveAttribute('data-value', String((await sim.wakeTimers())[RWY].remainingS));
    await sim.advance(t.remainingS);
    await expect(chip).toHaveCount(0);
  });
});
