/*
  Strip bay (src/game/StripBay/StripBay.tsx + StripCard.tsx; UX 04 §2.2 bays per position, §3 strips, §G7 bay mapping):
    - bays per position with counts (bay mapping from src/lib/sim/stage.ts `bayFor`)
    - filters ALL / DEP / ARR / REQ / ALERT + search, persisted per position
    - selection sync strip <-> map <-> command panel, hover sync strip <-> map
    - collapse to the 44 px rail with per-bay counts (+ persist across reload, F4)
    - Tab / Shift+Tab cycling (alerts -> requests -> bay order)
    - drag reorder within a bay (SEQUENCE reorder writes the landing sequence number)

  Every test boots `/play?icao=EGLL&seed=7&spawn=none&test=1` and builds its own traffic with `sim.spawnAt`
  (deterministic: no RAF, time only moves through `sim.advance`). Engine state is asserted through the `sim`
  fixture, visibility through data-testid locators (05-TEST-STRATEGY §2.1 rule 5).
*/
import { test, expect, type SimApi, type GamePage } from './fixtures/test';

const A320 = 'A320';

/** Ground traffic: BAW1 parked (PENDING), DLH2 taxiing (TAXI_OUT), EZY8 on stand after landing (AT_STAND). */
async function seedGround(sim: SimApi): Promise<{ gates: string[] }> {
  const gates = await sim.gates();
  await sim.spawnAt({ callsign: 'BAW1', type: A320, kind: 'departure', phase: 'parked', gate: gates[0], plan: { runway: '27L' } });
  await sim.spawnAt({ callsign: 'DLH2', type: A320, kind: 'departure', phase: 'taxi', gate: gates[1], plan: { runway: '27L' } });
  await sim.spawnAt({ callsign: 'EZY8', type: A320, kind: 'arrival', phase: 'arrived', gate: gates[2] });
  return { gates };
}

/** Three parked departures in the GROUND PENDING bay (spawn order = bay order: BAW1, DLH2, AFR3). */
async function seedThreeParked(sim: SimApi): Promise<void> {
  const gates = await sim.gates();
  await sim.spawnAt({ callsign: 'BAW1', type: A320, kind: 'departure', phase: 'parked', gate: gates[0], plan: { runway: '27L' } });
  await sim.spawnAt({ callsign: 'DLH2', type: A320, kind: 'departure', phase: 'parked', gate: gates[1], plan: { runway: '27L' } });
  await sim.spawnAt({ callsign: 'AFR3', type: A320, kind: 'departure', phase: 'parked', gate: gates[2], plan: { runway: '27L' } });
}

async function expectSelected(game: GamePage, sim: SimApi, cs: string): Promise<void> {
  await expect(game.strip(cs)).toHaveAttribute('data-selected', 'true');
  await expect(game.strip(cs)).toHaveAttribute('aria-selected', 'true');
  await expect(game.panel()).toHaveAttribute('data-callsign', cs);
  await expect(game.panelCallsign()).toHaveText(cs);
  const a = await sim.aircraftOrFail(cs);
  expect((await sim.snapshot()).selectedId).toBe(a.id);
}

test.describe('strip bay', () => {
  test('bays per position hold the right strips with counts @smoke', async ({ openGame, sim }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'ground' });
    await seedGround(sim);
    await sim.spawnAt({ callsign: 'AFR3', type: A320, kind: 'departure', phase: 'hold_short', runway: '27L' });
    await sim.spawnAt({ callsign: 'KLM4', type: A320, kind: 'departure', phase: 'lineup', runway: '27L' });
    await sim.spawnAt({ callsign: 'UAL9', type: A320, kind: 'arrival', phase: 'descent', posRel: { fromRunway: '27L', alongNM: -20, offsetNM: -6, altFt: 8000 }, heading: 90, speedKts: 250 });
    await sim.spawnAt({ callsign: 'DAL5', type: A320, kind: 'arrival', phase: 'approach', posRel: { fromRunway: '27L', alongNM: -9, altFt: 2800 }, speedKts: 170, ils: '27L' });
    await sim.spawnAt({ callsign: 'SWR7', type: A320, kind: 'departure', phase: 'climb', posRel: { fromRunway: '27L', alongNM: 6, altFt: 3000 }, speedKts: 220 });
    await sim.setState('SWR7', { phase: 'climb' });                     // airborne spawns land in 'approach'; a climbing departure is dep_climb
    expect((await sim.snapshot()).stats.total).toBe(8);

    // GROUND: PENDING / TAXI_OUT / AT_STAND; tower / approach traffic is not in this bay
    await expect(game.stripBay()).toHaveAttribute('data-position', 'ground');
    await expect(game.bayTotal()).toHaveAttribute('data-value', '3');
    await expect(game.bay('PENDING')).toHaveAttribute('data-count', '1');
    await expect(game.bayCount('PENDING')).toHaveText('1');
    expect(await game.bayCallsigns('PENDING')).toEqual(['BAW1']);
    expect(await game.bayCallsigns('TAXI_OUT')).toEqual(['DLH2']);
    expect(await game.bayCallsigns('AT_STAND')).toEqual(['EZY8']);
    await expect(game.bay('PUSH_START')).toHaveAttribute('data-count', '0');
    await expect(game.bayEmpty('PUSH_START')).toContainText(/no traffic/i);
    for (const cs of ['AFR3', 'KLM4', 'UAL9', 'DAL5', 'SWR7']) await expect(game.strip(cs)).toHaveCount(0);
    // strip attributes mirror the engine
    for (const cs of ['BAW1', 'DLH2', 'EZY8']) {
      const a = await sim.aircraftOrFail(cs);
      await expect(game.strip(cs)).toHaveAttribute('data-stage', a.stage);
      await expect(game.strip(cs)).toHaveAttribute('data-phase', a.phase);
      await expect(game.strip(cs)).toHaveAttribute('data-kind', a.plan.kind);
      await expect(game.strip(cs)).toHaveAttribute('data-id', String(a.id));
      await expect(game.stripPhase(cs)).toHaveAttribute('data-stage', a.stage);
      await expect(game.strip(cs).getByTestId('strip-cs')).toHaveText(cs);
    }
    await expect(game.stripRunway('BAW1')).toHaveText('27L');
    await expect(game.strip('BAW1').getByTestId('strip-kind')).toHaveText('D');
    await expect(game.strip('EZY8').getByTestId('strip-kind')).toHaveText('A');

    // TOWER: AT_HOLD / LINED_UP (bays sorted by the fixed order)
    await game.setPosition('tower');
    await expect(game.stripBay()).toHaveAttribute('data-position', 'tower');
    await expect(game.bayTotal()).toHaveAttribute('data-value', '2');
    expect(await game.bayCallsigns('AT_HOLD')).toEqual(['AFR3']);
    expect(await game.bayCallsigns('LINED_UP')).toEqual(['KLM4']);
    await expect(game.strip('AFR3')).toHaveAttribute('data-bay', 'AT_HOLD');
    await expect(game.strip('KLM4')).toHaveAttribute('data-stage', 'lineup');
    for (const cs of ['BAW1', 'DLH2', 'EZY8', 'UAL9']) await expect(game.strip(cs)).toHaveCount(0);
    expect(await sim.stage('AFR3')).toBe('hold_short_dep');
    expect(await sim.stage('KLM4')).toBe('lineup');

    // APPROACH: INBOUND / SEQUENCE / CLIMB_OUT + airborne metrics on the strip
    await game.setPosition('approach');
    await expect(game.stripBay()).toHaveAttribute('data-position', 'approach');
    await expect(game.bayTotal()).toHaveAttribute('data-value', '3');
    expect(await game.bayCallsigns('INBOUND')).toEqual(['UAL9']);
    expect(await game.bayCallsigns('SEQUENCE')).toEqual(['DAL5']);
    expect(await game.bayCallsigns('CLIMB_OUT')).toEqual(['SWR7']);
    expect(await sim.stage('UAL9')).toBe('arr_inbound');
    expect(await sim.stage('DAL5')).toBe('arr_armed');
    expect(await sim.stage('SWR7')).toBe('dep_climb');
    const ual = await sim.aircraftOrFail('UAL9');
    await expect(game.stripAlt('UAL9')).toHaveAttribute('data-value', String(Math.round(ual.altitude)));
    await expect(game.strip('UAL9').getByTestId('strip-spd')).toHaveAttribute('data-value', String(Math.round(ual.speed)));
    await expect(game.strip('UAL9').getByTestId('strip-hdg')).toHaveAttribute('data-value', String(Math.round(ual.heading)));
    for (const cs of ['BAW1', 'AFR3', 'KLM4']) await expect(game.strip(cs)).toHaveCount(0);
  });

  test('filters ALL / DEP / ARR / REQ / ALERT and search narrow the bays; the filter persists per position @full', async ({ openGame, sim, page }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'ground' });
    await seedGround(sim);
    await expect(game.stripBay()).toHaveAttribute('data-filter', 'all');
    await expect(game.bayFilter('all')).toHaveAttribute('aria-pressed', 'true');
    expect((await game.stripCallsigns()).sort()).toEqual(['BAW1', 'DLH2', 'EZY8']);

    // DEP / ARR
    await game.bayFilter('dep').click();
    await expect(game.bayFilter('dep')).toHaveAttribute('aria-pressed', 'true');
    await expect(game.bayFilter('all')).toHaveAttribute('aria-pressed', 'false');
    await expect(game.stripBay()).toHaveAttribute('data-filter', 'dep');
    await expect.poll(() => game.stripCallsigns()).toEqual(['BAW1', 'DLH2']);
    await expect(game.bayEmpty('AT_STAND')).toContainText(/no strips match/i);      // the bay has an item, hidden by the filter
    await game.bayFilter('arr').click();
    await expect.poll(() => game.stripCallsigns()).toEqual(['EZY8']);

    // REQ: only aircraft with an open request (the engine raised one for BAW1)
    await game.bayFilter('req').click();
    await expect.poll(() => game.stripCallsigns()).toEqual([]);
    await sim.request('BAW1', 'pushback');
    expect((await sim.aircraftOrFail('BAW1')).requests.some((r) => r.kind === 'pushback' && r.answeredAt == null)).toBe(true);
    await expect.poll(() => game.stripCallsigns()).toEqual(['BAW1']);
    await expect(game.strip('BAW1')).toHaveAttribute('data-req', 'pushback');
    await expect(game.stripReq('BAW1')).toHaveAttribute('data-kind', 'pushback');
    await expect(game.stripReq('BAW1')).toContainText(/REQ/);
    await expect(game.bayTotal()).toContainText('1 REQ');

    // ALERT: conflict / active alert / unresolved emergency
    await game.bayFilter('alert').click();
    await expect.poll(() => game.stripCallsigns()).toEqual([]);
    await sim.forceEmergency('DLH2', 'medical');
    expect((await sim.aircraftOrFail('DLH2')).emergency?.status).not.toBe('resolved');
    await expect.poll(() => game.stripCallsigns()).toEqual(['DLH2']);
    await expect(game.strip('DLH2')).toHaveAttribute('data-emergency', 'true');
    await expect(page.getByTestId('strip-DLH2-emerg')).toBeVisible();

    // search narrows on callsign / type / stand, case-insensitive; combined with the ALL filter
    await game.bayFilter('all').click();
    await expect.poll(() => game.stripCallsigns()).toHaveLength(3);
    await game.baySearch().fill('ezy');
    await expect.poll(() => game.stripCallsigns()).toEqual(['EZY8']);
    await game.baySearch().fill('A320');
    await expect.poll(() => game.stripCallsigns()).toHaveLength(3);
    await game.baySearch().fill('ZZZZ');
    await expect.poll(() => game.stripCallsigns()).toEqual([]);
    await expect(game.bayEmpty('PENDING')).toContainText(/no strips match/i);
    await game.baySearch().fill('');
    await expect.poll(() => game.stripCallsigns()).toHaveLength(3);

    // filter persists per position (localStorage skycontrol_filters_{position}) and survives a reload
    await game.bayFilter('dep').click();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('skycontrol_filters_ground'))).toBe(JSON.stringify({ filter: 'dep' }));
    await game.setPosition('tower');
    await expect(game.stripBay()).toHaveAttribute('data-filter', 'all');                    // tower keeps its own default
    await game.setPosition('ground');
    await expect(game.stripBay()).toHaveAttribute('data-filter', 'dep');
    await page.reload();
    await game.waitReady();
    await expect(game.stripBay()).toHaveAttribute('data-filter', 'dep');
    await expect(game.bayFilter('dep')).toHaveAttribute('aria-pressed', 'true');
  });

  test('selection syncs strip <-> map <-> command panel @smoke', async ({ openGame, sim }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'ground', waitMap: true });
    await seedGround(sim);
    await expect(game.shell()).toHaveAttribute('data-has-panel', 'false');
    await expect(game.strip('BAW1')).toHaveAttribute('data-selected', 'false');

    // click a strip -> selected + panel
    await game.strip('BAW1').click();
    await expectSelected(game, sim, 'BAW1');
    await expect(game.shell()).toHaveAttribute('data-has-panel', 'true');
    await expect(game.panelKind()).toHaveAttribute('data-kind', 'departure');
    expect((await sim.aircraftOrFail('BAW1')).underControl).toBe(true);

    // select through the store (what a canvas click does) -> the strip and the panel follow
    await sim.select('DLH2');
    await expectSelected(game, sim, 'DLH2');
    await expect(game.strip('BAW1')).toHaveAttribute('data-selected', 'false');

    // click the aircraft on the ground map -> strip + panel
    await game.clickAircraft('BAW1');
    await expectSelected(game, sim, 'BAW1');
    await expect(game.strip('DLH2')).toHaveAttribute('data-selected', 'false');

    // click empty map -> everything deselected
    await game.clickEmpty();
    await expect(game.shell()).toHaveAttribute('data-has-panel', 'false');
    await expect(game.strip('BAW1')).toHaveAttribute('data-selected', 'false');
    expect((await sim.snapshot()).selectedId).toBeNull();

    // panel close (X) deselects too; the strip runway button opens the taxi action for a taxiing aircraft
    await game.selectStrip('EZY8');
    await game.closePanel();
    await expect(game.strip('EZY8')).toHaveAttribute('data-selected', 'false');
    expect((await sim.actions('DLH2')).find((r) => r.id === 'action-taxi-runway')?.state).toBe('enabled');
    await game.stripRunway('DLH2').click();
    await expectSelected(game, sim, 'DLH2');
    await expect(game.stepperFor('action-taxi-runway')).toBeVisible();
    await expect(game.panel()).toHaveAttribute('data-draft', 'action-taxi-runway');
    // for a parked departure the same button cannot open taxi (X1): the aircraft is selected and a toast explains
    await game.cancel();
    await game.stripRunway('BAW1').click();
    await expectSelected(game, sim, 'BAW1');
    await expect(game.stepper()).toHaveCount(0);
    await game.waitToast(/taxi to runway/i);
  });

  test('hover syncs strip <-> map (data-hovered, store hoveredId, pointer cursor) @full', async ({ openGame, sim, page }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'ground', waitMap: true });
    await seedGround(sim);
    const baw = await sim.aircraftOrFail('BAW1');
    const dlh = await sim.aircraftOrFail('DLH2');

    // strip hover -> store hoveredId
    await game.strip('DLH2').hover();
    await expect(game.strip('DLH2')).toHaveAttribute('data-hovered', 'true');
    await expect.poll(async () => (await sim.storeView()).hoveredId).toBe(dlh.id);
    await expect(game.strip('BAW1')).not.toHaveAttribute('data-hovered', 'true');
    await game.bayTotal().hover();                                                     // leave the card
    await expect(game.strip('DLH2')).not.toHaveAttribute('data-hovered', 'true');
    await expect.poll(async () => (await sim.storeView()).hoveredId).toBeNull();

    // map hover at the projected position -> the strip lights up and the cursor is a pointer
    await sim.centerOn('BAW1');
    const cursor = () => page.evaluate(() => getComputedStyle(document.querySelector('.maplibregl-canvas') as HTMLElement).cursor);
    await expect.poll(async () => {
      const p = await sim.screenPos('BAW1');
      if (!p) return 'no-pos';
      await game.groundMap().hover({ position: { x: p.x, y: p.y } });
      return game.strip('BAW1').getAttribute('data-hovered');
    }, { timeout: 15_000 }).toBe('true');
    expect((await sim.storeView()).hoveredId).toBe(baw.id);
    expect(await cursor()).toBe('pointer');
    await expect(game.strip('DLH2')).not.toHaveAttribute('data-hovered', 'true');

    // hover an empty spot -> nothing hovered, default cursor
    const empty = await sim.emptySpot();
    await game.groundMap().hover({ position: empty });
    await expect(game.strip('BAW1')).not.toHaveAttribute('data-hovered', 'true');
    await expect.poll(async () => (await sim.storeView()).hoveredId).toBeNull();
    expect(await cursor()).not.toBe('pointer');
  });

  test('collapse rail shows per-bay counts with REQ / ALERT dots, persists across reload, F4 toggles @full', async ({ openGame, sim, page }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'ground' });
    await seedGround(sim);
    await sim.request('BAW1', 'pushback');
    await sim.forceEmergency('DLH2', 'medical');
    await expect(game.stripBay()).toHaveAttribute('data-collapsed', 'false');
    await expect(game.shell()).toHaveAttribute('data-bay-collapsed', 'false');
    await expect(game.bayCollapse()).toHaveAttribute('aria-expanded', 'true');

    await game.bayCollapse().click();
    await expect(game.stripBay()).toHaveAttribute('data-collapsed', 'true');
    await expect(game.shell()).toHaveAttribute('data-bay-collapsed', 'true');
    await expect(game.bayCollapse()).toHaveAttribute('aria-expanded', 'false');
    await expect(game.strips()).toHaveCount(0);
    await expect(game.bayRailCount('PENDING')).toHaveAttribute('data-count', '1');
    await expect(game.bayRailCount('PENDING')).toHaveAttribute('data-req', '1');
    await expect(game.bayRailCount('PENDING')).toHaveAttribute('data-alert', '0');
    await expect(game.bayRailCount('TAXI_OUT')).toHaveAttribute('data-count', '1');
    await expect(game.bayRailCount('TAXI_OUT')).toHaveAttribute('data-alert', '1');
    await expect(game.bayRailCount('AT_STAND')).toHaveAttribute('data-count', '1');
    await expect(game.bayRailCount('PUSH_START')).toHaveAttribute('data-count', '0');
    await expect(game.bayRailCount('PENDING')).toContainText('1');
    // the counts are the engine's bay contents
    expect((await sim.aircraftOrFail('BAW1')).requests.length).toBe(1);
    expect((await sim.aircraftOrFail('DLH2')).emergency).not.toBeNull();
    // persisted for the next boot
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('skycontrol_panels') ?? '{}').bay)).toBe(true);

    await page.reload();
    await game.waitReady();
    await expect(game.stripBay()).toHaveAttribute('data-collapsed', 'true');
    await expect(game.shell()).toHaveAttribute('data-bay-collapsed', 'true');

    // a rail count button expands the bay; F4 collapses / expands from the keyboard
    await game.bayRailCount('PENDING').click();
    await expect(game.stripBay()).toHaveAttribute('data-collapsed', 'false');
    await game.hotkey('F4');
    await expect(game.stripBay()).toHaveAttribute('data-collapsed', 'true');
    await game.hotkey('F4');
    await expect(game.stripBay()).toHaveAttribute('data-collapsed', 'false');
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('skycontrol_panels') ?? '{}').bay)).toBe(false);
  });

  test('Tab / Shift+Tab cycle the strips: requests before bay order, wrapping @full', async ({ openGame, sim }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'ground' });
    await seedThreeParked(sim);
    const gates = await sim.gates();
    await sim.spawnAt({ callsign: 'KLM4', type: A320, kind: 'departure', phase: 'taxi', gate: gates[3], plan: { runway: '27L' } });
    expect(await game.stripCallsigns()).toEqual(['BAW1', 'DLH2', 'AFR3', 'KLM4']);
    expect((await sim.snapshot()).selectedId).toBeNull();

    // plain bay order first
    await game.hotkey('Tab');
    await expectSelected(game, sim, 'BAW1');
    await game.hotkey('Tab');
    await expectSelected(game, sim, 'DLH2');
    await game.hotkey('Shift+Tab');
    await expectSelected(game, sim, 'BAW1');
    await game.hotkey('Shift+Tab');                                                  // wraps to the end
    await expectSelected(game, sim, 'KLM4');

    // an open request ranks the aircraft first in the cycle (alerts -> requests -> bay order)
    await sim.request('AFR3', 'pushback');
    await expect(game.stripReq('AFR3')).toBeVisible();
    await sim.select(null);
    await expect(game.shell()).toHaveAttribute('data-has-panel', 'false');
    await game.hotkey('Tab');
    await expectSelected(game, sim, 'AFR3');
    await game.hotkey('Tab');
    await expectSelected(game, sim, 'BAW1');
    await game.hotkey('Tab');
    await expectSelected(game, sim, 'DLH2');
    await game.hotkey('Tab');
    await expectSelected(game, sim, 'KLM4');
    await game.hotkey('Tab');                                                        // wraps to the head of the cycle
    await expectSelected(game, sim, 'AFR3');

    // the cycle follows the filter (only visible strips)
    await game.bayFilter('req').click();
    await expect.poll(() => game.stripCallsigns()).toEqual(['AFR3']);
    await game.hotkey('Tab');
    await expectSelected(game, sim, 'AFR3');
  });

  test('drag reorders strips inside a bay; cross-bay drops are rejected; SEQUENCE reorder renumbers the landing sequence @full', async ({ openGame, sim, page }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'ground' });
    await seedThreeParked(sim);
    const gates = await sim.gates();
    await sim.spawnAt({ callsign: 'KLM4', type: A320, kind: 'departure', phase: 'taxi', gate: gates[3], plan: { runway: '27L' } });
    expect(await game.bayCallsigns('PENDING')).toEqual(['BAW1', 'DLH2', 'AFR3']);
    await expect(page.getByTestId('strip-drag-handle').first()).toBeVisible();

    await game.dragStrip('AFR3', 'BAW1', 'before');
    await expect.poll(() => game.bayCallsigns('PENDING')).toEqual(['AFR3', 'BAW1', 'DLH2']);
    await game.dragStrip('BAW1', 'DLH2', 'after');
    await expect.poll(() => game.bayCallsigns('PENDING')).toEqual(['AFR3', 'DLH2', 'BAW1']);
    // the manual order survives a sim tick (strips re-render from the engine)
    await sim.advance(1);
    expect(await game.bayCallsigns('PENDING')).toEqual(['AFR3', 'DLH2', 'BAW1']);
    // engine order is untouched: bays are a UI ordering only
    expect(((await sim.snapshot()).aircraft.map((a) => a.callsign))).toEqual(['BAW1', 'DLH2', 'AFR3', 'KLM4']);

    // cross-bay drop snaps back (shake) and changes nothing
    await game.dragStrip('KLM4', 'AFR3', 'before');
    await sim.flush();
    expect(await game.bayCallsigns('PENDING')).toEqual(['AFR3', 'DLH2', 'BAW1']);
    expect(await game.bayCallsigns('TAXI_OUT')).toEqual(['KLM4']);
    await expect(game.strip('KLM4')).toHaveAttribute('data-bay', 'TAXI_OUT');

    // SEQUENCE bay (APPROACH): reorder writes sequenceNo on the aircraft (#1 / #2 tags)
    await game.setPosition('approach');
    await sim.spawnAt({ callsign: 'UAL9', type: A320, kind: 'arrival', phase: 'approach', posRel: { fromRunway: '27L', alongNM: -12, altFt: 3500 }, speedKts: 180, ils: '27L' });
    await sim.spawnAt({ callsign: 'DAL5', type: A320, kind: 'arrival', phase: 'approach', posRel: { fromRunway: '27L', alongNM: -18, altFt: 5000 }, speedKts: 200, ils: '27L' });
    await expect.poll(() => game.bayCallsigns('SEQUENCE')).toEqual(['UAL9', 'DAL5']);    // sorted by distance to the threshold
    expect((await sim.state('UAL9'))?.sequenceNo ?? null).toBeNull();
    await game.dragStrip('DAL5', 'UAL9', 'before');
    await expect.poll(() => game.bayCallsigns('SEQUENCE')).toEqual(['DAL5', 'UAL9']);
    await expect(page.getByTestId('strip-DAL5-seq')).toHaveText('#1');
    await expect(page.getByTestId('strip-UAL9-seq')).toHaveText('#2');
    expect((await sim.state('DAL5'))?.sequenceNo).toBe(1);
    expect((await sim.state('UAL9'))?.sequenceNo).toBe(2);
  });

  test('strip chips: pending-command dot, REQ chip opens the answer, clearance boxes open actions @full', async ({ openGame, sim, page }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'approach' });
    await sim.spawnAt({ callsign: 'UAL9', type: A320, kind: 'arrival', phase: 'descent', posRel: { fromRunway: '27L', alongNM: -20, offsetNM: -6, altFt: 8000 }, heading: 90, speedKts: 250 });
    await expect(page.getByTestId('strip-UAL9-pending')).toHaveCount(0);

    // a queued command shows the pending dot until the pilot acts on it
    await game.sendOk('UAL9 HEADING 180');
    expect((await sim.aircraftOrFail('UAL9')).pendingCmds.length).toBe(1);
    await expect(page.getByTestId('strip-UAL9-pending')).toHaveText('1');
    await sim.advance(3.5);
    expect((await sim.aircraftOrFail('UAL9')).pendingCmds.length).toBe(0);
    await expect(page.getByTestId('strip-UAL9-pending')).toHaveCount(0);

    // the arrival boxes: I (approach) opens the ILS action; L (land) is not done yet
    await expect(page.getByTestId('strip-UAL9-box-I')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('strip-UAL9-box-L')).toHaveAttribute('data-done', 'false');
    await page.getByTestId('strip-UAL9-box-I').click();
    await expectSelected(game, sim, 'UAL9');
    await expect(game.stepperFor('action-ils')).toBeVisible();
    await game.cancel();

    // a pilot request: REQ chip on the strip with the request kind; the chip selects the aircraft and the panel's
    // REQ band offers the answer (altitude for "request descent") at the confirm step
    await sim.select(null);
    await expect(game.shell()).toHaveAttribute('data-has-panel', 'false');
    await sim.request('UAL9', 'lower');
    await expect(game.stripReq('UAL9')).toHaveAttribute('data-kind', 'lower');
    await expect(game.stripReq('UAL9')).toContainText(/REQ/);
    await expect(game.strip('UAL9')).toHaveAttribute('data-req', 'lower');
    await game.stripReq('UAL9').click();
    await expectSelected(game, sim, 'UAL9');
    await expect(game.reqBand()).toHaveAttribute('data-request', 'lower');
    await game.reqAnswer().click();
    await expect(game.stepperFor('action-altitude')).toBeVisible();
  });
});
