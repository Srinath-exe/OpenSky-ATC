/*
  GROUND position by clicks through the CommandPanel (05-TEST-STRATEGY §4.4 G-series, adapted to the
  Wave-2 command tree: actions -> stepper -> pickers -> confirm -> TRANSMIT).

  Every scenario boots `/play?icao=EGLL&seed=7&spawn=none&test=1&position=ground`, builds its own traffic with
  `sim.spawnAt`, drives the REAL panel / strips / comm log, and asserts BOTH the engine (sim fixture) and the DOM.
  Sim time only moves through `sim.advance*` (pilot delay is a fixed 3 s in test mode).

  EGLL facts the scenarios rely on (seed 7, all ends active):
    stand 512  Terminal 5, needs pushback, west of the field         -> taxi to 27L is a single-hold route (departure entry)
    stand CRP  cargo, no pushback (start-up only)                    -> taxi to 27R via A1, one hold (departure entry)
    stand 401  Terminal 4, SOUTH of 27L                              -> taxi to 27R crosses 27L: holds = [27L crossing, 27R entry]
    stand 402  next to 401 (within 300 m)                            -> give-way partner
    taxiway S3 first leg out of Terminal 4, before the 27L crossing  -> hold-short-of-taxiway insertion point

  Wave-3 audit additions (end of the describe block): the full departure by clicks only (pushback facing picker ->
  start-up -> taxi via the REQ answer -> holding point -> contact tower with autoHandoff off), the request band
  (Standby / Unable / answer), the runway crossing that needs a clearance ("request cross"), the "contact tower at
  the holding point" route chip, and a fixme for re-arming a pre-cleared crossing with Hold short of runway.
*/
import { test, expect } from './fixtures/test';
import type { SimApi, AircraftView } from './fixtures/test';
import type { GamePage } from './pages/GamePage';
import { VehiclePanelPage } from './pages/VehiclePanelPage';

const GROUND = { icao: 'EGLL', spawn: 'none', position: 'ground' } as const;
const PUSH_STAND = '512';
const NOPUSH_STAND = 'CRP';
const T4_STAND = '401';
const T4_NEXT_STAND = '402';
/** Pilot delay (3 s in test mode) plus one step of slack. */
const PILOT = 3.2;

interface HoldRow { runway: string; at: number; dep: boolean }
interface XY { x: number; y: number }

async function holdsOf(sim: SimApi, cs: string): Promise<HoldRow[]> {
  const st = await sim.state(cs);
  return (st?.path?.holds ?? []).map((h) => ({ runway: h.runway, at: Math.round(h.at), dep: h.isDepartureEntry }));
}
const dist = (a: XY, b: XY) => Math.hypot(a.x - b.x, a.y - b.y);
const hdgDelta = (a: number, b: number) => Math.abs((((a - b) % 360) + 540) % 360 - 180);

function spawnParked(sim: SimApi, cs: string, gate: string, runway: string): Promise<AircraftView> {
  return sim.spawnAt({ callsign: cs, type: 'A320', kind: 'departure', phase: 'parked', gate, plan: { runway } });
}
/** Departure at the stand's entry node, engines running, NO taxi clearance yet (stage taxi_out, empty path). */
function spawnReadyToTaxi(sim: SimApi, cs: string, gate: string): Promise<AircraftView> {
  return sim.spawnAt({ callsign: cs, type: 'A320', kind: 'departure', phase: 'taxi', gate });
}
async function expectInBay(game: GamePage, cs: string, bay: string): Promise<void> {
  await expect(game.strip(cs)).toHaveAttribute('data-bay', bay);
  await expect(game.bay(bay).getByTestId(`strip-${cs}`)).toHaveCount(1);
}
/** Engine-side picture of a ground clearance that does not depend on ids or sim time. */
async function groundSignature(sim: SimApi, cs: string) {
  const a = await sim.aircraftOrFail(cs);
  const st = await sim.state(cs);
  return {
    phase: a.phase, stage: a.stage, runway: a.plan.runway ?? null, taxiRoute: a.taxiRoute, pathTotal: Math.round(a.pathTotal),
    holdReleased: a.holdReleased, takeoffCleared: a.takeoffCleared, holdShortTaxiway: st?.holdShortTaxiway ?? null,
    holds: await holdsOf(sim, cs), pending: a.pendingCmds.map((c) => c.kind), navMode: a.navMode,
  };
}
/** Click-drive "Taxi to runway": runway chip -> AUTO route -> confirm -> TRANSMIT. */
async function clickTaxiToRunway(game: GamePage, rwy: string): Promise<{ status: string | null; code: string | null; tx: string }> {
  await game.action('action-taxi-runway');
  await game.pickRunway(rwy);
  await game.next();
  await game.pickTaxiwayRoute({ auto: true });
  await game.next();
  return game.transmit();
}

test.describe('GROUND position by clicks', () => {
  test('pushback: REQ chip -> answer -> pushback runs with tug events, the aircraft moves and ends on the taxiway @smoke @full', async ({ openGame, sim }) => {
    const game = await openGame(GROUND);
    const cs = 'BAW1';
    const spawned = await spawnParked(sim, cs, PUSH_STAND, '27L');
    const standPos = spawned.pos;
    const standHdg = spawned.heading;
    await expect(game.strip(cs)).toHaveAttribute('data-stage', 'parked');
    await expectInBay(game, cs, 'PENDING');
    await expect(game.stripReq(cs)).toHaveCount(0);

    // the pilot calls for pushback: REQ chip on the strip + PILOT line in the log
    await sim.request(cs, 'pushback');
    await expect(game.stripReq(cs)).toBeVisible();
    await expect(game.stripReq(cs)).toHaveAttribute('data-kind', 'pushback');
    await expect(game.strip(cs)).toHaveAttribute('data-req', 'pushback');
    await game.waitRadio(/request pushback/i, { who: 'PILOT', callsign: cs });
    expect((await sim.aircraftOrFail(cs)).requests.some((r) => r.kind === 'pushback' && r.answeredAt == null)).toBe(true);

    // panel: REQ band with the suggested answer, engine rows agree
    await game.openPanelFor(cs);
    await expect(game.reqBand()).toBeVisible();
    await expect(game.reqBand()).toHaveAttribute('data-request', 'pushback');
    await expect(game.reqAnswer()).toContainText('Pushback approved');
    const rows = await sim.actions(cs);
    expect(rows.find((r) => r.id === 'action-pushback')).toMatchObject({ state: 'enabled', primary: true });
    await expect(game.actionBtn('action-pushback')).toHaveAttribute('data-primary', 'true');

    // one-tap answer lands on the confirm step with the exact transmission
    await game.reqAnswer().click();
    await expect(game.stepperFor('action-pushback')).toHaveAttribute('data-step-type', 'confirm');
    await expect(game.confirmSummary()).toContainText(/pushback approved/i);
    const tx = await game.transmit();
    expect(tx.code).toBe('ok_queued');
    expect(tx.tx).toMatch(/pushback approved/i);
    await expect(game.result()).toHaveAttribute('data-action', 'action-pushback');

    // engine: request answered, pushback queued behind the pilot delay; the REQ chip is gone
    let a = await sim.aircraftOrFail(cs);
    expect(a.pendingCmds.map((c) => c.kind)).toContain('pushback');
    expect(a.requests.every((r) => r.answeredAt != null)).toBe(true);
    await expect(game.stripReq(cs)).toHaveCount(0);
    await expect(game.reqBand()).toHaveCount(0);

    // after the pilot delay: readback, phase pushback, tug connecting
    const ev1 = await sim.advance(PILOT);
    a = await sim.aircraftOrFail(cs);
    expect(a.phase).toBe('pushback');
    expect(a.pushbackStage).toBe('tug_attach');
    expect(ev1.some((e) => e.type === 'pushback' && /tug connecting/i.test(e.message))).toBe(true);
    await game.waitRadio(/pushback approved/i, { who: 'PILOT', callsign: cs });
    await expect(game.strip(cs)).toHaveAttribute('data-stage', 'pushback');
    await expectInBay(game, cs, 'PUSH_START');
    await expect(game.panelStage()).toHaveAttribute('data-stage', 'pushback');

    // tug pushes: the aircraft leaves the stand
    const pushing = await sim.advanceUntil(`s => s.aircraft.find(x => x.callsign === '${cs}')?.pushbackStage === 'pushing'`, 60);
    expect(pushing.ok).toBe(true);
    expect(pushing.events.some((e) => e.type === 'pushback' && /pushing back/i.test(e.message))).toBe(true);
    await sim.advance(25);
    a = await sim.aircraftOrFail(cs);
    expect(a.phase).toBe('pushback');
    expect(dist(a.pos, standPos)).toBeGreaterThan(10);
    await game.waitRadio(/pushing back/i, { who: 'SYS', callsign: cs });

    // tug disconnects: pushback complete, engines running, nose on the taxiway lane
    const done = await sim.advanceUntil(`s => s.aircraft.find(x => x.callsign === '${cs}')?.phase === 'startup'`, 240);
    expect(done.ok).toBe(true);
    const tug = done.events.filter((e) => e.type === 'pushback').map((e) => e.message);
    expect(tug.some((m) => /pushback complete/i.test(m))).toBe(true);
    expect(tug.some((m) => /tug disconnected/i.test(m))).toBe(true);
    a = await sim.aircraftOrFail(cs);
    expect(a.pushbackStage).toBe('complete');
    expect(a.stage).toBe('startup');
    expect(a.speed).toBe(0);
    expect(dist(a.pos, standPos)).toBeGreaterThan(30);
    expect(hdgDelta(a.heading, standHdg)).toBeGreaterThan(45);
    expect((await sim.state(cs))?.path).toBeNull();
    await expect(game.strip(cs)).toHaveAttribute('data-stage', 'startup');
    await expect(game.panelStage()).toHaveAttribute('data-stage', 'startup');
    await expectInBay(game, cs, 'PUSH_START');
    // the taxi clearance is now offered, pushback is no longer on the menu
    await expect(game.actionBtn('action-taxi-runway')).toHaveAttribute('data-state', 'enabled');
    await expect(game.actionBtn('action-pushback')).toHaveCount(0);
  });

  test('startup at a stand without pushback: Start-up approved through the runway picker; stable engines raise the taxi request @full', async ({ openGame, sim }) => {
    const game = await openGame(GROUND);
    const cs = 'BAW3';
    await spawnParked(sim, cs, NOPUSH_STAND, '27R');
    await game.openPanelFor(cs);

    // pushback is not on the menu at this stand; start-up is
    await expect(game.actionBtn('action-pushback')).toHaveAttribute('data-state', 'disabled');
    await expect(game.actionBtn('action-pushback')).toHaveAttribute('data-reason', `Pushback not required at stand ${NOPUSH_STAND}`);
    await expect(game.actionBtn('action-startup')).toHaveAttribute('data-state', 'enabled');

    await game.action('action-startup');
    await expect(game.stepperFor('action-startup')).toHaveAttribute('data-step-type', 'runway');
    await expect(game.page.getByTestId('picker-runway-27R')).toHaveAttribute('aria-pressed', 'true');   // plan.runway is the default
    await game.pickRunway('27R');
    await game.next();
    await expect(game.confirmSummary()).toContainText(/start-up approved/i);
    const tx = await game.transmit();
    expect(tx.code).toBe('ok_queued');

    await sim.advance(PILOT);
    let a = await sim.aircraftOrFail(cs);
    expect(a.phase).toBe('startup');
    expect(a.stage).toBe('startup');
    const st = await sim.state(cs);
    expect(st?.startup.startedAt).not.toBeNull();
    expect(st?.startup.readyAt ?? 0).toBeGreaterThan(st?.startup.startedAt ?? 0);
    await game.waitRadio(/start-up approved/i, { who: 'PILOT', callsign: cs });
    await expect(game.strip(cs)).toHaveAttribute('data-stage', 'startup');
    await expectInBay(game, cs, 'PUSH_START');

    // engines stabilise, the pilot calls ready to taxi on his own
    const ready = await sim.advanceUntil(`s => { const x = s.aircraft.find(x => x.callsign === '${cs}'); return !!x && x.requests.some(r => r.kind === 'taxi' && r.answeredAt == null); }`, 400);
    expect(ready.ok).toBe(true);
    a = await sim.aircraftOrFail(cs);
    expect(a.phase).toBe('startup');
    expect((await sim.state(cs))?.startup.enginesStable).toBe(true);
    await expect(game.stripReq(cs)).toHaveAttribute('data-kind', 'taxi');
    await expect(game.reqBand()).toHaveAttribute('data-request', 'taxi');
    await expect(game.reqAnswer()).toContainText('Taxi to runway');
  });

  test('taxi to runway: runway + AUTO route -> path with holds, the aircraft stops only at the crossing hold, cross releases exactly one hold @smoke @full', async ({ openGame, sim }) => {
    const game = await openGame(GROUND);
    const cs = 'BAW2';
    await spawnReadyToTaxi(sim, cs, T4_STAND);
    await game.openPanelFor(cs);
    await expect(game.panelStage()).toHaveAttribute('data-stage', 'taxi_out');

    // runway picker -> route picker (AUTO) -> confirm
    await game.action('action-taxi-runway');
    await expect(game.stepperFor('action-taxi-runway')).toHaveAttribute('data-step-type', 'runway');
    await game.pickRunway('27R');
    await game.next();
    await expect(game.stepperFor('action-taxi-runway')).toHaveAttribute('data-step-type', 'taxiway-route');
    await expect(game.page.getByTestId('picker-route-dest')).toContainText('27R');
    await expect(game.page.getByTestId('picker-route-chip-auto')).toBeVisible();
    await game.pickTaxiwayRoute({ auto: true });
    await game.next();
    await expect(game.confirmSummary()).toContainText(/taxi to holding point runway two seven right/i);
    const tx = await game.transmit();
    expect(tx.code).toBe('ok_queued');
    expect(tx.tx).toMatch(/taxi to holding point runway two seven right/i);
    await expect(game.page.getByTestId(`strip-${cs}-pending`)).toHaveText('1');

    // the clearance executes after the pilot delay: route + two holds (27L crossing, then the 27R entry)
    await sim.advance(PILOT);
    let a = await sim.aircraftOrFail(cs);
    expect(a.phase).toBe('taxi');
    expect(a.plan.runway).toBe('27R');
    expect(a.taxiRoute.length).toBeGreaterThan(0);
    expect(a.pathTotal).toBeGreaterThan(1000);
    expect(a.holdReleased).toBe(false);
    const holds0 = await holdsOf(sim, cs);
    expect(holds0).toHaveLength(2);
    expect(holds0[0]).toMatchObject({ runway: '27L', dep: false });
    expect(holds0[1]).toMatchObject({ runway: '27R', dep: true });
    await game.waitRadio(/holding point runway two seven right/i, { who: 'PILOT', callsign: cs });
    await expect(game.strip(cs)).toHaveAttribute('data-stage', 'taxi_out');
    await expectInBay(game, cs, 'TAXI_OUT');
    await expect(game.panelRunway()).toHaveText('RWY 27R');
    // while taxiing the panel already offers the crossing and blocks line-up
    await expect(game.actionBtn('action-cross')).toHaveAttribute('data-state', 'enabled');
    await expect(game.actionBtn('action-lineup')).toHaveAttribute('data-reason', 'Not at the holding point yet');

    // the pilot drives to the 27L crossing and stops exactly at the hold node (never earlier)
    const arrived = await sim.advanceUntil(`s => s.aircraft.find(x => x.callsign === '${cs}')?.phase === 'hold_short'`, 600);
    expect(arrived.ok).toBe(true);
    a = await sim.aircraftOrFail(cs);
    expect(a.stage).toBe('hold_short_cross');
    expect(a.holdShortRunway).toBe('27L');
    expect(a.holdShortNode).not.toBeNull();
    expect(Math.abs(a.distAlong - holds0[0].at)).toBeLessThan(25);
    expect(a.distAlong).toBeLessThanOrEqual(holds0[0].at);
    expect(a.holdReleased).toBe(false);
    await sim.advance(5);
    a = await sim.aircraftOrFail(cs);
    expect(a.speed).toBe(0);
    expect(a.phase).toBe('hold_short');
    expect(arrived.events.some((e) => e.type === 'reached_hold' && /holding short runway 27L/i.test(e.message))).toBe(true);
    await expect(game.strip(cs)).toHaveAttribute('data-stage', 'hold_short_cross');
    await expectInBay(game, cs, 'TAXI_OUT');
    await expect(game.panelStage()).toHaveAttribute('data-stage', 'hold_short_cross');
    await expect(game.actionBtn('action-cross')).toHaveAttribute('data-state', 'enabled');
    await expect(game.actionBtn('action-cross')).toHaveAttribute('data-hotkey', 'X');
    await expect(game.actionBtn('action-hold-short')).toHaveAttribute('data-reason', 'Already cleared');
    await expect(game.actionBtn('action-lineup')).toHaveAttribute('data-reason', 'Holding to cross, not to depart');
    await expect(game.actionBtn('action-continue')).toHaveCount(0);   // a runway hold is released by Cross, never by Continue

    // cross runway 27L: locked runway chip, optional expedite, confirm
    await game.action('action-cross');
    await expect(game.page.getByTestId('picker-runway-27L')).toHaveAttribute('aria-pressed', 'true');
    await game.next();
    await expect(game.stepperFor('action-cross')).toHaveAttribute('data-step-type', 'text');
    await game.next();
    await expect(game.confirmSummary()).toContainText(/cross runway two seven left/i);
    const cross = await game.transmit();
    expect(cross.code).toBe('ok_queued');

    await sim.advance(PILOT);
    a = await sim.aircraftOrFail(cs);
    expect(a.holdReleased).toBe(true);                 // the 27L hold is released ...
    expect(a.phase).toBe('taxi');
    expect((await holdsOf(sim, cs)).map((h) => h.runway)).toEqual(['27L', '27R']);   // ... but stays on the path until the line is crossed
    await game.waitRadio(/cross(ing)? (runway )?two seven left/i, { who: 'PILOT', callsign: cs });
    await expect(game.strip(cs)).toHaveAttribute('data-stage', 'taxi_out');

    // past the hold line exactly one hold is consumed and the next one (27R entry) arms itself again
    const past = await sim.advanceUntil(`s => { const x = s.aircraft.find(x => x.callsign === '${cs}'); return !!x && x.distAlong > ${holds0[0].at + 10}; }`, 120);
    expect(past.ok).toBe(true);
    a = await sim.aircraftOrFail(cs);
    const holds1 = await holdsOf(sim, cs);
    expect(holds1).toHaveLength(1);
    expect(holds1[0]).toEqual(holds0[1]);
    expect(a.holdReleased).toBe(false);
    expect(a.phase).toBe('taxi');

    // across the runway (vacated call once the strip is physically clear) and on to the 27R holding point
    const atDep = await sim.advanceUntil(`s => s.aircraft.find(x => x.callsign === '${cs}')?.phase === 'hold_short'`, 600);
    expect(atDep.ok).toBe(true);
    const trip = [...past.events, ...atDep.events];
    expect(trip.some((e) => e.type === 'runway_vacated' && e.callsign === cs && /27L/.test(e.message))).toBe(true);
    await game.waitRadio(/runway .*27L vacated/i, { who: 'PILOT', callsign: cs });
    a = await sim.aircraftOrFail(cs);
    expect(a.stage).toBe('hold_short_dep');
    expect(a.holdShortRunway).toBe('27R');
    expect(Math.abs(a.distAlong - holds0[1].at)).toBeLessThan(25);
    expect(atDep.events.some((e) => e.type === 'reached_hold' && /holding short runway 27R/i.test(e.message))).toBe(true);
    await expect(game.strip(cs)).toHaveAttribute('data-stage', 'hold_short_dep');
    await expectInBay(game, cs, 'AT_HOLD');
  });

  test('route picker: via chips and a hold-short-of pill shape the transmission and the taxi path @full', async ({ openGame, sim }) => {
    const game = await openGame(GROUND);
    const cs = 'BAW4';
    await spawnReadyToTaxi(sim, cs, T4_STAND);
    await game.openPanelFor(cs);

    await game.action('action-taxi-runway');
    await game.pickRunway('27R');
    await game.next();
    await game.pickTaxiwayRoute({ via: ['S3', 'N3'], holdShort: '27L' });
    // the route bar mirrors the picks
    await expect(game.page.getByTestId('picker-route-chip-0')).toHaveText('S3');
    await expect(game.page.getByTestId('picker-route-chip-1')).toHaveText('N3');
    await expect(game.page.getByTestId('picker-route-chip-auto')).toHaveCount(0);
    await expect(game.page.getByTestId('picker-route-pill-0')).toHaveAttribute('data-node', '27L');
    await expect(game.page.getByTestId('picker-route-pill-0')).toContainText('hold short 27L');
    await game.next();
    await expect(game.confirmSummary()).toContainText(/via Sierra three, November three/i);
    await expect(game.confirmSummary()).toContainText(/hold short of runway two seven left/i);
    const tx = await game.transmit();
    expect(tx.code).toBe('ok_queued');
    expect(tx.tx).toMatch(/via Sierra three, November three/i);
    expect(tx.tx).toMatch(/hold short of runway two seven left/i);

    await sim.advance(PILOT);
    const a = await sim.aircraftOrFail(cs);
    expect(a.phase).toBe('taxi');
    expect(a.taxiRoute.slice(0, 2)).toEqual(['S3', 'N3']);
    const holds = await holdsOf(sim, cs);
    expect(holds[0]).toMatchObject({ runway: '27L', dep: false });
    expect(holds[holds.length - 1]).toMatchObject({ runway: '27R', dep: true });
    expect(a.holdReleased).toBe(false);
    const rb = await game.waitRadio(/via Sierra three, November three/i, { who: 'PILOT', callsign: cs });
    expect(rb.text).toMatch(/hold short (of )?(runway )?two seven left/i);
  });

  test('route picker: a cross-runway pill in the taxi clearance removes the crossing hold @full', async ({ openGame, sim }) => {
    const game = await openGame(GROUND);
    const cs = 'BAW5';
    await spawnReadyToTaxi(sim, cs, T4_STAND);
    await game.openPanelFor(cs);

    await game.action('action-taxi-runway');
    await game.pickRunway('27R');
    await game.next();
    await game.pickTaxiwayRoute({ auto: true, cross: ['27L'] });
    await expect(game.page.getByTestId('picker-route-pill-1')).toContainText('cross 27L');
    await game.next();
    await expect(game.confirmSummary()).toContainText(/cross runway two seven left/i);
    const tx = await game.transmit();
    expect(tx.code).toBe('ok_queued');

    await sim.advance(PILOT);
    const a = await sim.aircraftOrFail(cs);
    expect(a.phase).toBe('taxi');
    const holds = await holdsOf(sim, cs);
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({ runway: '27R', dep: true });
    // with the crossing pre-cleared the pilot never stops short of 27L: the first stop is the 27R entry
    const stop = await sim.advanceUntil(`s => s.aircraft.find(x => x.callsign === '${cs}')?.phase === 'hold_short'`, 900);
    expect(stop.ok).toBe(true);
    const b = await sim.aircraftOrFail(cs);
    expect(b.stage).toBe('hold_short_dep');
    expect(b.holdShortRunway).toBe('27R');
    expect(b.distAlong).toBeGreaterThan(2000);   // well past where the 27L hold line used to be (~1.5 km)
    expect(stop.events.filter((e) => e.type === 'reached_hold' && e.callsign === cs)).toHaveLength(1);
    await expect(game.strip(cs)).toHaveAttribute('data-stage', 'hold_short_dep');
  });

  /**
   * Hold short of a TAXIWAY by clicks: text picker (Taxiway... -> S3) -> confirm -> the pilot stops at the S3 hold, ahead of
   * the 27L crossing. Returns the inserted hold and the holds as they were before it.
   */
  async function holdShortOfTaxiwayByClicks(game: GamePage, sim: SimApi, cs: string): Promise<{ before: HoldRow[]; twyHold: HoldRow }> {
    const tx = await clickTaxiToRunway(game, '27R');
    expect(tx.code).toBe('ok_queued');
    await sim.advance(PILOT);
    const before = await holdsOf(sim, cs);
    expect(before.map((h) => h.runway)).toEqual(['27L', '27R']);

    // Hold short of ... -> Taxiway... -> S3 (the leg the aircraft is on, before the 27L crossing)
    await game.action('action-hold-short');
    await expect(game.stepperFor('action-hold-short')).toHaveAttribute('data-step-type', 'text');
    await expect(game.page.getByTestId('picker-holdshort-next')).toHaveAttribute('aria-pressed', 'true');
    await game.page.getByTestId('picker-holdshort-taxiway').click();
    await game.page.getByTestId('picker-holdshort-taxiway-S3').click();
    await game.next();
    await expect(game.confirmSummary()).toContainText(/hold short of taxiway Sierra three/i);
    const hs = await game.transmit();
    expect(hs.code).toBe('ok_queued');

    await sim.advance(PILOT);
    const st = await sim.state(cs);
    expect(st?.holdShortTaxiway).toBe('S3');
    const after = await holdsOf(sim, cs);
    expect(after).toHaveLength(3);
    const twyHold = after.find((h) => h.runway === '');
    expect(twyHold).toBeDefined();
    expect(twyHold!.at).toBeLessThan(before[0].at);   // inserted ahead of the runway crossing
    await game.waitRadio(/hold short (of )?(taxiway )?Sierra three/i, { who: 'PILOT', callsign: cs });

    // the pilot stops at the taxiway hold, not at the runway
    const stop = await sim.advanceUntil(`s => s.aircraft.find(x => x.callsign === '${cs}')?.phase === 'hold_short'`, 600);
    expect(stop.ok).toBe(true);
    let a = await sim.aircraftOrFail(cs);
    expect(Math.abs(a.distAlong - twyHold!.at)).toBeLessThan(25);
    expect(a.distAlong).toBeLessThan(before[0].at - 50);
    expect(a.holdShortRunway).toBeNull();
    await sim.advance(3);
    a = await sim.aircraftOrFail(cs);
    expect(a.speed).toBe(0);
    await expect(game.strip(cs)).toHaveAttribute('data-phase', 'hold_short');
    return { before, twyHold: twyHold! };
  }

  /** After the taxiway hold is released: rolling again, the taxiway hold gone, next stop the 27L crossing. */
  async function expectTaxiwayHoldReleased(game: GamePage, sim: SimApi, cs: string, twyHold: HoldRow): Promise<void> {
    await sim.advance(PILOT);
    let a = await sim.aircraftOrFail(cs);
    expect(a.phase).toBe('taxi');
    expect((await sim.state(cs))?.holdShortTaxiway).toBeNull();
    await sim.advance(15);
    a = await sim.aircraftOrFail(cs);
    expect(a.speed).toBeGreaterThan(1);
    expect(a.distAlong).toBeGreaterThan(twyHold.at + 20);
    await expect(game.strip(cs)).toHaveAttribute('data-stage', 'taxi_out');
    const next = await sim.advanceUntil(`s => s.aircraft.find(x => x.callsign === '${cs}')?.phase === 'hold_short'`, 600);
    expect(next.ok).toBe(true);
    a = await sim.aircraftOrFail(cs);
    expect(a.holdShortRunway).toBe('27L');
    expect(a.stage).toBe('hold_short_cross');
  }

  test('hold short of a taxiway mid-taxi: the pilot stops at the taxiway hold, Continue taxi (clicks) releases it @full', async ({ openGame, sim }) => {
    test.fixme(true, 'BUG: a taxiway hold-short (holdShortTaxiway set, holdShortRunway null) derives stage hold_short_cross (src/lib/sim/stage.ts:80 holdShortStage) and ACTION_MATRIX hides action-continue in that stage (src/lib/sim/commandTree.ts:294), so the aircraft stopped at the taxiway hold can only be released by the typed "CONTINUE TAXI"; the click tree offers "Cross runway 27L" instead, which the engine refuses (not at the 27L holding point yet)');
    const game = await openGame(GROUND);
    const cs = 'BAW6';
    await spawnReadyToTaxi(sim, cs, T4_STAND);
    await game.openPanelFor(cs);
    const { twyHold } = await holdShortOfTaxiwayByClicks(game, sim, cs);

    // Continue taxi is the release for a taxiway hold (Cross is for runways)
    await expect(game.actionBtn('action-continue')).toHaveAttribute('data-state', 'enabled');
    await game.action('action-continue');
    await expect(game.stepperFor('action-continue')).toHaveAttribute('data-step-type', 'confirm');
    await expect(game.confirmSummary()).toContainText(/continue taxi/i);
    const cont = await game.transmit();
    expect(cont.code).toBe('ok_queued');
    await expectTaxiwayHoldReleased(game, sim, cs, twyHold);
  });

  test('hold short of a taxiway mid-taxi: the pilot stops at the taxiway hold, the typed CONTINUE TAXI releases it @full', async ({ openGame, sim }) => {
    const game = await openGame(GROUND);
    const cs = 'BAW6';
    await spawnReadyToTaxi(sim, cs, T4_STAND);
    await game.openPanelFor(cs);
    const { twyHold } = await holdShortOfTaxiwayByClicks(game, sim, cs);
    const rows = await sim.actions(cs);
    expect(rows.find((r) => r.id === 'action-hold-short')).toMatchObject({ state: 'disabled', reasonText: 'Already cleared' });
    await expect(game.actionBtn('action-hold-short')).toHaveAttribute('data-reason', 'Already cleared');

    const cont = await game.sendOk(`${cs} CONTINUE TAXI`);
    expect(cont.text).toMatch(/continue taxi/i);
    await expectTaxiwayHoldReleased(game, sim, cs, twyHold);
    await game.waitRadio(/continue taxi/i, { who: 'PILOT', callsign: cs });
  });

  test('hold position stops a taxiing aircraft; Continue taxi gets it moving again @full', async ({ openGame, sim }) => {
    const game = await openGame(GROUND);
    const cs = 'BAW7';
    await spawnReadyToTaxi(sim, cs, NOPUSH_STAND);
    await game.openPanelFor(cs);
    const tx = await clickTaxiToRunway(game, '27R');
    expect(tx.code).toBe('ok_queued');
    await sim.advance(PILOT + 40);
    let a = await sim.aircraftOrFail(cs);
    expect(a.phase).toBe('taxi');
    expect(a.speed).toBeGreaterThan(5);
    const movingAt = a.distAlong;
    await expect(game.actionBtn('action-continue')).toHaveCount(0);   // nothing to continue from

    await game.action('action-hold-position');
    await expect(game.stepperFor('action-hold-position')).toHaveAttribute('data-step-type', 'confirm');
    await expect(game.confirmSummary()).toContainText(/hold position/i);
    const hold = await game.transmit();
    expect(hold.code).toMatch(/^ok/);
    await sim.advance(1);
    a = await sim.aircraftOrFail(cs);
    expect(a.trafficHold).toBe(true);
    await expect(game.actionBtn('action-continue')).toHaveAttribute('data-state', 'enabled');
    await sim.advance(12);
    a = await sim.aircraftOrFail(cs);
    expect(a.speed).toBe(0);
    expect(a.phase).toBe('taxi');
    const stoppedAt = a.distAlong;
    expect(stoppedAt).toBeGreaterThan(movingAt);
    await game.waitRadio(/hold(ing)? position/i, { who: 'PILOT', callsign: cs });
    await sim.advance(10);
    expect((await sim.aircraftOrFail(cs)).distAlong).toBeCloseTo(stoppedAt, 0);   // really stopped

    await game.action('action-continue');
    await expect(game.confirmSummary()).toContainText(/continue taxi/i);
    const cont = await game.transmit();
    expect(cont.code).toMatch(/^ok/);
    await sim.advance(PILOT + 10);
    a = await sim.aircraftOrFail(cs);
    expect(a.trafficHold).toBe(false);
    expect(a.speed).toBeGreaterThan(1);
    expect(a.distAlong).toBeGreaterThan(stoppedAt + 5);
    await game.waitRadio(/continue taxi/i, { who: 'PILOT', callsign: cs });
    await expect(game.actionBtn('action-continue')).toHaveCount(0);
  });

  test('give way / follow: the typed instruction sets the engine relation to the other aircraft @full', async ({ openGame, sim }) => {
    const game = await openGame(GROUND);
    await spawnReadyToTaxi(sim, 'BAW8', T4_STAND);
    await spawnReadyToTaxi(sim, 'BAW9', T4_NEXT_STAND);
    const other = (await sim.aircraftOrFail('BAW9')).id;
    await game.openPanelFor('BAW8');
    await expect(game.actionBtn('action-giveway')).toHaveAttribute('data-state', 'enabled');
    await expect(game.actionBtn('action-giveway')).toHaveAttribute('data-hotkey', 'J');

    const gw = await game.sendOk('BAW8 GIVE WAY TO BAW9');
    expect(gw.text).toMatch(/give way to the Speedbird niner/i);
    await sim.advance(PILOT);
    let st = await sim.state('BAW8');
    expect(st?.giveWayTo).toBe(other);
    expect(st?.followId).toBeNull();
    await game.waitRadio(/give way/i, { who: 'PILOT', callsign: 'BAW8' });

    const fl = await game.sendOk('BAW8 FOLLOW BAW9');
    expect(fl.text).toMatch(/follow the Speedbird niner/i);
    await sim.advance(PILOT);
    st = await sim.state('BAW8');
    expect(st?.followId).toBe(other);
    expect(st?.giveWayTo).toBeNull();
  });

  test('give way by clicks: the aircraft picker lists the nearby traffic @full', async ({ openGame, sim }) => {
    test.fixme(true, 'BUG: actionCtxFromEngine never fills ActionCtx.nearbyAircraft (src/lib/sim/dispatch.ts:378 hard-codes []), so the give-way / follow aircraft picker is always empty ("No traffic nearby") and the click flow cannot be completed');
    const game = await openGame(GROUND);
    await spawnReadyToTaxi(sim, 'BAW8', T4_STAND);
    await spawnReadyToTaxi(sim, 'BAW9', T4_NEXT_STAND);
    const other = (await sim.aircraftOrFail('BAW9')).id;
    await game.openPanelFor('BAW8');
    await game.action('action-giveway');
    await expect(game.stepperFor('action-giveway')).toHaveAttribute('data-step-type', 'aircraft');
    await expect(game.page.getByTestId('picker-aircraft-BAW9')).toBeVisible();
    await game.pickAircraft('BAW9');
    await game.next();
    await expect(game.stepperFor('action-giveway')).toHaveAttribute('data-step-type', 'text');
    await game.next();
    await expect(game.confirmSummary()).toContainText(/give way to the Speedbird niner/i);
    const tx = await game.transmit();
    expect(tx.code).toBe('ok_queued');
    await sim.advance(PILOT);
    expect((await sim.state('BAW8'))?.giveWayTo).toBe(other);
  });

  test('arrival taxi-in: REQ chip -> gate picker -> route -> the aircraft reaches the stand @smoke @full', async ({ openGame, sim }) => {
    const game = await openGame(GROUND);
    const cs = 'DAL5';
    await sim.spawnAt({ callsign: cs, type: 'B738', kind: 'arrival', phase: 'rollout', runway: '27L', plan: { gateRef: PUSH_STAND } });
    // rollout -> vacate -> handed to ground -> "request taxi to stand"
    const req = await sim.advanceUntil(`s => { const x = s.aircraft.find(x => x.callsign === '${cs}'); return !!x && x.onFrequency === 'ground' && x.requests.some(r => r.kind === 'taxi_in' && r.answeredAt == null); }`, 300);
    expect(req.ok).toBe(true);
    let a = await sim.aircraftOrFail(cs);
    expect(a.phase).toBe('taxi');
    expect(a.stage).toBe('taxi_in');
    expect(a.pathTotal).toBe(0);
    await expect(game.strip(cs)).toHaveAttribute('data-kind', 'arrival');
    await expectInBay(game, cs, 'TAXI_IN');
    await expect(game.stripReq(cs)).toHaveAttribute('data-kind', 'taxi_in');

    await game.openPanelFor(cs);
    await expect(game.reqBand()).toHaveAttribute('data-request', 'taxi_in');
    await expect(game.reqAnswer()).toContainText('Taxi to stand');
    await expect(game.actionBtn('action-taxi-stand')).toHaveAttribute('data-primary', 'true');
    await expect(game.actionBtn('action-taxi-runway')).toHaveCount(0);   // arrivals never get "taxi to runway" here

    // full stepper: gate picker (assigned stand pre-selected) -> pick a different free stand -> AUTO route -> confirm
    await game.action('action-taxi-stand');
    await expect(game.stepperFor('action-taxi-stand')).toHaveAttribute('data-step-type', 'gate');
    await expect(game.page.getByTestId(`picker-gate-${PUSH_STAND}`)).toHaveAttribute('aria-pressed', 'true');
    await expect(game.page.getByTestId('picker-gate-511')).toHaveAttribute('data-state', 'enabled');
    await game.pickGate('511');
    await expect(game.page.getByTestId('picker-gate-511')).toHaveAttribute('aria-pressed', 'true');
    await game.next();
    await expect(game.stepperFor('action-taxi-stand')).toHaveAttribute('data-step-type', 'taxiway-route');
    await expect(game.page.getByTestId('picker-route-dest')).toContainText('511');
    await game.pickTaxiwayRoute({ auto: true });
    await game.next();
    await expect(game.confirmSummary()).toContainText(/taxi to stand fife one one/i);
    const tx = await game.transmit();
    expect(tx.code).toBe('ok_queued');
    await expect(game.stripReq(cs)).toHaveCount(0);

    await sim.advance(PILOT);
    a = await sim.aircraftOrFail(cs);
    expect(a.plan.gateRef).toBe('511');
    expect(a.pathTotal).toBeGreaterThan(100);
    expect(a.taxiRoute.length).toBeGreaterThan(0);
    await game.waitRadio(/stand fife one one/i, { who: 'PILOT', callsign: cs });
    await expect(game.panelStand()).toHaveText('STAND 511');

    const parked = await sim.advanceUntil(`s => s.aircraft.find(x => x.callsign === '${cs}')?.phase === 'arrived'`, 600);
    expect(parked.ok).toBe(true);
    expect(parked.events.some((e) => e.type === 'arrived' && e.callsign === cs)).toBe(true);
    a = await sim.aircraftOrFail(cs);
    expect(a.stage).toBe('arrived');
    expect(a.speed).toBe(0);
    await expect(game.strip(cs)).toHaveAttribute('data-stage', 'arrived');
    await expectInBay(game, cs, 'AT_STAND');
  });

  test('amend route mid-taxi replaces the taxi route @full', async ({ openGame, sim }) => {
    const game = await openGame(GROUND);
    const cs = 'BAW10';
    await spawnReadyToTaxi(sim, cs, T4_STAND);
    await game.openPanelFor(cs);
    const tx = await clickTaxiToRunway(game, '27R');
    expect(tx.code).toBe('ok_queued');
    await sim.advance(PILOT + 5);
    let a = await sim.aircraftOrFail(cs);
    expect(a.taxiRoute[0]).toBe('S3');
    const oldTotal = a.pathTotal;

    // T is "Amend route" while taxiing out
    await expect(game.actionBtn('action-amend-route')).toHaveAttribute('data-hotkey', 'T');
    await game.action('action-amend-route');
    await expect(game.stepperFor('action-amend-route')).toHaveAttribute('data-step-type', 'taxiway-route');
    await game.pickTaxiwayRoute({ via: ['S1'] });
    await expect(game.page.getByTestId('picker-route-chip-0')).toHaveText('S1');
    await game.next();
    await expect(game.confirmSummary()).toContainText(/via Sierra one/i);
    const am = await game.transmit();
    expect(am.code).toBe('ok_queued');
    expect(am.tx).toMatch(/runway two seven right via Sierra one/i);

    await sim.advance(PILOT);
    a = await sim.aircraftOrFail(cs);
    expect(a.phase).toBe('taxi');
    expect(a.plan.runway).toBe('27R');
    expect(a.taxiRoute[0]).toBe('S1');
    expect(Math.abs(a.pathTotal - oldTotal)).toBeGreaterThan(50);
    expect(a.holdReleased).toBe(false);
    await game.waitRadio(/via Sierra one/i, { who: 'PILOT', callsign: cs });
    await sim.advance(30);
    expect((await sim.aircraftOrFail(cs)).speed).toBeGreaterThan(1);
  });

  test('disabled actions carry data-reason and every visible row mirrors the engine @full', async ({ openGame, sim }) => {
    const game = await openGame(GROUND);
    await spawnParked(sim, 'BAW1', PUSH_STAND, '27L');
    await spawnReadyToTaxi(sim, 'BAW2', T4_STAND);

    const check = async (cs: string) => {
      const rows = await sim.actions(cs);
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        const b = game.actionBtn(r.id);
        await expect(b).toHaveAttribute('data-state', r.state);
        await expect(b).toHaveAttribute('data-reason', r.reasonText);
        await expect(b).toHaveAttribute('data-hotkey', r.hotkey ?? '');
        if (r.state === 'disabled') await expect(b).toBeDisabled();
      }
      return rows;
    };

    await game.openPanelFor('BAW1');
    const parked = await check('BAW1');
    expect(parked.find((r) => r.id === 'action-taxi-runway')).toMatchObject({ state: 'disabled', reasonText: 'Push back first' });
    expect(parked.find((r) => r.id === 'action-startup')).toMatchObject({ state: 'disabled', reasonText: 'Use Pushback' });
    await expect(game.actionBtn('action-taxi-runway')).toHaveAttribute('data-reason', 'Push back first');
    await expect(game.actionBtn('action-startup')).toHaveAttribute('data-reason', 'Use Pushback');
    await expect(game.actionBtn('action-lineup')).toHaveCount(0);   // hidden cells are not rendered
    // a disabled row never opens a stepper
    await game.actionBtn('action-taxi-runway').click({ force: true });
    await expect(game.stepper()).toHaveCount(0);

    await game.openPanelFor('BAW2');
    const taxi = await check('BAW2');
    expect(taxi.find((r) => r.id === 'action-lineup')).toMatchObject({ state: 'disabled', reasonText: 'Not at the holding point yet' });
    expect(taxi.find((r) => r.id === 'action-takeoff')).toMatchObject({ state: 'disabled', reasonText: 'Not at the holding point yet' });
    await expect(game.actionBtn('action-lineup')).toHaveAttribute('data-reason', 'Not at the holding point yet');

    // pausing disables everything with the same reason in the engine and the DOM
    await game.togglePause();
    await expect(game.page.getByTestId('panel-paused-note')).toBeVisible();
    const pausedRows = await sim.actions('BAW2');
    expect(pausedRows.every((r) => r.state === 'disabled' && r.reasonText === 'Paused')).toBe(true);
    await expect(game.actionBtn('action-taxi-runway')).toHaveAttribute('data-reason', 'Paused');
    await game.togglePause();
    await expect(game.actionBtn('action-taxi-runway')).toHaveAttribute('data-state', 'enabled');
  });

  test('hotkeys open the matching stepper and a second press cycles the family @full', async ({ openGame, sim }) => {
    const game = await openGame(GROUND);
    await spawnParked(sim, 'BAW1', PUSH_STAND, '27L');
    await spawnReadyToTaxi(sim, 'BAW2', T4_STAND);

    await game.openPanelFor('BAW2');
    await expect(game.actionBtn('action-hold-short')).toHaveAttribute('data-hotkey', 'H');
    await game.hotkey('h');
    await expect(game.stepperFor('action-hold-short')).toBeVisible();
    await expect(game.panel()).toHaveAttribute('data-draft', 'action-hold-short');
    await game.hotkey('Escape');
    await expect(game.stepper()).toHaveCount(0);

    // T owns "Amend route" while taxiing out; pressing T again cycles to "Taxi to runway"
    await game.hotkey('t');
    await expect(game.stepperFor('action-amend-route')).toBeVisible();
    await game.hotkey('t');
    await expect(game.stepperFor('action-taxi-runway')).toBeVisible();
    await expect(game.stepperFor('action-amend-route')).toHaveCount(0);
    await game.hotkey('Escape');
    await expect(game.stepper()).toHaveCount(0);

    await game.hotkey('j');
    await expect(game.stepperFor('action-giveway')).toBeVisible();
    await game.hotkey('Escape');
    await expect(game.stepper()).toHaveCount(0);
    // a letter nobody owns in this stage does nothing
    await game.hotkey('o');
    await expect(game.stepper()).toHaveCount(0);

    // parked: P is pushback
    await game.openPanelFor('BAW1');
    await game.hotkey('p');
    await expect(game.stepperFor('action-pushback')).toBeVisible();
    await expect(game.stepperFor('action-pushback')).toHaveAttribute('data-step-type', 'runway');
    await game.hotkey('Escape');
    await expect(game.stepper()).toHaveCount(0);
    await expect(game.panel()).toHaveAttribute('data-callsign', 'BAW1');
  });

  test('Esc / Backspace stepper navigation: Backspace steps back keeping the picks, Esc cancels, Esc again deselects @full', async ({ openGame, sim }) => {
    const game = await openGame(GROUND);
    const cs = 'BAW2';
    await spawnReadyToTaxi(sim, cs, T4_STAND);
    await game.openPanelFor(cs);

    await game.action('action-taxi-runway');
    await expect(game.stepperFor('action-taxi-runway')).toHaveAttribute('data-step', '0');
    await game.pickRunway('27R');
    await game.next();
    await expect(game.stepperFor('action-taxi-runway')).toHaveAttribute('data-step', '1');
    await expect(game.picker('route')).toBeVisible();

    await game.hotkey('Backspace');
    await expect(game.stepperFor('action-taxi-runway')).toHaveAttribute('data-step', '0');
    await expect(game.page.getByTestId('picker-runway-27R')).toHaveAttribute('aria-pressed', 'true');
    await game.next();
    await expect(game.stepperFor('action-taxi-runway')).toHaveAttribute('data-step', '1');
    // the Back button does the same as Backspace
    await game.back();
    await expect(game.stepperFor('action-taxi-runway')).toHaveAttribute('data-step', '0');

    await game.hotkey('Escape');
    await expect(game.stepper()).toHaveCount(0);
    await expect(game.panel()).toHaveAttribute('data-callsign', cs);
    await expect(game.panel()).not.toHaveAttribute('data-draft', /.+/);
    await expect(game.panelActions()).toBeVisible();
    expect((await sim.aircraftOrFail(cs)).pendingCmds).toHaveLength(0);   // nothing was transmitted

    await game.hotkey('Escape');
    await expect(game.shell()).toHaveAttribute('data-has-panel', 'false');
    expect((await sim.snapshot()).selectedId).toBeNull();
  });

  test('UNDO within the window reverts a queued taxi clearance (chip and U hotkey); the window closes at the readback @full', async ({ openGame, sim }) => {
    const game = await openGame(GROUND);
    const cs = 'BAW2';
    await spawnReadyToTaxi(sim, cs, T4_STAND);
    await game.openPanelFor(cs);

    // 1. click flow, undo through the panel chip
    const tx = await clickTaxiToRunway(game, '27R');
    expect(tx.code).toBe('ok_queued');
    let a = await sim.aircraftOrFail(cs);
    expect(a.pendingCmds.map((c) => c.kind)).toEqual(['taxi']);
    await expect(game.undoChip()).toBeVisible();
    await expect(game.page.getByTestId('panel-result-undo-window')).toContainText(/undo/i);
    const atcLine = await game.waitRadio(/taxi to holding point/i, { who: 'ATC', callsign: cs });
    await expect(game.page.locator(`[data-testid="radio-line"][data-key="${atcLine.key}"]`)).toHaveAttribute('data-status', 'pending');

    await game.undoChip().click();
    await expect(game.undoChip()).toHaveCount(0);
    a = await sim.aircraftOrFail(cs);
    expect(a.pendingCmds).toHaveLength(0);
    await expect(game.page.locator(`[data-testid="radio-line"][data-key="${atcLine.key}"]`)).toHaveAttribute('data-status', 'undone');
    await game.waitRadio(/disregard/i, { who: 'ATC', callsign: cs });
    await sim.advance(PILOT + 2);
    a = await sim.aircraftOrFail(cs);
    expect(a.pathTotal).toBe(0);
    expect(a.taxiRoute).toEqual([]);
    expect(a.phase).toBe('taxi');
    expect(a.speed).toBe(0);

    // 2. typed flow, undo with the U hotkey
    await game.sendOk(`${cs} TAXI RUNWAY 27R`);
    expect((await sim.aircraftOrFail(cs)).pendingCmds.map((c) => c.kind)).toEqual(['taxi']);
    await expect(game.undoChip()).toBeVisible();
    await game.hotkey('U');
    await expect(game.undoChip()).toHaveCount(0);
    expect((await sim.aircraftOrFail(cs)).pendingCmds).toHaveLength(0);
    await sim.advance(PILOT + 2);
    expect((await sim.aircraftOrFail(cs)).pathTotal).toBe(0);

    // 3. the ring closes once the pilot reads back: the clearance executes and nothing is undoable
    await game.sendOk(`${cs} TAXI RUNWAY 27R`);
    await sim.advance(PILOT);
    a = await sim.aircraftOrFail(cs);
    expect(a.pathTotal).toBeGreaterThan(1000);
    expect(a.pendingCmds).toHaveLength(0);
    await expect(game.undoChip()).toHaveCount(0);
    await game.hotkey('U');
    await sim.advance(1);
    expect((await sim.aircraftOrFail(cs)).pathTotal).toBeGreaterThan(1000);
    const undone = (await sim.radio()).filter((l) => l.status === 'undone');
    expect(undone).toHaveLength(2);
  });

  test('typed command and click stepper produce identical engine state and transmission @full', async ({ openGame, sim }) => {
    const game = await openGame(GROUND);
    const cs = 'BAW2';

    // A. clicks
    await spawnReadyToTaxi(sim, cs, T4_STAND);
    await game.openPanelFor(cs);
    const clicked = await clickTaxiToRunway(game, '27R');
    expect(clicked.code).toBe('ok_queued');
    const clickTx = (await game.waitRadio(/taxi to holding point/i, { who: 'ATC', callsign: cs })).text;
    await sim.advance(PILOT);
    const viaClicks = await groundSignature(sim, cs);
    expect(viaClicks.phase).toBe('taxi');
    expect(viaClicks.holds.map((h) => h.runway)).toEqual(['27L', '27R']);
    await game.closePanel();
    await sim.remove(cs);
    await expect(game.strip(cs)).toHaveCount(0);

    // B. the same clearance typed into the comm log, same stand, same runway
    await spawnReadyToTaxi(sim, cs, T4_STAND);
    const typed = await game.sendOk(`${cs} TAXI RUNWAY 27R`);
    await sim.advance(PILOT);
    const viaText = await groundSignature(sim, cs);

    expect(typed.text).toBe(clickTx);
    expect(viaText).toEqual(viaClicks);
  });

  test('strip bay bays follow a departure through its ground stages @full', async ({ openGame, sim }) => {
    const game = await openGame(GROUND);
    const cs = 'BAW1';
    await spawnParked(sim, cs, PUSH_STAND, '27L');
    await expectInBay(game, cs, 'PENDING');
    await expect(game.page.getByTestId('bay-count-PENDING')).toHaveText('1');
    await expect(game.page.getByTestId('bay-count-TAXI_OUT')).toHaveText('0');
    await expect(game.bayTotal()).toHaveAttribute('data-value', '1');

    await game.sendOk(`${cs} PUSHBACK APPROVED`);
    await sim.advance(PILOT);
    await expect(game.strip(cs)).toHaveAttribute('data-stage', 'pushback');
    await expectInBay(game, cs, 'PUSH_START');
    await expect(game.page.getByTestId('bay-count-PENDING')).toHaveText('0');
    await expect(game.page.getByTestId('bay-count-PUSH_START')).toHaveText('1');

    await sim.advanceUntilOk(`s => s.aircraft.find(x => x.callsign === '${cs}')?.phase === 'startup'`, 240);
    await expect(game.strip(cs)).toHaveAttribute('data-stage', 'startup');
    await expectInBay(game, cs, 'PUSH_START');

    await sim.advanceUntilOk(`s => { const x = s.aircraft.find(x => x.callsign === '${cs}'); return !!x && x.requests.some(r => r.kind === 'taxi' && r.answeredAt == null); }`, 400);
    await expect(game.stripReq(cs)).toHaveAttribute('data-kind', 'taxi');
    await game.sendOk(`${cs} TAXI RUNWAY 27L`);
    await sim.advance(PILOT);
    await expect(game.strip(cs)).toHaveAttribute('data-stage', 'taxi_out');
    await expectInBay(game, cs, 'TAXI_OUT');
    await expect(game.page.getByTestId('bay-count-PUSH_START')).toHaveText('0');
    await expect(game.page.getByTestId('bay-count-TAXI_OUT')).toHaveText('1');

    await sim.advanceUntilOk(`s => s.aircraft.find(x => x.callsign === '${cs}')?.phase === 'hold_short'`, 900);
    const a = await sim.aircraftOrFail(cs);
    expect(a.stage).toBe('hold_short_dep');
    expect(a.onFrequency).toBe('ground');
    await expect(game.strip(cs)).toHaveAttribute('data-stage', 'hold_short_dep');
    await expectInBay(game, cs, 'AT_HOLD');
    await expect(game.page.getByTestId('bay-count-AT_HOLD')).toHaveText('1');

    // auto handoff to tower: the strip leaves the GROUND bays and shows up in TOWER's AT_HOLD
    await sim.advanceUntilOk(`s => s.aircraft.find(x => x.callsign === '${cs}')?.onFrequency === 'tower'`, 60);
    await expect(game.strip(cs)).toHaveCount(0);
    await expect(game.bayTotal()).toHaveAttribute('data-value', '0');
    await game.setPosition('tower');
    await expectInBay(game, cs, 'AT_HOLD');
    await expect(game.strip(cs)).toHaveAttribute('data-onfreq', 'tower');
  });

  test('vehicle panel: dispatch the follow-me to the selected aircraft and it drives towards it @full', async ({ openGame, sim }) => {
    const game = await openGame({ ...GROUND, waitMap: true });
    const veh = new VehiclePanelPage(game.page);
    const cs = 'BAW2';
    await spawnReadyToTaxi(sim, cs, T4_STAND);
    await game.openPanelFor(cs);

    const before = (await sim.vehicles()).find((v) => v.id === 'FOLLOW1');
    expect(before).toMatchObject({ type: 'followme', state: 'standby' });
    await sim.centerOn(cs);

    await veh.open();
    await expect(veh.root()).toHaveAttribute('data-responding', '0');
    await expect(veh.card('FOLLOW1')).toHaveAttribute('data-state', 'standby');
    await veh.startDispatch('FOLLOW1');
    // the selected aircraft is the default target
    await expect(veh.target('aircraft')).toHaveText(cs);
    await expect(veh.target('aircraft')).toHaveAttribute('aria-pressed', 'true');
    const r = await veh.confirmDispatch();
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/Follow-me 1/);
    expect(r.text).toContain(cs);

    // engine: en route to the aircraft (the drive path is planned on the first step); DOM: card + strip bay VEHICLES section
    let v = (await sim.vehicles()).find((x) => x.id === 'FOLLOW1')!;
    expect(v.state).toBe('enroute');
    expect(v.target).toMatchObject({ kind: 'aircraft', callsign: cs });
    await sim.advance(1);
    v = (await sim.vehicles()).find((x) => x.id === 'FOLLOW1')!;
    expect(v.path).not.toBeNull();
    expect(v.path!.total).toBeGreaterThan(500);
    await expect(veh.card('FOLLOW1')).toHaveAttribute('data-state', 'enroute');
    await expect(veh.cardStatus('FOLLOW1')).toHaveAttribute('data-state', 'enroute');
    await expect(veh.root()).toHaveAttribute('data-responding', '1');
    await expect(veh.cardAction('FOLLOW1', 'recall')).toBeVisible();
    await expect(veh.vehicleStrip('FOLLOW1')).toHaveAttribute('data-state', 'enroute');
    await expect(game.bay('VEHICLES').getByTestId('strip-vehicle-FOLLOW1')).toHaveCount(1);

    // its drive path ends at the aircraft; it moves: engine position and projected screen position change over sim time
    const target = (await sim.aircraftOrFail(cs)).pos;
    const pts = v.path!.pts;
    expect(dist(pts[pts.length - 1], target)).toBeLessThan(300);
    const p0 = v.pos;
    const s0 = await sim.screenPosOf(p0);
    await sim.advance(30);
    v = (await sim.vehicles()).find((x) => x.id === 'FOLLOW1')!;
    const s1 = await sim.screenPosOf(v.pos);
    expect(dist(v.pos, p0)).toBeGreaterThan(50);
    expect(v.distAlong).toBeGreaterThan(100);
    expect(v.speed).toBeGreaterThan(1);
    expect(Math.hypot(s1.x - s0.x, s1.y - s0.y)).toBeGreaterThan(3);
    expect(v.state).toBe('enroute');
    await expect(veh.card('FOLLOW1')).toHaveAttribute('data-state', 'enroute');
    await expect(veh.cardEta('FOLLOW1')).toHaveAttribute('data-value', /^\d+$/);

    // recall from the card: the truck turns around
    await veh.recallBtn('FOLLOW1').click();
    await sim.advance(1);
    v = (await sim.vehicles()).find((x) => x.id === 'FOLLOW1')!;
    expect(v.state).toBe('returning');
    await expect(veh.card('FOLLOW1')).toHaveAttribute('data-state', 'returning');
    await veh.close();
    await expect(veh.toolbarBtn()).toHaveAttribute('data-state', 'off');
  });

  // ───────────────────────────────────────────────────────────────────────────
  //  Wave-3 audit additions (05 §4.4 GC1 / GC3 / GC9-GC11 by clicks, §G8 request band, §G2 handoff column)
  // ───────────────────────────────────────────────────────────────────────────

  test('full departure by clicks only: pushback (facing picker) -> start-up -> taxi -> holding point -> contact tower @smoke @full', async ({ openGame, sim }) => {
    // manual handoff so the last step is the player's click, not the engine's auto handoff
    const game = await openGame({ ...GROUND, settings: { autoHandoff: false } });
    const cs = 'BAW1';
    const spawned = await spawnParked(sim, cs, PUSH_STAND, '27L');
    await expectInBay(game, cs, 'PENDING');
    await game.openPanelFor(cs);
    await expect(game.panelStage()).toHaveAttribute('data-stage', 'parked');
    await expect(game.actionBtn('action-taxi-runway')).toHaveAttribute('data-reason', 'Push back first');
    for (const k of ['P', 'T', 'W', 'O', 'F']) await expect(game.page.getByTestId(`strip-${cs}-box-${k}`)).toHaveAttribute('aria-pressed', 'false');

    // 1. pushback: runway picker (27L pre-selected) -> facing picker (compass) -> confirm
    await game.action('action-pushback');
    await expect(game.stepperFor('action-pushback')).toHaveAttribute('data-step-type', 'runway');
    await expect(game.page.getByTestId('picker-runway-27L')).toHaveAttribute('aria-pressed', 'true');
    await game.next();
    await expect(game.stepperFor('action-pushback')).toHaveAttribute('data-step-type', 'direction');
    await expect(game.picker('direction')).toBeVisible();
    await expect(game.page.getByTestId('picker-dir-any')).toHaveAttribute('aria-pressed', 'true');   // "as required" is the default
    await game.pickDirection('W');
    await expect(game.page.getByTestId('picker-dir-any')).not.toHaveAttribute('aria-pressed', 'true');
    await game.next();
    await expect(game.confirmSummary()).toContainText(/pushback approved, face west, expect runway two seven left/i);
    const push = await game.transmit();
    expect(push.code).toBe('ok_queued');
    expect(push.tx).toMatch(/face west/i);
    await expect(game.page.getByTestId(`strip-${cs}-pending`)).toHaveText('1');
    await sim.advance(PILOT);
    let a = await sim.aircraftOrFail(cs);
    expect(a.phase).toBe('pushback');
    expect((await sim.state(cs))?.pushback.facing).toBe('W');
    await game.waitRadio(/pushback approved, facing west, expect runway two seven left/i, { who: 'PILOT', callsign: cs });
    await expect(game.page.getByTestId(`strip-${cs}-box-P`)).toHaveAttribute('aria-pressed', 'true');
    await expectInBay(game, cs, 'PUSH_START');
    await expect(game.actionBtn('action-pushback')).toHaveAttribute('data-reason', 'Already cleared');   // R18 while pushing

    // 2. the tug finishes; engines are started with the push (start-up implied) and the pilot calls for taxi
    await sim.advanceUntilOk(`s => s.aircraft.find(x => x.callsign === '${cs}')?.phase === 'startup'`, 240);
    a = await sim.aircraftOrFail(cs);
    expect(dist(a.pos, spawned.pos)).toBeGreaterThan(30);
    expect((await sim.state(cs))?.startup.startedAt).not.toBeNull();
    await expect(game.panelStage()).toHaveAttribute('data-stage', 'startup');
    await sim.advanceUntilOk(`s => { const x = s.aircraft.find(x => x.callsign === '${cs}'); return !!x && x.requests.some(r => r.kind === 'taxi' && r.answeredAt == null); }`, 400);
    await expect(game.stripReq(cs)).toHaveAttribute('data-kind', 'taxi');
    await game.waitRadio(/Heathrow Ground, .*ready to taxi/i, { who: 'PILOT', callsign: cs });
    await expect(game.reqBand()).toHaveAttribute('data-request', 'taxi');
    await expect(game.actionBtn('action-taxi-runway')).toHaveAttribute('data-primary', 'true');

    // 3. taxi: the REQ answer opens the taxi stepper on the confirm step (runway + AUTO route already resolved)
    await game.reqAnswer().click();
    await expect(game.stepperFor('action-taxi-runway')).toHaveAttribute('data-step-type', 'confirm');
    await expect(game.confirmSummary()).toContainText(/taxi to holding point runway two seven left/i);
    const taxi = await game.transmit();
    expect(taxi.code).toBe('ok_queued');
    await expect(game.stripReq(cs)).toHaveCount(0);
    await sim.advance(PILOT);
    a = await sim.aircraftOrFail(cs);
    expect(a.phase).toBe('taxi');
    expect(a.plan.runway).toBe('27L');
    expect(a.pathTotal).toBeGreaterThan(500);
    const holds = await holdsOf(sim, cs);
    expect(holds[holds.length - 1]).toMatchObject({ runway: '27L', dep: true });
    await game.waitRadio(/holding point runway two seven left/i, { who: 'PILOT', callsign: cs });
    await expectInBay(game, cs, 'TAXI_OUT');
    await expect(game.page.getByTestId(`strip-${cs}-box-T`)).toHaveAttribute('aria-pressed', 'true');
    await expect(game.panelRunway()).toHaveText('RWY 27L');

    // 4. the holding point: stopped at the departure entry, still on ground (no auto handoff), tower actions blocked
    await sim.advanceUntilOk(`s => s.aircraft.find(x => x.callsign === '${cs}')?.stage === 'hold_short_dep'`, 900);
    await sim.advance(3);
    a = await sim.aircraftOrFail(cs);
    expect(a.speed).toBe(0);
    expect(a.holdShortRunway).toBe('27L');
    expect(a.onFrequency).toBe('ground');
    expect(a.handedTo).toBeNull();
    expect(Math.abs(a.distAlong - holds[holds.length - 1].at)).toBeLessThan(25);
    await expectInBay(game, cs, 'AT_HOLD');
    await expect(game.panelStage()).toHaveAttribute('data-stage', 'hold_short_dep');
    await expect(game.actionBtn('action-hold-short')).toHaveAttribute('data-reason', 'Already cleared');
    await game.waitRadio(/holding short runway 27L/i, { who: 'PILOT', callsign: cs });

    // 5. contact tower by clicks: position picker (tower is the next position, ground is greyed out)
    await expect(game.actionBtn('action-handoff')).toHaveAttribute('data-state', 'enabled');
    await game.action('action-handoff');
    await expect(game.stepperFor('action-handoff')).toHaveAttribute('data-step-type', 'position');
    await expect(game.page.getByTestId('picker-position-tower')).toHaveAttribute('aria-pressed', 'true');
    await expect(game.page.getByTestId('picker-position-ground')).toHaveAttribute('data-state', 'disabled');
    await game.next();
    await expect(game.confirmSummary()).toContainText(/contact tower one one eight decimal fife zero fife/i);
    const ho = await game.transmit();
    expect(ho.code).toBe('ok_queued');
    await sim.advance(PILOT);
    a = await sim.aircraftOrFail(cs);
    expect(a.handedTo).toBe('tower');
    await game.waitRadio(/Tower one one eight decimal fife zero fife/i, { who: 'PILOT', callsign: cs });
    await expect(game.page.getByTestId(`strip-${cs}-box-F`)).toHaveAttribute('aria-pressed', 'true');
    await sim.advanceUntilOk(`s => s.aircraft.find(x => x.callsign === '${cs}')?.onFrequency === 'tower'`, 30);
    a = await sim.aircraftOrFail(cs);
    expect(a.handedTo).toBeNull();
    expect(a.stage).toBe('hold_short_dep');
    // the strip has left the GROUND bays; TOWER holds it in AT_HOLD with the same stage
    await expect(game.strip(cs)).toHaveCount(0);
    await expect(game.bayTotal()).toHaveAttribute('data-value', '0');
    await game.showAllFrequencies();
    await game.waitRadio(/contact Heathrow Tower 118\.505/, { who: 'SYS', callsign: cs });
    await game.setPosition('tower');
    await expectInBay(game, cs, 'AT_HOLD');
    await expect(game.strip(cs)).toHaveAttribute('data-onfreq', 'tower');
    await expect(game.strip(cs)).toHaveAttribute('data-stage', 'hold_short_dep');
  });

  test('pilot taxi request: Standby parks the request, Unable answers it, the answer chip transmits the clearance @full', async ({ openGame, sim }) => {
    const game = await openGame(GROUND);
    const cs = 'BAW3';
    await spawnReadyToTaxi(sim, cs, NOPUSH_STAND);
    await sim.request(cs, 'taxi');
    await game.waitRadio(/ready to taxi/i, { who: 'PILOT', callsign: cs });
    await expect(game.stripReq(cs)).toHaveAttribute('data-kind', 'taxi');
    await game.openPanelFor(cs);
    await expect(game.reqBand()).toHaveAttribute('data-request', 'taxi');
    await expect(game.reqAnswer()).toContainText('Taxi to runway');
    await expect(game.reqUnable()).toBeEnabled();
    await expect(game.reqStandby()).toBeEnabled();
    await expect(game.page.getByTestId('panel-req-age')).toBeVisible();

    // STANDBY: immediate result; the request stays open in the engine but is parked for 120 s (chip + band hidden)
    await game.reqStandby().click();
    await expect(game.stepperFor('action-standby')).toHaveAttribute('data-step-type', 'confirm');
    const sb = await game.transmit();
    expect(sb.status).toBe('ok');
    expect(sb.tx).toMatch(/standby/i);
    await game.waitRadio(/standby/i, { who: 'ATC', callsign: cs });
    let a = await sim.aircraftOrFail(cs);
    expect(a.requests).toHaveLength(1);
    expect(a.requests[0].answeredAt).toBeNull();
    expect(a.requests[0].recallAt).toBeCloseTo((await sim.time()) + 120, 0);
    expect((await sim.state(cs))?.standbyUntil).toBeCloseTo((await sim.time()) + 120, 0);
    await expect(game.stripReq(cs)).toHaveCount(0);
    await expect(game.reqBand()).toHaveCount(0);
    await expect(game.strip(cs)).not.toHaveAttribute('data-req', 'taxi');
    expect(a.phase).toBe('taxi');
    expect(a.pathTotal).toBe(0);
    // ... and comes back on the strip and in the panel when the standby window closes
    await sim.advance(60);
    await expect(game.stripReq(cs)).toHaveCount(0);
    await sim.advance(61);
    await expect(game.stripReq(cs)).toHaveAttribute('data-kind', 'taxi');
    await expect(game.reqBand()).toHaveAttribute('data-request', 'taxi');
    expect((await sim.aircraftOrFail(cs)).requests[0].answeredAt).toBeNull();

    // UNABLE: reason chips -> the request is answered (chip gone) and no clearance was given
    await game.reqUnable().click();
    await expect(game.stepperFor('action-unable')).toHaveAttribute('data-step-type', 'text');
    await expect(game.page.getByTestId('picker-unable-reason-traffic')).toHaveAttribute('aria-pressed', 'true');
    await game.page.getByTestId('picker-unable-reason-delay').click();
    await expect(game.page.getByTestId('picker-unable-reason-delay')).toHaveAttribute('aria-pressed', 'true');
    await game.next();
    await expect(game.confirmSummary()).toContainText(/expect delay, standby/i);
    const un = await game.transmit();
    expect(un.status).toBe('ok');
    expect(un.tx).toMatch(/expect delay, standby/i);
    a = await sim.aircraftOrFail(cs);
    expect(a.requests.every((r) => r.answeredAt != null)).toBe(true);
    expect(a.pathTotal).toBe(0);
    await expect(game.stripReq(cs)).toHaveCount(0);
    await expect(game.reqBand()).toHaveCount(0);
    await game.waitRadio(/expect delay, standby/i, { who: 'ATC', callsign: cs });

    // the pilot calls again later (injected: the engine's own re-call timer is not what this scenario tests)
    await sim.advance(130);
    expect((await sim.aircraftOrFail(cs)).pathTotal).toBe(0);                 // still waiting, nothing moved
    await sim.request(cs, 'taxi');
    await expect(game.stripReq(cs)).toHaveAttribute('data-kind', 'taxi');
    await expect(game.reqBand()).toHaveAttribute('data-request', 'taxi');
    // ... and the one-tap answer clears it with a real taxi clearance
    await game.reqAnswer().click();
    await expect(game.stepperFor('action-taxi-runway')).toHaveAttribute('data-step-type', 'confirm');
    const tx = await game.transmit();
    expect(tx.code).toBe('ok_queued');
    await expect(game.stripReq(cs)).toHaveCount(0);
    await sim.advance(PILOT);
    a = await sim.aircraftOrFail(cs);
    expect(a.pathTotal).toBeGreaterThan(100);
    expect(a.requests.every((r) => r.answeredAt != null)).toBe(true);
    await expectInBay(game, cs, 'TAXI_OUT');
  });

  test('runway crossing needs a clearance: the pilot waits at the 27L hold, calls "request cross", the REQ answer is Cross runway @full', async ({ openGame, sim }) => {
    const game = await openGame(GROUND);
    const cs = 'BAW2';
    await spawnReadyToTaxi(sim, cs, T4_STAND);
    await game.openPanelFor(cs);
    const tx = await clickTaxiToRunway(game, '27R');
    expect(tx.code).toBe('ok_queued');
    await sim.advance(PILOT);
    // the route picker warned about the crossing at draft time; the engine armed the 27L hold
    expect((await holdsOf(sim, cs)).map((h) => h.runway)).toEqual(['27L', '27R']);

    await sim.advanceUntilOk(`s => s.aircraft.find(x => x.callsign === '${cs}')?.stage === 'hold_short_cross'`, 600);
    const stoppedAt = (await sim.aircraftOrFail(cs)).distAlong;
    // the pilot calls for the crossing on his own
    await sim.advanceUntilOk(`s => { const x = s.aircraft.find(x => x.callsign === '${cs}'); return !!x && x.requests.some(r => r.kind === 'cross' && r.answeredAt == null); }`, 30);
    await game.waitRadio(/holding short runway two seven left, request cross/i, { who: 'PILOT', callsign: cs });
    await expect(game.stripReq(cs)).toHaveAttribute('data-kind', 'cross');
    await expect(game.strip(cs)).toHaveAttribute('data-req', 'cross');
    await expect(game.reqBand()).toHaveAttribute('data-request', 'cross');
    await expect(game.reqAnswer()).toContainText(/cross/i);
    await expect(game.actionBtn('action-cross')).toHaveAttribute('data-primary', 'true');

    // without a clearance nothing moves: 90 s later still holding at the same spot, the runway untouched
    await sim.advance(90);
    let a = await sim.aircraftOrFail(cs);
    expect(a.phase).toBe('hold_short');
    expect(a.stage).toBe('hold_short_cross');
    expect(a.speed).toBe(0);
    expect(a.distAlong).toBeCloseTo(stoppedAt, 0);
    expect(a.holdReleased).toBe(false);
    expect((await sim.runways()).find((r) => r.name === '27L')?.occupied).toBe(false);
    await expectInBay(game, cs, 'TAXI_OUT');
    await expect(game.strip(cs)).toHaveAttribute('data-stage', 'hold_short_cross');
    // Continue / Line up are not the way across (R-codes from §G2)
    await expect(game.actionBtn('action-continue')).toHaveCount(0);
    await expect(game.actionBtn('action-lineup')).toHaveAttribute('data-reason', 'Holding to cross, not to depart');

    // the one-tap answer: Cross runway 27L on its confirm step
    await game.reqAnswer().click();
    await expect(game.stepperFor('action-cross')).toHaveAttribute('data-step-type', 'confirm');
    await expect(game.confirmSummary()).toContainText(/cross runway two seven left/i);
    const cross = await game.transmit();
    expect(cross.code).toBe('ok_queued');
    await expect(game.stripReq(cs)).toHaveCount(0);
    await sim.advance(PILOT);
    a = await sim.aircraftOrFail(cs);
    expect(a.holdReleased).toBe(true);
    expect(a.requests.every((r) => r.answeredAt != null)).toBe(true);
    await game.waitRadio(/cross(ing)? (runway )?two seven left/i, { who: 'PILOT', callsign: cs });
    // rolling across: the runway shows the crossing occupant until the strip is physically clear
    await sim.advanceUntilOk(`s => { const x = s.aircraft.find(x => x.callsign === '${cs}'); return !!x && x.speed > 3; }`, 60);
    await sim.advanceUntilOk(`s => s.radio.some(l => l.callsign === '${cs}' && /runway .*27L vacated/.test(l.text))`, 240);
    await game.waitRadio(/runway .*27L vacated/i, { who: 'PILOT', callsign: cs });
    expect((await sim.runways()).find((r) => r.name === '27L')?.occupied).toBe(false);
    a = await sim.aircraftOrFail(cs);
    expect(a.phase).toBe('taxi');
    expect((await holdsOf(sim, cs)).map((h) => h.runway)).toEqual(['27R']);
  });

  test('taxi clearance with the "contact tower at the holding point" chip hands the departure to tower on arrival at the hold @full', async ({ openGame, sim }) => {
    const game = await openGame({ ...GROUND, settings: { autoHandoff: false } });
    const cs = 'BAW7';
    await spawnReadyToTaxi(sim, cs, NOPUSH_STAND);
    await game.openPanelFor(cs);

    await game.action('action-taxi-runway');
    await game.pickRunway('27R');
    await game.next();
    await game.pickTaxiwayRoute({ auto: true });
    const chip = game.page.getByTestId('picker-route-contact-tower');
    await expect(chip).not.toHaveAttribute('aria-pressed', 'true');
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    await game.next();
    await expect(game.confirmSummary()).toContainText(/taxi to holding point runway two seven right/i);
    await expect(game.confirmSummary()).toContainText(/contact tower/i);
    const tx = await game.transmit();
    expect(tx.status).toBe('ok');
    expect(tx.code).toBe('ok_conditional');                                  // the handoff part waits for the hold
    expect(tx.tx).toMatch(/contact tower one one eight decimal fife zero fife/i);

    // two commands are queued behind the pilot delay: the taxi and the conditional handoff
    let a = await sim.aircraftOrFail(cs);
    expect(a.pendingCmds.map((c) => c.kind).sort()).toEqual(['contact', 'taxi']);
    await expect(game.page.getByTestId(`strip-${cs}-pending`)).toHaveText('2');
    await sim.advance(PILOT);
    a = await sim.aircraftOrFail(cs);
    expect(a.phase).toBe('taxi');
    expect(a.pathTotal).toBeGreaterThan(100);
    expect(a.onFrequency).toBe('ground');
    expect(a.pendingCmds.map((c) => c.kind)).toEqual(['contact']);          // waits for "on reaching the hold"
    expect(a.pendingCmds[0].condition).toMatchObject({ type: 'on_reaching_hold' });
    await expect(game.page.getByTestId(`strip-${cs}-pending`)).toHaveText('1');
    await game.waitRadio(/holding point runway two seven right, tower one one eight decimal fife zero fife at the holding point/i, { who: 'PILOT', callsign: cs });

    // still on ground while taxiing; the handoff fires by itself at the holding point
    await sim.advance(60);
    a = await sim.aircraftOrFail(cs);
    expect(a.phase).toBe('taxi');
    expect(a.onFrequency).toBe('ground');
    expect(a.handedTo).toBeNull();
    await sim.advanceUntilOk(`s => s.aircraft.find(x => x.callsign === '${cs}')?.stage === 'hold_short_dep'`, 900);
    await sim.advanceUntilOk(`s => s.aircraft.find(x => x.callsign === '${cs}')?.onFrequency === 'tower'`, 30);
    a = await sim.aircraftOrFail(cs);
    expect(a.pendingCmds).toEqual([]);
    expect(a.stage).toBe('hold_short_dep');
    await expect(game.strip(cs)).toHaveCount(0);
    await game.showAllFrequencies();
    await game.waitRadio(/contact Heathrow Tower 118\.505/, { who: 'SYS', callsign: cs });
    await game.setPosition('tower');
    await expectInBay(game, cs, 'AT_HOLD');
    await expect(game.strip(cs)).toHaveAttribute('data-onfreq', 'tower');
  });

  test('hold short of a runway by clicks mid-taxi ("Runway..." chip) re-arms a crossing that was pre-cleared in the taxi clearance @full', async ({ openGame, sim }) => {
    test.fixme(true, 'BUG: src/lib/sim/engine.ts:1610 execTaxi splices a pre-cleared crossing out of path.holds, so src/lib/sim/engine.ts:1651 cmdHoldShort cannot find runway 27L on the route any more and answers code "queried" ("unable, 27L is not on our route") although the taxi route physically crosses 27L ; expected: HOLD SHORT 27L re-arms the crossing (holds 27L+27R, holdReleased false, the pilot stops at the 27L hold line) ; actual: pilot query, holds stay [27R], the aircraft taxis across 27L ; repro: taxi to 27R from stand 401 with the cross-27L pill, then Hold short of -> Runway... -> 27L');
    const game = await openGame(GROUND);
    const cs = 'BAW8';
    await spawnReadyToTaxi(sim, cs, T4_STAND);
    await game.openPanelFor(cs);
    // pre-clear the crossing in the taxi clearance, then take it back with Hold short of runway 27L
    await game.action('action-taxi-runway');
    await game.pickRunway('27R');
    await game.next();
    await game.pickTaxiwayRoute({ auto: true, cross: ['27L'] });
    await game.next();
    expect((await game.transmit()).code).toBe('ok_queued');
    await sim.advance(PILOT);
    expect((await holdsOf(sim, cs)).map((h) => h.runway)).toEqual(['27R']);   // the 27L crossing was pre-cleared

    await game.action('action-hold-short');
    await expect(game.page.getByTestId('picker-holdshort-next')).toHaveAttribute('aria-pressed', 'true');
    await game.page.getByTestId('picker-holdshort-runway').click();
    await game.page.getByTestId('picker-holdshort-runway-27L').click();
    await game.next();
    await expect(game.confirmSummary()).toContainText(/hold short of runway two seven left/i);
    const hs = await game.transmit();
    expect(hs.status).toBe('ok');
    expect(hs.code).toBe('ok_queued');
    await sim.advance(PILOT);
    const a = await sim.aircraftOrFail(cs);
    expect((await holdsOf(sim, cs)).map((h) => h.runway)).toEqual(['27L', '27R']);
    expect(a.holdReleased).toBe(false);
    await game.waitRadio(/hold short (of )?(runway )?two seven left/i, { who: 'PILOT', callsign: cs });
    const stop = await sim.advanceUntil(`s => s.aircraft.find(x => x.callsign === '${cs}')?.phase === 'hold_short'`, 600);
    expect(stop.ok).toBe(true);
    expect((await sim.aircraftOrFail(cs)).holdShortRunway).toBe('27L');
    await expect(game.strip(cs)).toHaveAttribute('data-stage', 'hold_short_cross');
  });
});
