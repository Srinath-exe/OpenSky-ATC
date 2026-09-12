/*
  APPROACH position — 05-TEST-STRATEGY §4.6 (A-series) adapted to the shipped command panel + radar scope:
    check-in ("with you" REQ -> RADAR CONTACT), heading via the Dial, altitude via the Ladder (flight levels above
    the transition altitude, expedite), speed picker incl. "resume normal", direct-to-fix picker, hold builder ->
    pattern flown, ILS picker -> armed -> established -> automatic handoff to tower at 10 NM, LOC-only clearance,
    cancel approach (heading + altitude), expect runway / change runway, drag-to-heading on the radar canvas,
    wheel zoom / drag pan / range presets / measure tool / empty click, separation loss -> conflict tint + STCA,
    reduced minima for parallel established arrivals, plus (Wave-3 audit) vectors-to-final end to end by clicks only,
    handoff to tower by clicks, two arrivals in trail with speed control, STCA resolved from the alert card, and the
    soft "Cancels ILS clearance" warning on a vector while the ILS is armed.

  Every scenario boots `/play?icao=EGLL&seed=7&spawn=none&test=1&position=approach`, builds its own traffic with
  `sim.spawnAt` and moves time only through `sim.advance*`. Engine state is asserted through `sim`, visibility
  through the DOM (strips, command panel, radar chrome, comm log, alert stack).

  EGLL geometry used below: 27L / 27R are the westerlies (locCourse 269.7 T), magVar +0.4 (rounds away), TA 6999 ft
  (7000 ft and above read as flight levels), radar fixes include BIG (SE of the field, close to the 20 NM / 6 NM
  spawn spot), pilot delay 3 s in test mode, transition ILS -> tower handoff at 10 NM to threshold.
*/
import { test, expect, type SimApi, type SpawnSpec } from './fixtures/test';
import { RadarPage } from './pages/RadarPage';

const PD = 3.5;                                  // pilot delay (3 s in test mode) + slack
const ICAO = 'EGLL';

/** The §4.6 default arrival: 20 NM out / 6 NM south of the 27L centreline, 8000 ft, 250 kt, heading 090. */
function inbound(cs: string, extra: Partial<SpawnSpec> = {}): SpawnSpec {
  return { callsign: cs, type: 'A320', kind: 'arrival', phase: 'descent', posRel: { fromRunway: '27L', alongNM: -20, offsetNM: -6, altFt: 8000 }, heading: 90, speedKts: 250, plan: { runway: '27L' }, ...extra };
}
/** An arrival set up for a 25 deg localizer intercept on 27L from the south, below the glideslope. */
function intercept(cs: string, extra: Partial<SpawnSpec> = {}): SpawnSpec {
  return { callsign: cs, type: 'A320', kind: 'arrival', phase: 'descent', posRel: { fromRunway: '27L', alongNM: -16, offsetNM: -2, altFt: 3500 }, heading: 295, speedKts: 200, plan: { runway: '27L' }, ...extra };
}
const norm = (h: number) => ((h % 360) + 360) % 360;
const angDiff = (a: number, b: number) => { const d = Math.abs(norm(a) - norm(b)); return Math.min(d, 360 - d); };
const pred = (cs: string, expr: string) => `s => { const a = s.aircraft.find(x => x.callsign === ${JSON.stringify(cs)}); return !!a && (${expr}); }`;

async function turnDirOf(sim: SimApi, cs: string): Promise<string | null> {
  const st = await sim.state(cs);
  return st?.turnDir ?? null;
}

test.describe('approach: check-in and requests', () => {
  test('"with you" check-in raises a REQ; RADAR CONTACT answers it @smoke', async ({ openGame, sim }) => {
    const game = await openGame({ icao: ICAO, spawn: 'none', position: 'approach' });
    await sim.spawnAt(inbound('UAL9'));
    await expect(game.strip('UAL9')).toHaveAttribute('data-stage', 'arr_inbound');

    // the first call on the frequency: the engine raises a with_you request (spawnAt aircraft are pre-controlled, so inject it)
    await sim.request('UAL9', 'with_you');
    const before = await sim.aircraftOrFail('UAL9');
    expect(before.requests.map((r) => r.kind)).toEqual(['with_you']);
    const call = await game.waitRadio(/Approach.*United niner|United niner.*Approach/i, { who: 'PILOT', callsign: 'UAL9' });
    expect(call.text).toMatch(/Heathrow Approach/);
    await expect(game.stripReq('UAL9')).toBeVisible();
    await expect(game.stripReq('UAL9')).toHaveAttribute('data-kind', 'with_you');
    await expect(game.strip('UAL9')).toHaveAttribute('data-req', 'with_you');

    await game.openPanelFor('UAL9');
    await expect(game.reqBand()).toBeVisible();
    await expect(game.reqBand()).toHaveAttribute('data-request', 'with_you');
    // no one-tap answer is mapped for a check-in (REQUEST_ANSWER has no with_you); unable / standby stay offered
    await expect(game.reqAnswer()).toHaveCount(0);
    await expect(game.reqUnable()).toBeVisible();
    await expect(game.reqStandby()).toBeVisible();

    // RADAR CONTACT is the answer (typed)
    const atc = await game.sendOk('UAL9 RADAR CONTACT');
    expect(atc.callsign).toBe('UAL9');
    expect(atc.text).toMatch(/radar contact/i);
    // the request is answered on transmission (engine), the pilot reads back after the delay
    expect((await sim.aircraftOrFail('UAL9')).requests).toEqual([]);
    await expect(game.reqBand()).toHaveCount(0);
    await expect(game.stripReq('UAL9')).toHaveCount(0);
    await sim.advance(PD);
    const rb = await game.waitRadio(/radar contact/i, { who: 'PILOT', callsign: 'UAL9' });
    expect(rb.status).toMatch(/^(ok|executed)$/);
    const after = await sim.aircraftOrFail('UAL9');
    expect(after.underControl).toBe(true);
    expect(after.pendingCmds).toEqual([]);
    expect((await sim.events()).some((e) => e.type === 'request' && /request with_you answered/.test(e.message))).toBe(true);
  });

  test('direct to a fix: picker search, DCT badge, fix passed -> "request further" answered with a vector @full', async ({ openGame, sim }) => {
    const game = await openGame({ icao: ICAO, spawn: 'none', position: 'approach' });
    await sim.spawnAt(inbound('UAL9'));
    await game.openPanelFor('UAL9');

    await game.action('action-direct');
    await expect(game.stepper().first()).toHaveAttribute('data-step-type', 'fix');
    const beacons = await sim.beacons();
    expect(beacons).toContain('BIG');
    // every radar fix is a row keyed by its id; the search narrows the list by prefix
    await expect(game.page.locator('[role="option"][data-testid^="picker-fix-"]')).toHaveCount(beacons.length);
    await game.page.getByTestId('picker-fix-search').fill('BI');
    const shown = await game.page.locator('[role="option"][data-testid^="picker-fix-"]').evaluateAll((els) => els.map((e) => (e.getAttribute('data-testid') ?? '').slice('picker-fix-'.length)));
    expect(shown).toEqual(beacons.filter((b) => b.startsWith('BI')));
    await game.pickFix('BIG');
    await expect(game.page.getByTestId('picker-fix-BIG')).toHaveText(/\d{3}° \/ \d+\.\d NM/);
    await game.next();
    await expect(game.confirmSummary()).toContainText(/proceed direct BIG/);
    const tx = await game.transmit();
    expect(tx.code).toBe('ok_queued');
    expect(tx.tx).toMatch(/direct BIG/);

    await sim.advance(PD);
    const v = await sim.aircraftOrFail('UAL9');
    expect(v.navMode).toBe('direct');
    expect(v.directTargetName).toBe('BIG');
    await expect(game.strip('UAL9')).toContainText('DCT BIG');
    await game.waitRadio(/Direct BIG/i, { who: 'PILOT', callsign: 'UAL9' });

    // over the fix (< 1500 m) the direct completes, heading mode resumes and the pilot asks for further clearance
    await sim.advanceUntilOk(pred('UAL9', "a.navMode === 'heading' && a.directTargetName === 'BIG'"), 600);
    await sim.advanceUntilOk(pred('UAL9', "a.requests.some(r => r.kind === 'further')"), 120);
    await expect(game.stripReq('UAL9')).toHaveAttribute('data-kind', 'further');
    await expect(game.reqBand()).toHaveAttribute('data-request', 'further');
    await expect(game.reqAnswer()).toContainText(/Vector/);
    await game.reqAnswer().click();                       // one-tap: opens the heading action on its confirm step
    await expect(game.stepperFor('action-heading')).toBeVisible();
    await expect(game.stepperFor('action-heading')).toHaveAttribute('data-step-type', 'confirm');
    const tx2 = await game.transmit();
    expect(tx2.code).toBe('ok_queued');
    expect((await sim.aircraftOrFail('UAL9')).requests).toEqual([]);
  });
});

test.describe('approach: vectors, altitude, speed', () => {
  test('heading via the Dial: L / R / shortest and the present-heading preset @smoke', async ({ openGame, sim }) => {
    const game = await openGame({ icao: ICAO, spawn: 'none', position: 'approach' });
    await sim.spawnAt(inbound('UAL9'));
    await game.openPanelFor('UAL9');
    await expect(game.metric('hdg')).toHaveAttribute('data-value', '90');

    // dial opens on the present heading, magnetic display
    await game.action('action-heading');
    await expect(game.stepper().first()).toHaveAttribute('data-step-type', 'heading');
    await expect(game.page.getByTestId('picker-heading-input')).toHaveValue('090');
    await expect(game.page.getByTestId('picker-heading-current')).toHaveText(/present 090/);
    await game.dial(210, 'L');
    await expect(game.page.getByTestId('picker-heading-left')).toHaveAttribute('aria-pressed', 'true');
    await game.next();
    await expect(game.confirmSummary()).toContainText(/turn left heading two one zero/);
    const tx = await game.transmit();
    expect(tx).toMatchObject({ status: 'ok', code: 'ok_queued' });
    expect(tx.tx).toMatch(/turn left heading two one zero/);

    // pending until the pilot delay, then the target is set and the dial-side metric shows it
    let v = await sim.aircraftOrFail('UAL9');
    expect(v.pendingCmds.map((c) => c.kind)).toEqual(['heading']);
    await expect(game.panelPending()).toHaveText(/1 pending/);
    await sim.advance(PD);
    v = await sim.aircraftOrFail('UAL9');
    expect(v.pendingCmds).toEqual([]);
    expect(v.navMode).toBe('heading');
    expect(angDiff(v.targetHeading, 210)).toBeLessThanOrEqual(1);
    expect(await turnDirOf(sim, 'UAL9')).toBe('L');
    await expect(game.metricTarget('hdg')).toHaveAttribute('data-value', '210');
    await expect(game.metricTarget('hdg')).toHaveAttribute('data-dir', 'l');
    await expect(game.resultRb()).toHaveAttribute('data-status', 'ok');
    await game.waitRadio(/Left heading two one zero/i, { who: 'PILOT', callsign: 'UAL9' });

    // the turn is flown (2 deg/s): 240 deg the long way round, LEFT through north (a right turn would pass 150)
    await sim.advance(30);
    const mid = norm((await sim.aircraftOrFail('UAL9')).heading);
    expect(mid > 210 || mid < 90, `heading ${mid.toFixed(0)} should be on the left-turn arc`).toBe(true);
    expect(angDiff(mid, 90)).toBeGreaterThan(20);
    await sim.advance(100);
    v = await sim.aircraftOrFail('UAL9');
    expect(angDiff(v.heading, 210)).toBeLessThanOrEqual(2);
    await expect(game.metricTarget('hdg')).toHaveCount(0);            // steady: no target shown
    await expect(game.strip('UAL9').getByTestId('strip-hdg')).toHaveAttribute('data-value', String(Math.round(v.heading)));

    // present-heading preset re-centres the dial; R forces the long way round; shortest clears the direction
    await game.action('action-heading');
    await game.page.getByTestId('picker-heading-current').click();
    await expect(game.page.getByTestId('picker-heading-input')).toHaveValue(String(Math.round(norm(v.heading - 0.41)) || 360).padStart(3, '0'));
    await game.dial(180, 'R');
    await game.next();
    await expect(game.confirmSummary()).toContainText(/turn right heading one eight zero/);
    await game.transmit();
    await sim.advance(PD);
    expect(await turnDirOf(sim, 'UAL9')).toBe('R');
    expect(angDiff((await sim.aircraftOrFail('UAL9')).targetHeading, 180)).toBeLessThanOrEqual(1);
    await expect(game.metricTarget('hdg')).toHaveAttribute('data-dir', 'r');

    await game.action('action-heading');
    await game.dial(240, 'shortest');
    await game.next();
    await expect(game.confirmSummary()).toContainText(/fly heading two four zero/);
    await game.transmit();
    await sim.advance(PD);
    expect(await turnDirOf(sim, 'UAL9')).toBeNull();
    expect(angDiff((await sim.aircraftOrFail('UAL9')).targetHeading, 240)).toBeLessThanOrEqual(1);
  });

  test('altitude via the Ladder: flight levels above the transition altitude, expedite, then a descent @full', async ({ openGame, sim }) => {
    const game = await openGame({ icao: ICAO, spawn: 'none', position: 'approach' });
    await sim.spawnAt(inbound('UAL9', { heading: 270 }));                // towards the field: stays inside the TMA
    await game.openPanelFor('UAL9');
    await expect(game.metric('alt')).toHaveAttribute('data-value', '8000');
    await expect(game.metric('alt')).toHaveText(/FL\s*080/);          // TA 6999: 8000 ft reads as FL080

    await game.action('action-altitude');
    await expect(game.stepper().first()).toHaveAttribute('data-step-type', 'altitude');
    const svg = game.page.getByTestId('picker-alt-ladder-svg');
    await expect(svg).toHaveAttribute('role', 'slider');
    await expect(svg).toHaveAttribute('aria-valuemin', '1000');
    await expect(svg).toHaveAttribute('aria-valuemax', '20000');
    await expect(svg).toHaveAttribute('aria-valuenow', '7000');       // default: next 1000 below the present level
    await game.ladderAlt(12000, { expedite: true });
    await expect(svg).toHaveAttribute('aria-valuenow', '12000');
    await expect(game.page.getByTestId('picker-alt-expedite')).toHaveAttribute('aria-checked', 'true');
    await game.next();
    await expect(game.confirmSummary()).toContainText(/climb to flight level one two zero, expedite/);
    const tx = await game.transmit();
    expect(tx.code).toBe('ok_queued');
    expect(tx.tx).toMatch(/flight level one two zero, expedite/);

    await sim.advance(PD);
    let v = await sim.aircraftOrFail('UAL9');
    expect(v.cmdAltitude).toBe(12000);
    expect(v.expedite).toBe(true);
    await expect(game.metricTarget('alt')).toHaveAttribute('data-value', '12000');
    await expect(game.metricTarget('alt')).toHaveAttribute('data-dir', 'up');
    await expect(game.metricTarget('alt')).toHaveText(/FL\s*120/);
    await game.waitRadio(/flight level one two zero, expediting/i, { who: 'PILOT', callsign: 'UAL9' });
    await sim.advance(60);
    v = await sim.aircraftOrFail('UAL9');
    expect(v.altitude).toBeGreaterThan(9500);                          // > 1500 fpm with expedite
    await expect(game.stripAlt('UAL9')).toHaveAttribute('data-value', String(Math.round(v.altitude)));

    // descend below the transition altitude: plain feet, expedite off by default
    await game.action('action-altitude');
    await game.ladderAlt(4000);
    await expect(game.page.getByTestId('picker-alt-expedite')).toHaveAttribute('aria-checked', 'false');
    await game.next();
    await expect(game.confirmSummary()).toContainText(/descend to four thousand/);
    await expect(game.confirmSummary()).not.toContainText(/expedite/);
    await game.transmit();
    await sim.advance(PD);
    v = await sim.aircraftOrFail('UAL9');
    expect(v.cmdAltitude).toBe(4000);
    expect(v.expedite).toBe(false);
    await expect(game.metricTarget('alt')).toHaveAttribute('data-dir', 'dn');
    await expect(game.metricTarget('alt')).toHaveText(/4,000/);
    const top = v.altitude;
    await sim.advance(120);
    v = await sim.aircraftOrFail('UAL9');
    expect(top - v.altitude).toBeGreaterThan(2000);                     // descending (>= 1000 fpm)
    await sim.advanceUntilOk(pred('UAL9', 'Math.abs(a.altitude - 4000) <= 40'), 400);
    await expect(game.metricTarget('alt')).toHaveCount(0);                // level within 50 ft: no target shown
    await expect(game.metric('alt')).toHaveText(/4,0\d\d/);
  });

  test('speed picker: ladder / chips, then "resume normal speed" @full', async ({ openGame, sim }) => {
    const game = await openGame({ icao: ICAO, spawn: 'none', position: 'approach' });
    await sim.spawnAt(inbound('UAL9'));
    await game.openPanelFor('UAL9');
    await expect(game.metric('spd')).toHaveAttribute('data-value', '250');

    await game.action('action-speed');
    await expect(game.stepper().first()).toHaveAttribute('data-step-type', 'speed');
    const svg = game.page.getByTestId('picker-speed-ladder-svg');
    await expect(svg).toHaveAttribute('aria-valuemin', '128');        // A320 TMA envelope
    await expect(svg).toHaveAttribute('aria-valuemax', '250');
    await expect(game.page.getByTestId('picker-speed-resume')).toBeVisible();
    await expect(game.page.getByTestId('picker-speed-final')).toHaveText(/final approach 140/);
    await game.ladderSpd(210);
    await expect(svg).toHaveAttribute('aria-valuenow', '210');
    await game.next();
    await expect(game.confirmSummary()).toContainText(/reduce speed to two one zero knots/);
    const tx = await game.transmit();
    expect(tx.code).toBe('ok_queued');
    await sim.advance(PD);
    let v = await sim.aircraftOrFail('UAL9');
    expect(v.cmdIas).toBe(210);
    await expect(game.metricTarget('spd')).toHaveAttribute('data-value', '210');
    await expect(game.metricTarget('spd')).toHaveAttribute('data-dir', 'dn');
    await game.waitRadio(/two one zero knots/i, { who: 'PILOT', callsign: 'UAL9' });
    await sim.advanceUntilOk(pred('UAL9', 'a.speed <= 212'), 120);

    // 180 via a quick chip / the ladder, then resume normal speed clears the assignment
    await game.action('action-speed');
    await game.ladderSpd(180);
    await game.next();
    await expect(game.confirmSummary()).toContainText(/one eight zero knots/);
    await game.transmit();
    await sim.advance(PD);
    expect((await sim.aircraftOrFail('UAL9')).cmdIas).toBe(180);

    await game.action('action-speed');
    await game.ladderSpd('resume');
    await expect(svg).toHaveAttribute('aria-disabled', 'true');
    await game.next();
    await expect(game.confirmSummary()).toContainText(/no speed restrictions/);
    const tx2 = await game.transmit();
    expect(tx2.code).toBe('ok_queued');
    await sim.advance(PD);
    v = await sim.aircraftOrFail('UAL9');
    expect(v.cmdIas).toBeNull();
    await game.waitRadio(/Resuming normal speed/i, { who: 'PILOT', callsign: 'UAL9' });
    await expect(game.page.getByTestId('panel-metric-spd')).not.toContainText(/asg/);
  });

  test('hold builder (fix / inbound / turns / leg / EFC) -> the pattern is flown, a vector leaves it @full', async ({ openGame, sim }) => {
    const game = await openGame({ icao: ICAO, spawn: 'none', position: 'approach' });
    await sim.spawnAt(inbound('UAL9'));
    await game.openPanelFor('UAL9');

    await game.action('action-hold-fix');
    await expect(game.picker('hold')).toBeVisible();
    await expect(game.page.getByTestId('picker-hold-accept')).toBeEnabled();   // the planned fix is preselected
    await game.pickFix('BIG');
    const dial = game.page.getByTestId('picker-hold-inbound-svg');
    await expect(dial).toHaveAttribute('role', 'slider');
    const inboundMag = Number(await dial.getAttribute('aria-valuenow'));
    expect(inboundMag).toBeGreaterThanOrEqual(0);
    expect(inboundMag).toBeLessThanOrEqual(360);
    await game.page.getByTestId('picker-hold-turns-left').click();
    await expect(game.page.getByTestId('picker-hold-turns-left')).toHaveAttribute('aria-pressed', 'true');
    await game.page.getByTestId('picker-hold-leg-1m').click();
    await expect(game.page.getByTestId('picker-hold-leg-1m')).toHaveAttribute('aria-pressed', 'true');
    await game.page.getByTestId('picker-hold-efc-10').click();
    await expect(game.page.getByTestId('picker-hold-efc-10')).toHaveAttribute('aria-pressed', 'true');
    await expect(game.picker('hold')).toContainText(new RegExp(`Hold BIG inbound ${String(inboundMag).padStart(3, '0')} left turns`));
    await game.next();
    await expect(game.confirmSummary()).toContainText(/hold at BIG/);
    await expect(game.confirmSummary()).toContainText(/left turns, one minute legs, expect further clearance/);
    const tx = await game.transmit();
    expect(tx.code).toBe('ok_queued');

    await sim.advance(PD);
    const v = await sim.aircraftOrFail('UAL9');
    expect(v.navMode).toBe('hold');
    expect(v.holdFixName).toBe('BIG');
    expect(v.holdPhase).toBe('to_fix');
    const st = (await sim.state('UAL9'))!;
    expect(st.holdTurnDir).toBe('L');
    expect(st.holdLegMin).toBe(1);
    expect(st.holdEfc).toBeCloseTo(600, 0);
    expect(angDiff(st.holdInboundHdg, inboundMag + 0.41)).toBeLessThanOrEqual(1);
    await expect(game.strip('UAL9')).toContainText('HLD BIG');
    await game.waitRadio(/Hold at BIG/i, { who: 'PILOT', callsign: 'UAL9' });

    // 12 minutes in the hold: every phase of the racetrack is visited, more than one circuit, never far from the fix
    const phases: string[] = [];
    let maxNM = 0;
    for (let i = 0; i < 144; i++) {
      await sim.advance(5);
      const a = await sim.aircraftOrFail('UAL9');
      if (phases[phases.length - 1] !== a.holdPhase) phases.push(a.holdPhase);
      maxNM = Math.max(maxNM, Math.hypot(a.pos.x - st.holdFix!.x, a.pos.y - st.holdFix!.y) / 1852);
    }
    for (const p of ['to_fix', 'outbound_turn', 'outbound', 'inbound_turn', 'inbound']) expect(phases).toContain(p);
    expect(phases.filter((p) => p === 'outbound').length).toBeGreaterThanOrEqual(2);   // a second circuit started
    expect(maxNM).toBeLessThan(12);
    expect((await sim.aircraftOrFail('UAL9')).navMode).toBe('hold');

    // a vector ends the hold
    await game.action('action-heading');
    await game.dial(270, 'R');
    await game.next();
    await game.transmit();
    await sim.advance(PD);
    const out = await sim.aircraftOrFail('UAL9');
    expect(out.navMode).toBe('heading');
    expect(out.holdFixName).toBeNull();
    expect(angDiff(out.targetHeading, 270)).toBeLessThanOrEqual(1);
    await expect(game.strip('UAL9')).not.toContainText('HLD');
  });
});

test.describe('approach: ILS, runways, cancel', () => {
  test('ILS picker -> armed -> established -> automatic handoff to tower at 10 NM @smoke', async ({ openGame, sim }) => {
    const game = await openGame({ icao: ICAO, spawn: 'none', position: 'approach' });
    const radar = new RadarPage(game.page, game);
    await sim.spawnAt(intercept('BAW12'));
    await game.openPanelFor('BAW12');
    await expect(game.panelStage()).toHaveAttribute('data-stage', 'arr_inbound');
    await expect(game.page.getByTestId('strip-BAW12-box-I')).toHaveAttribute('aria-pressed', 'false');

    await game.action('action-ils');
    await expect(game.stepper().first()).toHaveAttribute('data-step-type', 'runway');
    await expect(game.page.getByTestId('picker-runway-mode-ils')).toHaveAttribute('aria-pressed', 'true');
    for (const r of ['27L', '27R', '09L', '09R']) await expect(game.page.getByTestId(`picker-runway-${r}`)).toHaveAttribute('data-state', 'enabled');
    await expect(game.page.getByTestId('picker-runway-27L')).toHaveAttribute('aria-pressed', 'true');   // planned runway preselected
    await game.pickRunway('27L', 'ils');
    await game.next();
    await expect(game.confirmSummary()).toContainText(/cleared ILS approach runway two seven left/);
    expect(await game.confirmWarnings()).toEqual([]);
    const tx = await game.transmit();
    expect(tx.code).toBe('ok_queued');

    await sim.advance(PD);
    let v = await sim.aircraftOrFail('BAW12');
    expect(v.ilsArmed).toBe(true);
    expect(v.ilsCaptured).toBe(false);
    expect(v.assignedRunway).toBe('27L');
    expect(v.navMode).toBe('ils');
    expect(v.stage).toBe('arr_armed');
    await expect(game.panelStage()).toHaveAttribute('data-stage', 'arr_armed');
    await expect(game.strip('BAW12')).toHaveAttribute('data-stage', 'arr_armed');
    await expect(game.strip('BAW12')).toContainText('ILS 27L armed');
    await expect(game.page.getByTestId('strip-BAW12-box-I')).toHaveAttribute('aria-pressed', 'true');
    await game.waitRadio(/Cleared ILS runway two seven left/i, { who: 'PILOT', callsign: 'BAW12' });
    // vectors are still offered while intercepting, but flagged as cancelling the clearance
    expect((await sim.actions('BAW12')).find((r) => r.id === 'action-heading')?.state).toBe('enabled');

    // localizer capture (25 deg intercept, below the slope -> LOC and GS capture together), still > 10 NM out
    const tCap = await sim.advanceUntilOk(pred('BAW12', 'a.ilsCaptured'), 300);
    expect(tCap).toBeGreaterThan(10);
    v = await sim.aircraftOrFail('BAW12');
    expect(v.ilsCaptured).toBe(true);
    expect(v.gsCaptured).toBe(true);
    expect(v.stage).toBe('arr_established');
    expect(v.onFrequency).toBe('approach');
    expect(v.handedTo).toBeNull();
    expect((await radar.distToThresholdNM('BAW12', '27L'))!).toBeGreaterThan(10);
    await expect(game.panelStage()).toHaveAttribute('data-stage', 'arr_established');
    await expect(game.strip('BAW12')).toContainText('ILS 27L est');
    await game.waitRadio(/established localizer 27L/i, { who: 'PILOT', callsign: 'BAW12' });
    expect((await sim.actions('BAW12')).find((r) => r.id === 'action-heading')).toMatchObject({ state: 'disabled', reason: 'X4' });
    expect((await sim.actions('BAW12')).find((r) => r.id === 'action-land')?.state).toBe('enabled');
    await expect(game.actionBtn('action-heading')).toHaveAttribute('data-state', 'disabled');

    // the engine hands the established arrival to tower once it is inside 10 NM; the frequency change completes 2 s later
    await sim.advanceUntilOk(pred('BAW12', "a.handedTo === 'tower'"), 400);
    expect((await radar.distToThresholdNM('BAW12', '27L'))!).toBeLessThanOrEqual(10);
    expect((await radar.distToThresholdNM('BAW12', '27L'))!).toBeGreaterThan(9);
    await sim.advanceUntilOk(pred('BAW12', "a.onFrequency === 'tower'"), 30);
    v = await sim.aircraftOrFail('BAW12');
    expect(v.handedTo).toBeNull();
    expect((await sim.events()).some((e) => e.type === 'handoff' && e.callsign === 'BAW12' && (e.data as { to?: string } | undefined)?.to === 'tower')).toBe(true);
    // the strip stays in the APPROACH bay as a TO_TOWER ghost, the panel notes the other frequency
    await expect(game.strip('BAW12')).toHaveAttribute('data-onfreq', 'tower');
    await expect(game.strip('BAW12')).toHaveAttribute('data-bay', 'TO_TOWER');
    await expect(game.page.getByTestId('strip-BAW12-ghost')).toHaveText('TWR');
    await expect(game.page.getByTestId('panel-onfreq-note')).toBeVisible();
    // tracking the localizer: heading steady on the course, the hdg metric reads ILS instead of a target
    expect(angDiff(v.heading, v.targetHeading)).toBeLessThanOrEqual(2);
    await expect(game.page.getByTestId('panel-metric-hdg')).toContainText('ILS');
    await expect(game.metricTarget('hdg')).toHaveCount(0);
    await game.showAllFrequencies();
    await game.waitRadio(/contact Heathrow Tower 118\.505/, { who: 'SYS', callsign: 'BAW12' });
    // ... and it shows up in the TOWER final bay
    await game.setPosition('tower');
    await expect(game.strip('BAW12')).toHaveAttribute('data-bay', 'FINAL');
  });

  test('LOC-only clearance: localizer captured, glideslope never armed @full', async ({ openGame, sim }) => {
    const game = await openGame({ icao: ICAO, spawn: 'none', position: 'approach' });
    await sim.spawnAt(intercept('BAW12'));
    await game.openPanelFor('BAW12');
    await game.action('action-ils');
    await game.pickRunway('27L', 'loc');
    await expect(game.page.getByTestId('picker-runway-mode-loc')).toHaveAttribute('aria-pressed', 'true');
    await game.next();
    await expect(game.confirmSummary()).toContainText(/cleared localizer approach runway two seven left/);
    await game.transmit();
    await sim.advance(PD);
    let v = await sim.aircraftOrFail('BAW12');
    expect(v.navMode).toBe('loc');
    expect(v.ilsArmed).toBe(true);
    await game.waitRadio(/Cleared localizer two seven left/i, { who: 'PILOT', callsign: 'BAW12' });

    await sim.advanceUntilOk(pred('BAW12', 'a.ilsCaptured'), 300);
    await sim.advance(60);
    v = await sim.aircraftOrFail('BAW12');
    expect(v.ilsCaptured).toBe(true);
    expect(v.gsCaptured).toBe(false);
    expect(v.navMode).toBe('loc');
    expect(v.altitude).toBeCloseTo(3500, -2);                          // level: no glideslope descent
    await expect(game.page.getByTestId('panel-metric-hdg')).toContainText('LOC');
    await expect(game.panelStage()).toHaveAttribute('data-stage', 'arr_established');
  });

  test('cancel approach clearance with a heading and an altitude @full', async ({ openGame, sim }) => {
    const game = await openGame({ icao: ICAO, spawn: 'none', position: 'approach' });
    await sim.spawnAt(intercept('BAW12', { ils: '27L' }));           // pre-armed: arr_armed
    await game.openPanelFor('BAW12');
    await expect(game.panelStage()).toHaveAttribute('data-stage', 'arr_armed');
    expect((await sim.aircraftOrFail('BAW12')).ilsArmed).toBe(true);

    await game.action('action-cancel-approach');
    await expect(game.stepper().first()).toHaveAttribute('data-step-type', 'heading');
    await expect(game.page.getByTestId('picker-heading-input')).toHaveValue('295');   // defaults to the present heading
    await game.dial(360, 'R');
    await game.next();
    await expect(game.stepper().first()).toHaveAttribute('data-step-type', 'altitude');
    await expect(game.page.getByTestId('picker-alt-ladder-svg')).toHaveAttribute('aria-valuenow', '4000');   // next 1000 above, min 3000
    await game.ladderAlt(5000);
    await game.next();
    await expect(game.confirmSummary()).toContainText(/cancel approach clearance, turn right heading tree six zero, climb to fife thousand/);
    const tx = await game.transmit();
    expect(tx.code).toBe('ok_queued');

    await sim.advance(PD);
    const v = await sim.aircraftOrFail('BAW12');
    expect(v.ilsArmed).toBe(false);
    expect(v.ilsCaptured).toBe(false);
    expect(v.assignedRunway).toBeNull();
    expect(v.navMode).toBe('heading');
    expect(angDiff(v.targetHeading, 360)).toBeLessThanOrEqual(1);
    expect(await turnDirOf(sim, 'BAW12')).toBe('R');
    expect(v.cmdAltitude).toBe(5000);
    expect(v.stage).toBe('arr_inbound');
    await expect(game.panelStage()).toHaveAttribute('data-stage', 'arr_inbound');
    await expect(game.strip('BAW12')).toHaveAttribute('data-stage', 'arr_inbound');
    await expect(game.strip('BAW12')).not.toContainText('ILS 27L');
    await expect(game.page.getByTestId('strip-BAW12-box-I')).toHaveAttribute('aria-pressed', 'false');
    await expect(game.metricTarget('alt')).toHaveAttribute('data-value', '5000');
    await expect(game.metricTarget('hdg')).toHaveAttribute('data-dir', 'r');
    await game.waitRadio(/Cancel approach, right heading tree six zero, climb fife thousand/i, { who: 'PILOT', callsign: 'BAW12' });
    // vectors are plain again (no ILS to cancel)
    await game.action('action-heading');
    await game.dial(270, 'L');
    await game.next();
    expect(await game.confirmWarnings()).toEqual([]);
    await game.cancel();
  });

  test('expect runway, then change runway to the parallel @full', async ({ openGame, sim }) => {
    const game = await openGame({ icao: ICAO, spawn: 'none', position: 'approach' });
    await sim.spawnAt(intercept('BAW12'));
    await game.openPanelFor('BAW12');
    await expect(game.panelRunway()).toHaveText('RWY 27L');
    await expect(game.stripRunway('BAW12')).toHaveText('27L');

    // expect runway (inbound only): the strip's runway button opens the same action
    await game.stripRunway('BAW12').click();
    await expect(game.stepperFor('action-expect-runway')).toBeVisible();
    await game.pickRunway('27R');
    await game.next();
    await expect(game.confirmSummary()).toContainText(/expect ILS approach runway two seven right/);
    const tx = await game.transmit();
    expect(tx.code).toBe('ok_queued');
    await sim.advance(PD);
    let v = await sim.aircraftOrFail('BAW12');
    expect(v.plan.runway).toBe('27R');
    expect(v.ilsArmed).toBe(false);
    await expect(game.panelRunway()).toHaveText('RWY 27R');
    await expect(game.stripRunway('BAW12')).toHaveText('27R');
    await game.waitRadio(/Expect ILS two seven right/i, { who: 'PILOT', callsign: 'BAW12' });

    // the ILS picker now preselects 27R; arm it
    await game.action('action-ils');
    await expect(game.page.getByTestId('picker-runway-27R')).toHaveAttribute('aria-pressed', 'true');
    await game.next();
    await game.transmit();
    await sim.advance(PD);
    v = await sim.aircraftOrFail('BAW12');
    expect(v.assignedRunway).toBe('27R');
    expect(v.stage).toBe('arr_armed');
    await expect(game.actionBtn('action-expect-runway')).toHaveCount(0);      // hidden once armed
    await expect(game.actionBtn('action-change-runway')).toHaveAttribute('data-state', 'enabled');

    // change runway offers only the parallel(s) and re-clears the ILS
    await game.action('action-change-runway');
    const chips = await game.page.locator('[data-testid^="picker-runway-"][role="radio"]').evaluateAll((els) => els.map((e) => (e.getAttribute('data-testid') ?? '').slice('picker-runway-'.length)));
    expect(chips).toEqual(['27L']);
    await game.pickRunway('27L');
    await game.next();
    await expect(game.confirmSummary()).toContainText(/cleared ILS approach runway two seven left/);
    const tx2 = await game.transmit();
    expect(tx2.code).toBe('ok_queued');
    await sim.advance(PD);
    v = await sim.aircraftOrFail('BAW12');
    expect(v.assignedRunway).toBe('27L');
    expect(v.plan.runway).toBe('27L');
    expect(v.ilsArmed).toBe(true);
    await expect(game.panelRunway()).toHaveText('RWY 27L');
    await expect(game.strip('BAW12')).toContainText('ILS 27L armed');
    await game.waitRadio(/Cleared ILS runway two seven left/i, { who: 'PILOT', callsign: 'BAW12' });
  });
});

test.describe('approach: radar scope', () => {
  test('click selects, hover shows the tooltip, empty click deselects @smoke', async ({ openGame, sim }) => {
    const game = await openGame({ icao: ICAO, spawn: 'none', position: 'approach' });
    const radar = new RadarPage(game.page, game);
    await radar.waitReady();
    await sim.spawnAt(inbound('UAL9'));
    await expect(game.shell()).toHaveAttribute('data-has-panel', 'false');

    await radar.hoverAircraft('UAL9');
    await expect(radar.tooltip()).toBeVisible();
    await expect(radar.tooltip()).toHaveAttribute('data-callsign', 'UAL9');
    await expect(radar.tooltip()).toContainText(/8,000 ft · 250 kt · HDG 090/);
    await expect(radar.view()).toHaveAttribute('data-cursor', 'pointer');

    await radar.clickAircraft('UAL9');
    await expect(game.panelCallsign()).toHaveText('UAL9');
    await expect(game.strip('UAL9')).toHaveAttribute('data-selected', 'true');
    expect((await sim.snapshot()).selectedId).toBe((await sim.aircraftOrFail('UAL9')).id);

    // a miss outside the 16 px hit radius does not select; a hit inside does
    await radar.clickEmpty();
    await expect(game.shell()).toHaveAttribute('data-has-panel', 'false');
    await expect(game.strip('UAL9')).toHaveAttribute('data-selected', 'false');
    expect((await sim.snapshot()).selectedId).toBeNull();
    const p = await radar.posOf('UAL9');
    await radar.canvas().click({ position: { x: p.x + 24, y: p.y } });
    expect((await sim.snapshot()).selectedId).toBeNull();
    await radar.canvas().click({ position: { x: p.x + 8, y: p.y } });
    await expect(game.panelCallsign()).toHaveText('UAL9');
    // the panel close button deselects too
    await game.closePanel();
    expect((await sim.snapshot()).selectedId).toBeNull();
  });

  test('drag-to-heading: live readout, confirm bubble with L/R, Send transmits the vector @smoke', async ({ openGame, sim }) => {
    const game = await openGame({ icao: ICAO, spawn: 'none', position: 'approach' });
    const radar = new RadarPage(game.page, game);
    await radar.waitReady();
    await sim.spawnAt(inbound('UAL9'));
    await radar.clickAircraft('UAL9');
    await expect(game.panelCallsign()).toHaveText('UAL9');

    // drag the selected symbol 60 px right / 120 px down -> 153 deg
    const want = RadarPage.headingForDrag(60, 120, 0.41);
    expect(want).toBe(153);
    await radar.beginDrag('UAL9', 60, 120);
    await expect(radar.hdgReadout()).toHaveText(`HDG ${String(want).padStart(3, '0')}`);
    await expect(radar.hdgReadout()).toHaveAttribute('data-snap', '0');
    await expect(radar.view()).toHaveAttribute('data-cursor', 'vector');
    await expect(radar.anyBubble()).toHaveCount(0);
    await radar.release();

    const bubble = radar.bubble('hdg');
    await expect(bubble).toBeVisible();
    await expect(bubble).toHaveAttribute('data-kind', 'heading');
    await expect(bubble).toContainText('UAL9');
    await expect(bubble).toContainText(`fly heading ${String(want).padStart(3, '0')}`);
    await expect(bubble).toContainText(/63° turn from 090/);
    await expect(radar.bubblePart('dial-svg')).toBeVisible();
    await expect(radar.hdgReadout()).toBeHidden();
    // nothing transmitted yet
    expect((await sim.radio()).filter((l) => l.who === 'ATC')).toHaveLength(0);
    await radar.bubblePart('left').click();
    await expect(radar.bubblePart('left')).toHaveAttribute('aria-pressed', 'true');
    await expect(bubble).toContainText(`turn left heading ${String(want).padStart(3, '0')}`);
    await radar.bubblePart('send').click();
    await expect(bubble).toHaveCount(0);

    const atc = await game.waitRadio(/turn left heading one fife tree/i, { who: 'ATC', callsign: 'UAL9' });
    expect(atc.callsign).toBe('UAL9');
    expect(atc.status).toMatch(/^(ok|pending)$/);
    expect((await sim.aircraftOrFail('UAL9')).pendingCmds.map((c) => c.kind)).toEqual(['heading']);
    await sim.advance(PD);
    const v = await sim.aircraftOrFail('UAL9');
    expect(v.navMode).toBe('heading');
    expect(angDiff(v.targetHeading, want)).toBeLessThanOrEqual(1);
    expect(await turnDirOf(sim, 'UAL9')).toBe('L');
    await expect(game.metricTarget('hdg')).toHaveAttribute('data-value', String(want));
    await game.waitRadio(/Left heading one fife tree/i, { who: 'PILOT', callsign: 'UAL9' });

    // Esc in the bubble cancels without transmitting
    const atcLines = (await sim.radio()).filter((l) => l.who === 'ATC').length;
    await radar.dragToHeading('UAL9', -120, 0);
    await expect(radar.bubble('hdg')).toContainText('fly heading 270');
    await game.page.keyboard.press('Escape');
    await expect(radar.bubble('hdg')).toHaveCount(0);
    expect((await sim.radio()).filter((l) => l.who === 'ATC')).toHaveLength(atcLines);
    // the Cancel button too, and an empty click closes an open bubble
    await radar.dragToHeading('UAL9', 0, -120);
    await radar.bubblePart('cancel').click();
    await expect(radar.bubble('hdg')).toHaveCount(0);
    expect((await sim.radio()).filter((l) => l.who === 'ATC')).toHaveLength(atcLines);
    expect((await sim.aircraftOrFail('UAL9')).pendingCmds).toEqual([]);

    // dropping the symbol on a fix becomes a DIRECT draft
    await radar.dragToFix('UAL9', 'BIG');
    await expect(radar.bubble('dct')).toContainText('direct BIG');
    await radar.bubblePart('send', 'dct').click();
    await game.waitRadio(/direct BIG/i, { who: 'ATC', callsign: 'UAL9' });
    await sim.advance(PD);
    expect((await sim.aircraftOrFail('UAL9')).navMode).toBe('direct');
    expect((await sim.aircraftOrFail('UAL9')).directTargetName).toBe('BIG');
  });

  test('wheel zoom and the zoom buttons scale the scope; the range chip follows @full', async ({ openGame, sim }) => {
    const game = await openGame({ icao: ICAO, spawn: 'none', position: 'approach' });
    const radar = new RadarPage(game.page, game);
    await radar.waitReady();
    await sim.spawnAt(inbound('UAL9'));
    await sim.spawnAt(inbound('DLH4', { posRel: { fromRunway: '27L', alongNM: -10, offsetNM: 4, altFt: 6000 } }));
    const box = await radar.box();
    const halfMin = Math.min(box.width, box.height) / 2;

    const c0 = await radar.settle();
    expect(await radar.pressedRange()).toBe('30');
    expect(await radar.rangeNM()).toBe(Math.round(halfMin / c0.zoom));
    const p0 = await sim.screenPos('UAL9');
    const q0 = await sim.screenPos('DLH4');
    const sep0 = Math.hypot(p0!.x - q0!.x, p0!.y - q0!.y);

    // wheel up over an empty spot: zoom x1.25 anchored at the cursor, presets released, chip range shrinks
    const spot = await sim.emptySpot();
    const anchorWorld = { x: c0.x + (spot.x - box.width / 2) * (1852 / c0.zoom), y: c0.y - (spot.y - box.height / 2) * (1852 / c0.zoom) };
    await radar.wheel(-300, spot);
    await expect.poll(async () => (await radar.camera()).zoom).toBeCloseTo(c0.zoom * 1.25, 1);
    const c1 = await radar.settle();
    expect(await radar.pressedRange()).toBeNull();
    expect(await radar.rangeNM()).toBe(Math.round(halfMin / c1.zoom));
    expect(await radar.rangeNM()).toBeLessThan(Math.round(halfMin / c0.zoom));
    const p1 = await sim.screenPos('UAL9');
    const q1 = await sim.screenPos('DLH4');
    expect(Math.hypot(p1!.x - q1!.x, p1!.y - q1!.y) / sep0).toBeCloseTo(1.25, 1);
    // the world point under the cursor stayed under the cursor
    const anchorNow = await sim.screenPosOf(anchorWorld);
    expect(anchorNow.x).toBeCloseTo(spot.x, 0);
    expect(anchorNow.y).toBeCloseTo(spot.y, 0);
    // wheel down zooms back out; the toolbar buttons do the same around the centre
    await radar.wheel(300, spot);
    await expect.poll(async () => (await radar.camera()).zoom).toBeCloseTo(c0.zoom, 1);
    await radar.zoomInBtn().click();
    await expect.poll(async () => (await radar.camera()).zoom).toBeCloseTo(c0.zoom * 1.25, 1);
    await radar.zoomOutBtn().click();
    await expect.poll(async () => (await radar.camera()).zoom).toBeCloseTo(c0.zoom, 1);
    const c2 = await radar.settle();
    expect(c2.x).toBeCloseTo(c0.x, -1);
    expect(c2.y).toBeCloseTo(c0.y, -1);

    // centre-on-field puts the scope on the airport; setCamera pins the view exactly (05 §3.2)
    await sim.setCamera({ x: c0.x + 20_000, y: c0.y - 15_000, zoom: c0.zoom });
    const c3 = await radar.settle();
    expect(c3).toMatchObject({ x: c0.x + 20_000, y: c0.y - 15_000 });
    expect(await radar.pressedRange()).toBeNull();
    await radar.centreBtn().click();
    const c4 = await radar.settle();
    expect(Math.hypot(c4.x - c0.x, c4.y - c0.y)).toBeLessThan(50);
    // centerOn(aircraft) puts the symbol at the scope centre and shows no edge arrow
    await sim.centerOn('DLH4');
    const c5 = await radar.settle();
    const d = await sim.aircraftOrFail('DLH4');
    expect(c5.x).toBeCloseTo(d.pos.x, -1);
    expect(c5.y).toBeCloseTo(d.pos.y, -1);
    const pd = await sim.screenPos('DLH4');
    expect(pd!.x).toBeCloseTo(box.width / 2, 0);
    expect(pd!.y).toBeCloseTo(box.height / 2, 0);
  });

  test('drag pan moves the camera by the pointer delta @full', async ({ openGame, sim }) => {
    const game = await openGame({ icao: ICAO, spawn: 'none', position: 'approach' });
    const radar = new RadarPage(game.page, game);
    await radar.waitReady();
    await sim.spawnAt(inbound('UAL9'));
    const c0 = await radar.settle();
    const mPerPx = 1852 / c0.zoom;
    const before = await sim.screenPos('UAL9');

    // drag by (+100, +50) px: world centre moves left / down by the same px converted at k = zoom / 1852 m
    await radar.pan(100, 50);
    const c1 = await radar.settle();
    expect(c1.zoom).toBeCloseTo(c0.zoom, 3);
    expect(c1.x - c0.x).toBeCloseTo(-100 * mPerPx, -2);
    expect(c1.y - c0.y).toBeCloseTo(50 * mPerPx, -2);
    const after = await sim.screenPos('UAL9');
    expect(after!.x - before!.x).toBeCloseTo(100, 0);
    expect(after!.y - before!.y).toBeCloseTo(50, 0);
    expect(await radar.pressedRange()).toBeNull();
    // an empty press + drag never selects anything
    expect((await sim.snapshot()).selectedId).toBeNull();
  });

  test('range presets 30 / 15 / 10 / FNL @full', async ({ openGame, sim }) => {
    const game = await openGame({ icao: ICAO, spawn: 'none', position: 'approach' });
    const radar = new RadarPage(game.page, game);
    await radar.waitReady();
    const box = await radar.box();
    const halfMin = Math.min(box.width, box.height) / 2;
    const full = await radar.settle();
    expect(await radar.pressedRange()).toBe('30');
    await expect(radar.chipRange()).toHaveText(/^\d+ nm$/);

    const r15 = await radar.setRange('15');
    expect(r15.zoom).toBeGreaterThan(full.zoom);
    expect(r15.zoom).toBeCloseTo((halfMin * 0.92) / 15, 1);
    expect(r15.x).toBeCloseTo(full.x, 0);
    expect(r15.y).toBeCloseTo(full.y, 0);
    expect(await radar.rangeNM()).toBe(Math.round(halfMin / r15.zoom));

    const r10 = await radar.setRange('10');
    expect(r10.zoom).toBeGreaterThan(r15.zoom);
    expect(r10.zoom).toBeCloseTo((halfMin * 0.92) / 10, 1);
    expect(await radar.rangeNM()).toBeLessThan(Math.round(halfMin / r15.zoom));
    for (const p of ['30', '15', 'final'] as const) await expect(radar.rangeBtn(p)).toHaveAttribute('aria-pressed', 'false');

    // FNL: a 6.5 NM circle around the point 5 NM out on the active arrival runway's final
    const fnl = await radar.setRange('final');
    expect(fnl.zoom).toBeGreaterThan(r10.zoom);
    await expect(radar.chipRange()).toHaveText('Final');
    expect(Math.hypot(fnl.x - full.x, fnl.y - full.y)).toBeGreaterThan(3 * 1852);
    await expect(radar.chipRwy()).toHaveText(/27L|27R/);

    const r30 = await radar.setRange('30');
    expect(r30.zoom).toBeCloseTo(full.zoom, 3);
    expect(r30.x).toBeCloseTo(full.x, 0);
    expect(r30.y).toBeCloseTo(full.y, 0);
    await expect(radar.chipRange()).toHaveText(`${Math.round(halfMin / full.zoom)} nm`);
    // any manual zoom releases the preset again
    await radar.zoomInBtn().click();
    await expect(radar.rangeBtn('30')).toHaveAttribute('aria-pressed', 'false');
  });

  test('measure tool: click-click readout in NM with both bearings; click removes it; Esc clears @full', async ({ openGame, sim }) => {
    const game = await openGame({ icao: ICAO, spawn: 'none', position: 'approach' });
    const radar = new RadarPage(game.page, game);
    await radar.waitReady();
    await sim.spawnAt(inbound('UAL9'));
    const cam = await radar.settle();
    const a = await sim.emptySpot();
    const b = { x: a.x + 120, y: a.y };                                   // due east on screen
    const nm = 120 / cam.zoom;

    await expect(radar.measureBtn()).toHaveAttribute('data-state', 'off');
    const text = await radar.measure(a, b);
    await expect(radar.measureBtn()).toHaveAttribute('data-state', 'on');
    await expect(radar.view()).toHaveAttribute('data-cursor', 'crosshair');
    const m = /^(\d+\.\d) nm · (\d{3})° \/ (\d{3})°$/.exec(text);
    expect(m, `measure readout "${text}"`).not.toBeNull();
    expect(Number(m![1])).toBeCloseTo(nm, 0);
    expect(Math.abs(Number(m![1]) - nm)).toBeLessThan(0.15);
    expect(m![2]).toBe('090');
    expect(m![3]).toBe('270');
    // the pill sits on the line's midpoint
    const pill = await radar.measurePill(0).boundingBox();
    const boxAbs = await radar.box();
    expect(pill!.x + pill!.width / 2 - boxAbs.x).toBeCloseTo(a.x + 60, -1);

    // a second, vertical measure
    const text2 = await radar.measure({ x: a.x, y: a.y + 40 }, { x: a.x, y: a.y + 40 + 60 });
    const m2 = /^(\d+\.\d) nm · (\d{3})° \/ (\d{3})°$/.exec(text2);
    expect(m2).not.toBeNull();
    expect(Number(m2![1])).toBeCloseTo(60 / cam.zoom, 0);
    expect(m2![2]).toBe('180');
    expect(m2![3]).toBe('360');
    await expect(radar.measurePills()).toHaveCount(2);

    // clicking a pill removes that measure; Esc on the scope clears the rest and disarms the tool
    await radar.measurePill(0).click();
    await expect(radar.measurePills()).toHaveCount(1);
    await radar.canvas().focus();
    await game.page.keyboard.press('Escape');
    await expect(radar.measurePills()).toHaveCount(0);
    await expect(radar.measureBtn()).toHaveAttribute('data-state', 'off');
    // the measure clicks never touched the selection
    expect((await sim.snapshot()).selectedId).toBeNull();
  });
});

test.describe('approach: separation', () => {
  test('separation loss: conflict tint on both strips, STCA card, SYS line, score; a climb restores it @smoke', async ({ openGame, sim }) => {
    const game = await openGame({ icao: ICAO, spawn: 'none', position: 'approach' });
    // two arrivals abeam at 2.5 NM (same heading, same level, not in trail -> no wake case)
    await sim.spawnAt(inbound('UAL9'));
    await sim.spawnAt(inbound('DLH4', { posRel: { fromRunway: '27L', alongNM: -20, offsetNM: -3.5, altFt: 8000 } }));
    const score0 = (await sim.snapshot()).score;
    const radar = new RadarPage(game.page, game);
    expect(await radar.distBetweenNM('UAL9', 'DLH4')).toBeCloseTo(2.5, 1);

    const events = await sim.advance(0.2);
    const loss = events.filter((e) => e.type === 'separation_loss');
    expect(loss).toHaveLength(1);                                         // once per pair, not per tick
    expect(loss[0].message).toMatch(/SEPARATION LOSS: (UAL9 \/ DLH4|DLH4 \/ UAL9) 2\.5 NM \/ 0 ft/);
    const [a, b] = [await sim.aircraftOrFail('UAL9'), await sim.aircraftOrFail('DLH4')];
    expect(a.conflict).toBe(true);
    expect(b.conflict).toBe(true);
    expect((await sim.snapshot()).stats.conf).toBe(2);
    const stca = await sim.stca();
    expect(stca.active).toBe(true);
    expect(stca.pairs.map((p) => [...p].sort())).toEqual([['DLH4', 'UAL9']]);
    expect((await sim.snapshot()).score).toBeLessThan(score0);

    // UI: both strips tinted + STCA tag, the alert card, the bell, the comm log
    for (const cs of ['UAL9', 'DLH4']) {
      await expect(game.strip(cs)).toHaveAttribute('data-conflict', 'true');
      await expect(game.page.getByTestId(`strip-${cs}-alert`)).toHaveText('STCA');
    }
    const card = game.alertStack().getByTestId('stca-alert');
    await expect(card).toBeVisible();
    const item = game.alertStack().locator('[data-testid^="toast-"][data-kind="stca"]');
    await expect(item).toHaveAttribute('data-severity', 'critical');
    await expect(item).toContainText('SEPARATION LOSS');
    await expect(item).toContainText(/2\.5 NM \/ 0 ft/);
    await expect(game.alertsBell()).toHaveAttribute('data-count', /^[1-9]\d*$/);
    await game.waitRadio(/SEPARATION LOSS: (UAL9 \/ DLH4|DLH4 \/ UAL9)/, { who: 'SYS' });
    await game.openPanelFor('UAL9');
    await expect(game.panel()).toHaveAttribute('data-conflict', 'true');
    await expect(game.page.getByTestId('panel-alert-banner')).toHaveAttribute('data-kind', 'stca');
    await expect(game.page.getByTestId('panel-alert-pair-DLH4')).toBeVisible();
    // no second loss event while the pair persists
    expect((await sim.advance(5)).filter((e) => e.type === 'separation_loss')).toHaveLength(0);

    // climb one of them 1000 ft: the conflict clears, the card resolves after the 5 s hold
    await game.sendOk('UAL9 CLIMB 9000');
    await sim.advance(PD);
    expect((await sim.aircraftOrFail('UAL9')).cmdAltitude).toBe(9000);
    await sim.advanceUntilOk('s => s.aircraft.every(a => !a.conflict)', 120);
    await sim.advance(6);
    expect((await sim.stca()).active).toBe(false);
    const stcaAlerts = (await sim.alerts()).filter((x) => x.kind === 'stca');
    expect(stcaAlerts).toHaveLength(1);                                   // one alert for the episode, now resolved
    expect(stcaAlerts[0].resolvedAt).not.toBeNull();
    for (const cs of ['UAL9', 'DLH4']) {
      await expect(game.strip(cs)).toHaveAttribute('data-conflict', 'false');
      await expect(game.page.getByTestId(`strip-${cs}-alert`)).toHaveCount(0);
    }
    await expect(game.alertStack().getByTestId('stca-alert')).toHaveCount(0);
    await expect(game.panel()).not.toHaveAttribute('data-conflict', 'true');
    expect((await sim.snapshot()).stats.conf).toBe(0);
  });

  test('reduced minima: two arrivals established on parallel ILS are not a conflict @full', async ({ openGame, sim }) => {
    const game = await openGame({ icao: ICAO, spawn: 'none', position: 'approach' });
    const radar = new RadarPage(game.page, game);
    // 27L and 27R centrelines are ~0.8 NM apart: well inside the 3 NM radar minimum, same level
    await sim.spawnAt({ callsign: 'BAW12', type: 'A320', kind: 'arrival', phase: 'descent', posRel: { fromRunway: '27L', alongNM: -14, offsetNM: 0, altFt: 3000 }, heading: 270, speedKts: 180, plan: { runway: '27L' }, ils: '27L' });
    await sim.spawnAt({ callsign: 'AFR3', type: 'A320', kind: 'arrival', phase: 'descent', posRel: { fromRunway: '27R', alongNM: -14, offsetNM: 0, altFt: 3000 }, heading: 270, speedKts: 180, plan: { runway: '27R' }, ils: '27R' });
    expect(await radar.distBetweenNM('BAW12', 'AFR3')).toBeLessThan(1.5);

    const ev1 = await sim.advance(2);
    await sim.advanceUntilOk('s => s.aircraft.filter(a => a.ilsCaptured).length === 2', 60);
    const ev2 = await sim.advance(60);
    expect([...ev1, ...ev2].filter((e) => e.type === 'separation_loss')).toEqual([]);
    for (const cs of ['BAW12', 'AFR3']) {
      const v = await sim.aircraftOrFail(cs);
      expect(v.ilsCaptured).toBe(true);
      expect(v.conflict).toBe(false);
      expect(v.stage).toBe('arr_established');
      await expect(game.strip(cs)).toHaveAttribute('data-conflict', 'false');
      await expect(game.page.getByTestId(`strip-${cs}-alert`)).toHaveCount(0);
    }
    expect(await radar.distBetweenNM('BAW12', 'AFR3')).toBeLessThan(3);
    expect((await sim.stca()).active).toBe(false);
    expect((await sim.alerts()).filter((x) => x.kind === 'stca' && x.resolvedAt == null)).toHaveLength(0);
    await expect(game.alertStack().getByTestId('stca-alert')).toHaveCount(0);
    expect((await sim.snapshot()).stats.conf).toBe(0);

    // control: the same geometry with one of them NOT on its ILS is a real loss
    await sim.setState('AFR3', { ilsArmed: false, ilsCaptured: false, gsCaptured: false, assignedRunway: null, navMode: 'heading' });
    const ev3 = await sim.advance(1);
    expect(ev3.filter((e) => e.type === 'separation_loss')).toHaveLength(1);
    expect((await sim.aircraftOrFail('BAW12')).conflict).toBe(true);
    await expect(game.strip('AFR3')).toHaveAttribute('data-conflict', 'true');
  });
});

test.describe('approach: end-to-end, handoff, sequencing (Wave-3 audit additions)', () => {
  /** Arrival on a downwind-ish leg 3 NM south of the 27L centreline, 20 NM out, flying west — the §4.6 A20 start point. */
  function base(cs: string, extra: Partial<SpawnSpec> = {}): SpawnSpec {
    return { callsign: cs, type: 'A320', kind: 'arrival', phase: 'descent', posRel: { fromRunway: '27L', alongNM: -20, offsetNM: -3, altFt: 4000 }, heading: 270, speedKts: 220, plan: { runway: '27L' }, ...extra };
  }

  test('vectors to final by clicks only: heading -> altitude -> speed -> ILS -> established -> handoff at 10 NM -> tower lands it @smoke', async ({ openGame, sim }) => {
    const game = await openGame({ icao: ICAO, spawn: 'none', position: 'approach' });
    const radar = new RadarPage(game.page, game);
    await sim.spawnAt(base('UAL9'));
    await game.openPanelFor('UAL9');
    await expect(game.strip('UAL9')).toHaveAttribute('data-bay', 'INBOUND');
    const stages: string[] = [];
    const note = async () => { const st = (await game.strip('UAL9').getAttribute('data-stage')) ?? ''; if (stages[stages.length - 1] !== st) stages.push(st); };
    await note();

    // 1. intercept heading 295 (right turn, 25 deg to the localizer)
    await game.action('action-heading');
    await game.dial(295, 'R');
    await game.next();
    expect(await game.confirmWarnings()).toEqual([]);
    expect((await game.transmit()).code).toBe('ok_queued');
    await sim.advance(PD);
    expect(angDiff((await sim.aircraftOrFail('UAL9')).targetHeading, 295)).toBeLessThanOrEqual(1);
    await expect(game.metricTarget('hdg')).toHaveAttribute('data-value', '295');
    await game.waitRadio(/Right heading two niner fife/i, { who: 'PILOT', callsign: 'UAL9' });

    // 2. descend to the platform altitude (below the glideslope at the intercept point)
    await game.action('action-altitude');
    await game.ladderAlt(3000);
    await game.next();
    expect((await game.transmit()).code).toBe('ok_queued');
    await sim.advance(PD);
    expect((await sim.aircraftOrFail('UAL9')).cmdAltitude).toBe(3000);
    await expect(game.metricTarget('alt')).toHaveAttribute('data-value', '3000');
    await game.waitRadio(/Descend tree thousand/i, { who: 'PILOT', callsign: 'UAL9' });

    // 3. speed 180 via the quick chip
    await game.action('action-speed');
    await game.ladderSpd(180);
    await game.next();
    expect((await game.transmit()).code).toBe('ok_queued');
    await sim.advance(PD);
    expect((await sim.aircraftOrFail('UAL9')).cmdIas).toBe(180);
    await expect(game.metricTarget('spd')).toHaveAttribute('data-value', '180');

    // 4. ILS clearance (planned runway preselected, no warnings)
    await game.action('action-ils');
    await expect(game.page.getByTestId('picker-runway-27L')).toHaveAttribute('aria-pressed', 'true');
    await game.next();
    expect(await game.confirmWarnings()).toEqual([]);
    expect((await game.transmit()).code).toBe('ok_queued');
    await sim.advance(PD);
    let v = await sim.aircraftOrFail('UAL9');
    expect(v.ilsArmed).toBe(true);
    expect(v.stage).toBe('arr_armed');
    await note();
    await expect(game.strip('UAL9')).toHaveAttribute('data-bay', 'SEQUENCE');
    await expect(game.page.getByTestId('strip-UAL9-box-I')).toHaveAttribute('aria-pressed', 'true');

    // 5. the localizer is captured on the intercept, still outside 10 NM, level at 3000 below the slope
    await sim.advanceUntilOk(pred('UAL9', 'a.ilsCaptured'), 300);
    v = await sim.aircraftOrFail('UAL9');
    expect(v.stage).toBe('arr_established');
    expect(v.altitude).toBeLessThanOrEqual(3100);
    expect((await radar.distToThresholdNM('UAL9', '27L'))!).toBeGreaterThan(10);
    expect((await sim.radio()).some((l) => l.callsign === 'UAL9' && /flown through the localizer/.test(l.text))).toBe(false);
    await note();
    await expect(game.strip('UAL9')).toHaveAttribute('data-bay', 'ESTABLISHED');
    await expect(game.panelStage()).toHaveAttribute('data-stage', 'arr_established');
    await game.waitRadio(/established localizer 27L/i, { who: 'PILOT', callsign: 'UAL9' });
    // the panel now blocks vectors and altitudes (X4 / X8), only speed + land-side actions remain
    await expect(game.actionBtn('action-heading')).toHaveAttribute('data-reason', 'Use Cancel approach (C)');
    await expect(game.actionBtn('action-altitude')).toHaveAttribute('data-reason', 'On glideslope — use Cancel approach');
    await expect(game.actionBtn('action-speed')).toHaveAttribute('data-state', 'enabled');

    // 6. automatic handoff inside 10 NM; the glideslope is captured on the way down
    await sim.advanceUntilOk(pred('UAL9', "a.onFrequency === 'tower'"), 400);
    v = await sim.aircraftOrFail('UAL9');
    expect(v.gsCaptured).toBe(true);
    expect((await radar.distToThresholdNM('UAL9', '27L'))!).toBeLessThanOrEqual(10);
    await note();
    await expect(game.strip('UAL9')).toHaveAttribute('data-bay', 'TO_TOWER');
    await expect(game.page.getByTestId('strip-UAL9-ghost')).toHaveText('TWR');
    await expect(game.page.getByTestId('panel-onfreq-note')).toBeVisible();
    await game.showAllFrequencies();
    await game.waitRadio(/UAL9 contact Heathrow Tower 118\.505/, { who: 'SYS', callsign: 'UAL9' });

    // 7. TOWER: FINAL bay, cleared to land, touchdown, rollout, vacated
    await game.setPosition('tower');
    await expect(game.strip('UAL9')).toHaveAttribute('data-bay', 'FINAL');
    await game.openPanelFor('UAL9');
    await game.action('action-land');
    await game.next();
    const land = await game.transmit();
    expect(land.code).toBe('ok_queued');
    expect(land.tx).toMatch(/runway two seven left, cleared to land/i);
    await sim.advance(PD);
    expect((await sim.aircraftOrFail('UAL9')).landingCleared).toBe(true);
    await expect(game.page.getByTestId('strip-UAL9-box-L')).toHaveAttribute('aria-pressed', 'true');
    await sim.advanceUntilPhase('UAL9', 'landing', 300);
    await note();
    await expect(game.strip('UAL9')).toHaveAttribute('data-stage', /^arr_(final|short_final)$/);
    await sim.advanceUntilPhase('UAL9', 'rollout', 300);
    await note();
    await expect(game.strip('UAL9')).toHaveAttribute('data-bay', 'LANDED_ROLLOUT');
    await game.waitRadio(/touchdown runway 27L/, { who: 'PILOT', callsign: 'UAL9' });
    await sim.advanceUntilOk(`s => s.radio.some(l => l.callsign === 'UAL9' && /runway 27L vacated/.test(l.text))`, 200);
    expect((await sim.runways()).find((r) => r.name === '27L')?.occupied).toBe(false);
    expect((await sim.events()).some((e) => e.type === 'score' && e.data?.type === 'score' && e.data.score.code === 'LANDED' && e.data.score.primary === 'UAL9')).toBe(true);
    expect(stages.filter((x) => x !== 'arr_short_final')).toEqual(['arr_inbound', 'arr_armed', 'arr_established', 'arr_final', 'rollout']);
  });

  test('hand off to tower by clicks (auto handoff off): position picker, readback, TO_TOWER ghost, no late-handoff penalty at 12 NM @full', async ({ openGame, sim }) => {
    const game = await openGame({ icao: ICAO, spawn: 'none', position: 'approach', settings: { autoHandoff: false } });
    const radar = new RadarPage(game.page, game);
    await sim.spawnAt(intercept('BAW12', { ils: '27L' }));
    await sim.advanceUntilOk(pred('BAW12', 'a.ilsCaptured'), 300);
    // no auto handoff: still on approach well inside the usual 10 NM handoff point later on
    await sim.advanceUntilOk(pred('BAW12', 'true'), 1);
    let v = await sim.aircraftOrFail('BAW12');
    expect(v.onFrequency).toBe('approach');
    expect(v.handedTo).toBeNull();
    const d0 = (await radar.distToThresholdNM('BAW12', '27L'))!;
    expect(d0).toBeGreaterThan(11);
    await game.openPanelFor('BAW12');
    await expect(game.strip('BAW12')).toHaveAttribute('data-bay', 'ESTABLISHED');
    await expect(game.page.getByTestId('strip-BAW12-box-F')).toHaveAttribute('aria-pressed', 'false');
    await sim.clearEvents();

    await game.action('action-handoff');
    await expect(game.stepperFor('action-handoff')).toHaveAttribute('data-step-type', 'position');
    await expect(game.page.getByTestId('picker-position-tower')).toHaveAttribute('aria-pressed', 'true');      // next position for an established arrival
    await expect(game.page.getByTestId('picker-position-approach')).toHaveAttribute('data-state', 'disabled');
    await expect(game.page.getByTestId('picker-position-ground')).toHaveAttribute('data-state', 'enabled');
    await game.next();
    await expect(game.confirmSummary()).toContainText(/contact tower one one eight decimal fife zero fife/i);
    expect(await game.confirmWarnings()).toEqual([]);
    const tx = await game.transmit();
    expect(tx.code).toBe('ok_queued');
    expect(tx.tx).toMatch(/contact tower one one eight decimal fife zero fife/i);
    v = await sim.aircraftOrFail('BAW12');
    expect(v.pendingCmds.map((c) => c.kind)).toEqual(['contact']);
    await sim.advance(PD);
    v = await sim.aircraftOrFail('BAW12');
    expect(v.handedTo).toBe('tower');
    expect(v.onFrequency).toBe('approach');                                 // the frequency change takes a couple of seconds
    await game.waitRadio(/Tower one one eight decimal fife zero fife, Speedbird one two/i, { who: 'PILOT', callsign: 'BAW12' });
    await expect(game.page.getByTestId('strip-BAW12-box-F')).toHaveAttribute('aria-pressed', 'true');
    await sim.advanceUntilOk(pred('BAW12', "a.onFrequency === 'tower'"), 30);
    v = await sim.aircraftOrFail('BAW12');
    expect(v.handedTo).toBeNull();
    expect(v.ilsCaptured).toBe(true);
    const ho = (await sim.events()).find((e) => e.type === 'handoff' && e.callsign === 'BAW12');
    expect(ho?.data).toMatchObject({ type: 'handoff', from: 'approach', to: 'tower' });
    expect((await sim.scoreEvents()).some((s) => s.code === 'HANDOFF_LATE')).toBe(false);   // > 4 NM: no penalty
    await expect(game.strip('BAW12')).toHaveAttribute('data-bay', 'TO_TOWER');
    await expect(game.strip('BAW12')).toHaveAttribute('data-onfreq', 'tower');
    await expect(game.page.getByTestId('strip-BAW12-ghost')).toHaveText('TWR');
    await expect(game.page.getByTestId('panel-onfreq-note')).toBeVisible();
    // under the default filter the SYS line is on the tower frequency; ALL shows it
    expect((await game.radioRows()).some((l) => /contact Heathrow Tower/.test(l.text))).toBe(false);
    await game.showAllFrequencies();
    await game.waitRadio(/BAW12 contact Heathrow Tower 118\.505/, { who: 'SYS', callsign: 'BAW12' });
    await game.setPosition('tower');
    await expect(game.strip('BAW12')).toHaveAttribute('data-bay', 'FINAL');
  });

  test('two arrivals in trail on the localizer: a speed reduction keeps 3 NM, no STCA, handoffs in order @full', async ({ openGame, sim }) => {
    const game = await openGame({ icao: ICAO, spawn: 'none', position: 'approach' });
    const radar = new RadarPage(game.page, game);
    // leader 14 NM out, trailer 19 NM out, both on the 27L centreline with the ILS armed; the trailer is 50 kt faster
    await sim.spawnAt({ callsign: 'BAW12', type: 'A320', kind: 'arrival', phase: 'descent', posRel: { fromRunway: '27L', alongNM: -14, offsetNM: 0, altFt: 3000 }, heading: 270, speedKts: 170, plan: { runway: '27L' }, ils: '27L' });
    await sim.spawnAt({ callsign: 'AFR3', type: 'A320', kind: 'arrival', phase: 'descent', posRel: { fromRunway: '27L', alongNM: -19, offsetNM: 0, altFt: 3000 }, heading: 270, speedKts: 220, plan: { runway: '27L' }, ils: '27L' });
    await sim.advance(2);
    const gap0 = await radar.distBetweenNM('BAW12', 'AFR3');
    expect(gap0).toBeCloseTo(5, 0);
    for (const cs of ['BAW12', 'AFR3']) await expect(game.strip(cs)).toHaveAttribute('data-conflict', 'false');

    // slow the trailer to 160 with the speed picker (arr_armed: full TMA rail, 160 quick chip)
    await game.openPanelFor('AFR3');
    await game.action('action-speed');
    await game.ladderSpd(160);
    await game.next();
    await expect(game.confirmSummary()).toContainText(/reduce speed to one six zero knots/i);
    expect((await game.transmit()).code).toBe('ok_queued');
    await sim.advance(PD);
    expect((await sim.aircraftOrFail('AFR3')).cmdIas).toBe(160);
    await expect(game.metricTarget('spd')).toHaveAttribute('data-value', '160');
    await game.waitRadio(/one six zero knots/i, { who: 'PILOT', callsign: 'AFR3' });

    // 2.5 minutes: the pair stays separated (>= 3 NM), never a loss, never a STCA card
    let minGap = 99;
    const losses: string[] = [];
    for (let i = 0; i < 15; i++) {
      const ev = await sim.advance(10);
      for (const e of ev) if (e.type === 'separation_loss') losses.push(e.message);
      minGap = Math.min(minGap, await radar.distBetweenNM('BAW12', 'AFR3'));
    }
    expect(losses).toEqual([]);
    expect(minGap).toBeGreaterThanOrEqual(3);
    expect((await sim.stca()).active).toBe(false);
    await expect(game.alertStack().getByTestId('stca-alert')).toHaveCount(0);
    for (const cs of ['BAW12', 'AFR3']) {
      expect((await sim.aircraftOrFail(cs)).conflict).toBe(false);
      await expect(game.strip(cs)).toHaveAttribute('data-conflict', 'false');
    }
    // the trailer slowed down to its assignment, the leader was handed to tower first (10 NM), the trailer later
    expect((await sim.aircraftOrFail('AFR3')).speed).toBeLessThanOrEqual(165);
    const lead = await sim.aircraftOrFail('BAW12');
    expect(lead.ilsCaptured).toBe(true);
    expect(lead.onFrequency).toBe('tower');
    await expect(game.strip('BAW12')).toHaveAttribute('data-bay', 'TO_TOWER');
    const trail = await sim.aircraftOrFail('AFR3');
    expect(trail.ilsCaptured).toBe(true);
    expect(trail.onFrequency).toBe('approach');
    await expect(game.strip('AFR3')).toHaveAttribute('data-bay', 'ESTABLISHED');
    await sim.advanceUntilOk(pred('AFR3', "a.onFrequency === 'tower'"), 300);
    const hos = (await sim.events()).filter((e) => e.type === 'handoff' && (e.data as { to?: string } | undefined)?.to === 'tower').map((e) => e.callsign);
    expect(hos).toEqual(['BAW12', 'AFR3']);
    expect(await radar.distBetweenNM('BAW12', 'AFR3')).toBeGreaterThanOrEqual(3);
  });

  test('STCA resolved from the alert card: Select opens the subject, a vector from the dial restores separation @full', async ({ openGame, sim }) => {
    const game = await openGame({ icao: ICAO, spawn: 'none', position: 'approach' });
    await sim.spawnAt(inbound('UAL9'));
    await sim.spawnAt(inbound('DLH4', { posRel: { fromRunway: '27L', alongNM: -20, offsetNM: -3.5, altFt: 8000 } }));
    await sim.advance(0.2);
    const al = (await sim.alerts()).find((x) => x.kind === 'stca');
    expect(al).toBeDefined();
    expect([...al!.subjects].sort()).toEqual(['DLH4', 'UAL9']);
    await expect(game.alertCard(al!.id)).toBeVisible();
    await expect(game.alertCard(al!.id)).toHaveAttribute('data-severity', 'critical');
    await expect(game.shell()).toHaveAttribute('data-has-panel', 'false');

    // Select on the card opens the panel on a subject; a second click cycles to the other one
    await game.alertCardSelect(al!.id).click();
    await expect(game.panel()).toHaveAttribute('data-callsign', /^(UAL9|DLH4)$/);
    const first = (await game.panelCallsign().textContent()) ?? '';
    await game.alertCardSelect(al!.id).click();
    await expect(game.panelCallsign()).not.toHaveText(first);
    const subject = (await game.panelCallsign().textContent()) ?? '';
    const other = subject === 'UAL9' ? 'DLH4' : 'UAL9';
    await expect(game.panel()).toHaveAttribute('data-conflict', 'true');
    await expect(game.page.getByTestId(`panel-alert-pair-${other}`)).toBeVisible();

    // vector the selected one away with the dial (right turn, away from the other): the loss ends, the card resolves
    await game.action('action-heading');
    await game.dial(subject === 'UAL9' ? 180 : 360, subject === 'UAL9' ? 'R' : 'L');
    await game.next();
    const tx = await game.transmit();
    expect(tx.code).toBe('ok_queued');
    await sim.advance(PD);
    expect((await sim.aircraftOrFail(subject)).navMode).toBe('heading');
    await sim.advanceUntilOk('s => s.aircraft.every(a => !a.conflict)', 180);
    await sim.advance(6);
    expect((await sim.stca()).active).toBe(false);
    expect((await sim.alertById(al!.id))?.resolvedAt).not.toBeNull();
    await expect(game.alertCard(al!.id)).toHaveCount(0);
    for (const c of ['UAL9', 'DLH4']) {
      await expect(game.strip(c)).toHaveAttribute('data-conflict', 'false');
      await expect(game.page.getByTestId(`strip-${c}-alert`)).toHaveCount(0);
    }
    await expect(game.panel()).not.toHaveAttribute('data-conflict', 'true');
    await expect(game.page.getByTestId(`panel-alert-pair-${other}`)).toHaveCount(0);
  });

  test('vector while the ILS is armed: soft "Cancels ILS clearance" warning, hold-to-transmit disarms the ILS @full', async ({ openGame, sim }) => {
    const game = await openGame({ icao: ICAO, spawn: 'none', position: 'approach' });
    await sim.spawnAt(intercept('BAW12', { ils: '27L' }));
    await game.openPanelFor('BAW12');
    await expect(game.panelStage()).toHaveAttribute('data-stage', 'arr_armed');
    const atcBefore = (await sim.radio()).filter((l) => l.who === 'ATC').length;

    await game.action('action-heading');
    await game.dial(320, 'R');
    await game.next();
    expect(await game.confirmWarnings()).toContain('Cancels ILS clearance');
    await expect(game.transmitAnyway()).toBeVisible();
    await expect(game.page.getByTestId('confirm-transmit')).toHaveCount(0);
    // a plain click on the amber button does not transmit (600 ms hold required)
    await game.transmitAnyway().click();
    await expect(game.stepperFor('action-heading')).toBeVisible();
    expect((await sim.radio()).filter((l) => l.who === 'ATC')).toHaveLength(atcBefore);
    expect((await sim.aircraftOrFail('BAW12')).pendingCmds).toEqual([]);

    const tx = await game.holdTransmitAnyway();
    expect(tx.status).toBe('ok');
    expect(tx.code).toBe('ok_queued');
    expect(tx.tx).toMatch(/turn right heading tree two zero/i);
    await sim.advance(PD);
    const v = await sim.aircraftOrFail('BAW12');
    expect(v.ilsArmed).toBe(false);
    expect(v.ilsCaptured).toBe(false);
    expect(v.navMode).toBe('heading');
    expect(angDiff(v.targetHeading, 320)).toBeLessThanOrEqual(1);
    expect(v.stage).toBe('arr_inbound');
    await expect(game.panelStage()).toHaveAttribute('data-stage', 'arr_inbound');
    await expect(game.strip('BAW12')).toHaveAttribute('data-bay', 'INBOUND');
    await expect(game.page.getByTestId('strip-BAW12-box-I')).toHaveAttribute('aria-pressed', 'false');
    await game.waitRadio(/right heading tree two zero/i, { who: 'PILOT', callsign: 'BAW12' });
  });
});
