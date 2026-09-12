/*
  Error states — 05-TEST-STRATEGY §4.9 (invalid commands) adapted to the shipped parser / dispatcher / command panel:
    src/lib/sim/commands.ts (parse errors: unknown callsign, missing parameter, out-of-range values, unknown identifiers),
    src/lib/sim/dispatch.ts (guards: silent codes -> SYS line only, pilot-side refusals -> "unable" readback, strict
    frequencies R13), src/lib/sim/commandTree.ts (UX 04 §G2 stage matrix: R17 "On the ground", X1 "Push back first" ...)
    and src/game/CommLog/CommLog.tsx (the error plate keeps the text) / src/game/CommandPanel (disabled actions carry
    data-reason, the stepper cannot advance without a value, the confirm step is blocked with the hard reason).

  Contract asserted in every rejected case: the exact reason text shows in `cmd-parse-error` AND as a SYS line with
  data-status=error, the input keeps the text, the aircraft view is byte-identical before / after (nothing queued,
  no ATC line). Code wins over the §4.9 table where the phrasing differs (the reason strings are the product's).

  Boot: `/play?icao=EGLL&seed=7&spawn=none&test=1&position=approach` unless noted; pilot delay 3 s in test mode.
*/
import { test, expect, type SimApi, type SpawnSpec } from './fixtures/test';
import type { GamePage } from './pages/GamePage';

const APP = { icao: 'EGLL', spawn: 'none', position: 'approach' } as const;
const PD = 3.2;

/** The §4.6 default arrival: 20 NM out / 6 NM south of the 27L centreline, 8000 ft, 250 kt, heading 090. */
function inbound(cs: string, extra: Partial<SpawnSpec> = {}): SpawnSpec {
  return { callsign: cs, type: 'A320', kind: 'arrival', phase: 'descent', posRel: { fromRunway: '27L', alongNM: -20, offsetNM: -6, altFt: 8000 }, heading: 90, speedKts: 250, plan: { runway: '27L' }, ...extra };
}
/** Parked departure at a pushback stand (T5 512), planned for 27L. */
function parked(cs: string): SpawnSpec {
  return { callsign: cs, type: 'A320', kind: 'departure', phase: 'parked', gate: '512', plan: { runway: '27L' } };
}

/** Byte-level picture of an aircraft (time does not move between the send and the check, so any change is the command's). */
async function picture(sim: SimApi, cs: string): Promise<string> {
  return JSON.stringify(await sim.aircraft(cs));
}

/**
 * Send `text` through the real command line and assert the full rejection contract:
 * error plate with the exact reason, SYS error line "<TEXT> — <reason>", input kept, aircraft untouched, no ATC line.
 */
async function rejected(game: GamePage, sim: SimApi, text: string, reason: string | RegExp, cs: string | null = text.split(/\s+/)[0].toUpperCase()): Promise<void> {
  const before = cs ? await picture(sim, cs) : null;
  const radioBefore = await sim.radio();
  const r = await game.send(text);
  expect(r.accepted, `"${text}" should be rejected`).toBe(false);
  expect(r.error, `"${text}" reason`).not.toBeNull();
  if (typeof reason === 'string') expect(r.error, `"${text}"`).toBe(reason); else expect(r.error, `"${text}"`).toMatch(reason);
  await expect(game.cmdParseError()).toBeVisible();
  await expect(game.cmdInput()).toHaveValue(text);
  // engine: untouched, exactly one SYS error line, nothing transmitted
  if (cs) expect(await picture(sim, cs), `"${text}" changed ${cs}`).toBe(before);
  const radio = await sim.radio();
  expect(radio.length, `"${text}" logged ${radio.length - radioBefore.length} lines`).toBe(radioBefore.length + 1);
  const last = radio[radio.length - 1];
  expect(last.who).toBe('SYS');
  expect(last.status).toBe('error');
  expect(last.text.startsWith(`${text.trim().toUpperCase()} — `), `SYS line "${last.text}"`).toBe(true);
  if (typeof reason === 'string') expect(last.text).toBe(`${text.trim().toUpperCase()} — ${reason}`); else expect(last.text).toMatch(reason);
  await expect(game.radioLines().last()).toHaveAttribute('data-who', 'SYS');
  await expect(game.radioLines().last()).toHaveAttribute('data-status', 'error');
  // clear for the next attempt (editing the text drops the plate)
  await game.cmdInput().fill('');
  await expect(game.cmdInput()).toHaveValue('');
  await expect(game.cmdParseError()).toHaveCount(0);
}

test.describe('typed command errors', () => {
  test('unknown callsign: SYS error line with the reason, text kept in the input, nothing queued @smoke', async ({ openGame, sim }) => {
    const game = await openGame(APP);
    await sim.spawnAt(inbound('UAL9'));
    const before = await picture(sim, 'UAL9');
    const r = await game.send('ZZZ999 HDG 180');
    expect(r.accepted).toBe(false);
    expect(r.error).toBe('No aircraft "ZZZ999" on frequency');
    await expect(game.cmdParseError()).toHaveAttribute('role', 'alert');
    await expect(game.cmdParseError()).toHaveText('No aircraft "ZZZ999" on frequency');
    await expect(game.cmdInput()).toHaveValue('ZZZ999 HDG 180');
    await expect(game.cmdInput()).toBeFocused();
    // the log shows the attempt as a SYS error row; nothing reached the only aircraft
    const line = await game.waitRadio(/No aircraft "ZZZ999" on frequency/, { who: 'SYS' });
    expect(line.status).toBe('error');
    expect(line.text).toBe('ZZZ999 HDG 180 — No aircraft "ZZZ999" on frequency');
    expect((await sim.radio()).filter((l) => l.who === 'ATC')).toHaveLength(0);
    expect(await picture(sim, 'UAL9')).toBe(before);
    expect((await sim.aircraftOrFail('UAL9')).pendingCmds).toEqual([]);
    await sim.advance(PD);
    expect((await sim.radio()).filter((l) => l.who === 'PILOT')).toHaveLength(0);
    expect(await sim.callsigns()).toEqual(['UAL9']);
  });

  test('missing argument: HEADING / CLIMB / DESCEND / SPEED / DIRECT / HOLD AT / CONTACT / CANCEL APPROACH / bare callsign name the missing value @full', async ({ openGame, sim }) => {
    const game = await openGame(APP);
    await sim.spawnAt(inbound('UAL9'));
    const rows: Array<[string, string]> = [
      ['UAL9 HEADING', 'Heading required'],
      ['UAL9 CLIMB', 'Altitude required'],
      ['UAL9 DESCEND', 'Altitude required'],
      ['UAL9 SPEED', 'Speed required'],
      ['UAL9 DCT', 'Fix required'],
      ['UAL9 DIRECT', 'Fix required'],
      ['UAL9 HOLD AT', 'Fix required'],
      ['UAL9 CONTACT', 'Position required'],
      ['UAL9 CANCEL APPROACH', 'Cancel approach needs heading and altitude'],
      ['UAL9 SQUAWK 12', 'Squawk code required'],
      ['UAL9', 'Instruction required'],
      ['UAL9 FOO BAR', 'Unknown instruction "FOO"'],
    ];
    for (const [text, reason] of rows) await rejected(game, sim, text, reason);
    // nothing was ever queued and the pilot never answered
    expect((await sim.aircraftOrFail('UAL9')).pendingCmds).toEqual([]);
    expect((await sim.radio()).filter((l) => l.who !== 'SYS')).toHaveLength(0);
    await expect(game.radioLines('ATC')).toHaveCount(0);
    await expect(game.radioLines('SYS')).toHaveCount(rows.length + 2);            // + the boot line + the spawn line
  });

  test('bare HOLD on an airborne arrival asks for the fix, it is not a hold-position order @full', async ({ openGame, sim }) => {
    test.fixme(true, 'BUG: src/lib/sim/commands.ts:624 — a bare "UAL9 HOLD" (no fix) is parsed as holdPosition regardless of the stage, so the engine (engine.ts:1679 cmdHoldPosition) refuses an airborne arrival 20 NM out with "Airborne — use Go around" ; expected the missing-parameter reason "Hold at which fix?" / "Fix required" (05 §4.9 row "UAL9 HOLD") ; actual SYS "UAL9 HOLD — Airborne — use Go around" ; repro: spawn inbound UAL9 on APPROACH, type "UAL9 HOLD"');
    const game = await openGame(APP);
    await sim.spawnAt(inbound('UAL9'));
    await rejected(game, sim, 'UAL9 HOLD', /[Ff]ix/);
  });

  test('ILS with no runway falls back to the planned runway; an arrival without a plan is asked for it @full', async ({ openGame, sim }) => {
    const game = await openGame(APP);
    await sim.spawnAt(inbound('UAL9'));
    const noPlan = await sim.spawnAt({ callsign: 'DLH4', type: 'A320', kind: 'arrival', phase: 'descent', posRel: { fromRunway: '27L', alongNM: -18, offsetNM: 4, altFt: 7000 }, heading: 90, speedKts: 250 });
    expect(noPlan.plan.runway ?? null).toBeNull();
    await rejected(game, sim, 'DLH4 ILS', 'Runway required');
    // with a plan the runway is implied: transmitted for 27L, armed after the pilot delay
    const tx = await game.sendOk('UAL9 ILS');
    expect(tx.text).toMatch(/cleared ILS approach runway two seven left/);
    await sim.advance(PD);
    expect((await sim.aircraftOrFail('UAL9')).ilsArmed).toBe(true);
    expect((await sim.aircraftOrFail('UAL9')).assignedRunway).toBe('27L');
    expect((await sim.aircraftOrFail('DLH4')).ilsArmed).toBe(false);
  });

  test('out-of-range values: heading 400 / 000 / 18O, altitude 99000 / above the ceiling, speed 20 / 500, squawk 9999 @full', async ({ openGame, sim }) => {
    const game = await openGame(APP);
    const spawned = await sim.spawnAt(inbound('UAL9'));
    const rows: Array<[string, string]> = [
      ['UAL9 HDG 400', 'Heading 400 must be 001-360'],
      ['UAL9 HDG 000', 'Heading 000 must be 001-360'],
      ['UAL9 HDG 18O', 'Heading required'],                                          // letter O is not a digit
      ['UAL9 HDG -10', 'Heading required'],
      ['UAL9 DESCEND 99000', 'Altitude 99000 must be a multiple of 100 ft up to FL450'],
      ['UAL9 CLIMB 99000', 'Altitude 99000 must be a multiple of 100 ft up to FL450'],
      ['UAL9 CLIMB 25000', 'Above service ceiling (20000 ft)'],
      ['UAL9 SPEED 20', 'Speed 20 must be 100-350 kt'],
      ['UAL9 SPEED 500', 'Speed 500 must be 100-350 kt'],
      ['UAL9 SQUAWK 9999', 'Squawk 9999 must be four octal digits'],
    ];
    for (const [text, reason] of rows) await rejected(game, sim, text, reason);
    const a = await sim.aircraftOrFail('UAL9');
    expect(a.pendingCmds).toEqual([]);
    expect(a.targetHeading).toBeCloseTo(90, 0);
    expect(a.cmdAltitude).toBe(spawned.cmdAltitude);
    expect(a.cmdIas).toBe(spawned.cmdIas);
    // the edges of the ranges are accepted
    await game.sendOk('UAL9 HDG 360');
    await game.sendOk('UAL9 SPEED 250');
    await sim.advance(PD);
    expect((await sim.aircraftOrFail('UAL9')).targetHeading % 360).toBeCloseTo(0, -1);
  });

  test('unknown fix / runway / taxiway / stand / destination are rejected by name @full', async ({ openGame, sim }) => {
    const game = await openGame(APP);
    await sim.spawnAt(inbound('UAL9'));
    await sim.spawnAt(parked('BAW1'));
    expect(await sim.beacons()).not.toContain('ZZZZZ');
    expect((await sim.runways()).map((r) => r.name)).not.toContain('36');
    expect(await sim.taxiways()).not.toContain('ZZ');
    expect(await sim.gates()).not.toContain('ZZ99');
    const rows: Array<[string, string]> = [
      ['UAL9 DCT ZZZZZ', 'Unknown fix ZZZZZ'],
      ['UAL9 HOLD AT ZZZZZ', 'Unknown fix ZZZZZ'],
      ['UAL9 ILS 36', 'Unknown runway 36'],
      ['UAL9 ILS 27C', 'Unknown runway 27C'],
      ['BAW1 TAXI 27L VIA ZZ', 'Unknown taxiway ZZ'],
      ['BAW1 TAXI STAND ZZ99', 'Unknown stand ZZ99'],
      ['BAW1 TAXI 99Z', 'Taxi where? (runway or stand)'],
      ['BAW1 TAXI', 'Push back first'],
    ];
    for (const [text, reason] of rows) await rejected(game, sim, text, reason);
    expect((await sim.aircraftOrFail('UAL9')).pendingCmds).toEqual([]);
    expect((await sim.aircraftOrFail('BAW1')).pendingCmds).toEqual([]);
    expect((await sim.aircraftOrFail('BAW1')).taxiRoute).toEqual([]);
  });

  test('stage guards: airborne verbs on a parked departure and ground verbs on an inbound arrival are refused with the matrix reason @full', async ({ openGame, sim }) => {
    const game = await openGame(APP);
    await sim.spawnAt(inbound('UAL9'));
    await sim.spawnAt(parked('BAW1'));
    await sim.spawnAt({ callsign: 'DLH2', type: 'A320', kind: 'departure', phase: 'taxi', gate: 'CRP' });
    expect(await sim.stage('BAW1')).toBe('parked');
    expect(await sim.stage('UAL9')).toBe('arr_inbound');
    expect(await sim.stage('DLH2')).toBe('taxi_out');
    const rows: Array<[string, string]> = [
      // R17 "On the ground" for every airborne verb on the parked departure
      ['BAW1 HDG 180', 'On the ground'],
      ['BAW1 CLIMB 5000', 'On the ground'],
      ['BAW1 SPEED 200', 'On the ground'],
      ['BAW1 DCT BIG', 'On the ground'],
      ['BAW1 GO AROUND', 'On the ground'],
      ['BAW1 CLEARED LAND 27L', 'On the ground'],
      // ground verbs out of order
      ['BAW1 LINE UP 27L', 'Not at the holding point yet'],
      ['BAW1 TAKEOFF', 'Not at the holding point yet'],
      ['BAW1 CLEARED FOR TAKEOFF 27L', 'Not at the holding point yet'],
      ['BAW1 HOLD SHORT 27L', 'Not moving'],
      ['DLH2 PUSHBACK', 'Not parked'],
      ['DLH2 STARTUP', 'Already started'],
      // ground verbs on an airborne arrival, and a landing clearance before it is on the approach
      ['UAL9 PUSHBACK', 'Not parked'],
      ['UAL9 TAXI 27L', 'Airborne'],
      ['UAL9 LINE UP 27L', 'Airborne'],
      ['UAL9 CLEARED FOR TAKEOFF 27L', 'Airborne'],
      ['UAL9 CLEARED LAND 27L', 'Not on approach'],
      ['UAL9 CONTACT APPROACH', 'Already on approach'],
    ];
    for (const [text, reason] of rows) await rejected(game, sim, text, reason);
    for (const cs of ['BAW1', 'UAL9', 'DLH2']) expect((await sim.aircraftOrFail(cs)).pendingCmds, cs).toEqual([]);
    expect(await sim.stage('BAW1')).toBe('parked');
    expect(await sim.stage('UAL9')).toBe('arr_inbound');

    // the panel tells the same story for the parked departure (GROUND bay): no airborne actions, taxi blocked with X1
    await game.setPosition('ground');
    await game.openPanelFor('BAW1');
    await expect(game.actionBtn('action-heading')).toHaveCount(0);
    await expect(game.actionBtn('action-altitude')).toHaveCount(0);
    await expect(game.actionBtn('action-land')).toHaveCount(0);
    await expect(game.actionBtn('action-takeoff')).toHaveCount(0);
    expect(await game.actionState('action-taxi-runway')).toEqual({ state: 'disabled', reason: 'Push back first' });
    expect(await game.actionState('action-pushback')).toMatchObject({ state: 'enabled' });
    const rowsApi = await sim.actions('BAW1');
    expect(rowsApi.find((r) => r.id === 'action-taxi-runway')).toMatchObject({ state: 'disabled', reasonText: 'Push back first' });
    expect(rowsApi.find((r) => r.id === 'action-heading')?.state ?? 'hidden').toBe('hidden');
  });

  test('pilot "unable": a speed outside the envelope is transmitted, refused in the readback and changes nothing @smoke', async ({ openGame, sim }) => {
    const game = await openGame(APP);
    await sim.spawnAt(inbound('UAL9'));
    const before = await sim.aircraftOrFail('UAL9');
    const r = await game.send('UAL9 SPEED 110');
    expect(r.accepted).toBe(true);                                        // transmitted: no error plate, input cleared
    expect(r.error).toBeNull();
    const atc = await game.waitRadio(/reduce speed to one one zero knots/, { who: 'ATC', callsign: 'UAL9' });
    expect(atc.status).toBe('unable');
    await expect(game.radioLines('ATC').last()).toHaveAttribute('data-status', 'unable');
    // nothing queued: the refusal is pilot-side, the engine never took the value
    expect((await sim.aircraftOrFail('UAL9')).pendingCmds).toEqual([]);
    expect((await sim.aircraftOrFail('UAL9')).cmdIas).toBeNull();
    await sim.advance(PD);
    const pilot = await game.waitRadio(/^Unable one one zero knots/, { who: 'PILOT', callsign: 'UAL9' });
    expect(pilot.status).toBe('unable');
    expect(pilot.text).toMatch(/Speed 110 outside envelope \d+-\d+ kt, United niner\.$/);
    await expect(game.radioLines('PILOT').last()).toHaveAttribute('data-status', 'unable');
    const after = await sim.aircraftOrFail('UAL9');
    expect(after.cmdIas).toBe(before.cmdIas);
    expect(after.cmdIas).toBeNull();
    expect(after.pendingCmds).toEqual([]);
    // the picker never offers such a value: its ladder is clamped to the envelope the pilot quoted
    const m = pilot.text.match(/envelope (\d+)-(\d+) kt/);
    expect(m).not.toBeNull();
    await game.openPanelFor('UAL9');
    await game.action('action-speed');
    const ladder = game.page.getByTestId('picker-speed-ladder-svg');
    await expect(ladder).toBeVisible();
    expect(Number(await ladder.getAttribute('aria-valuemin'))).toBeGreaterThanOrEqual(110);
    expect(Number(await ladder.getAttribute('aria-valuemax'))).toBeLessThanOrEqual(Number(m![2]));
    await game.cancel();
  });

  test('pilot query: CROSS to an aircraft that is not holding short is transmitted and the pilot asks to confirm @full', async ({ openGame, sim }) => {
    const game = await openGame({ ...APP, position: 'ground' });
    await sim.spawnAt(parked('BAW1'));
    const before = await picture(sim, 'BAW1');
    const r = await game.send('BAW1 CROSS 27L');
    expect(r.accepted).toBe(true);
    await game.waitRadio(/cross runway two seven left/, { who: 'ATC', callsign: 'BAW1' });
    expect(await picture(sim, 'BAW1')).toBe(before);
    await sim.advance(PD);
    const q = await game.waitRadio(/not holding short of 27L, confirm\?$/, { who: 'PILOT', callsign: 'BAW1' });
    expect(q.text).toBe("Speedbird one, we're not holding short of 27L, confirm?");
    expect(await sim.stage('BAW1')).toBe('parked');
    expect((await sim.aircraftOrFail('BAW1')).holdReleased).toBe(false);
  });

  test('sequences: incompatible parts are refused before anything is queued; a refused part rolls the transmission back @full', async ({ openGame, sim }) => {
    const game = await openGame(APP);
    await sim.spawnAt(inbound('UAL9'));
    await rejected(game, sim, 'UAL9 HDG 180 THEN CLIMB 6000 THEN SPEED 210 THEN DCT BIG THEN HDG 190', 'Incompatible parts: heading and direct');
    await rejected(game, sim, 'UAL9 HDG 180 THEN DCT BIG', 'Incompatible parts: heading and direct');
    // a valid first part followed by a stage-invalid part: the whole transmission is refused, nothing stays queued
    await rejected(game, sim, 'UAL9 HDG 180 THEN PUSHBACK', /Not parked/);
    expect((await sim.aircraftOrFail('UAL9')).pendingCmds).toEqual([]);
    expect((await sim.radio()).filter((l) => l.who === 'ATC')).toHaveLength(0);
    // the same parts in a compatible combination are accepted as one transmission
    const ok = await game.sendOk('UAL9 HDG 180 THEN DESCEND 6000 THEN SPEED 210');
    expect(ok.text).toMatch(/one eight zero/);
    expect(ok.text).toMatch(/six thousand/);
    expect(ok.text).toMatch(/two one zero/);
    await sim.advance(PD);
    const a = await sim.aircraftOrFail('UAL9');
    expect(a.targetHeading).toBeCloseTo(180, -1);
    expect(a.cmdAltitude).toBe(6000);
    expect(a.cmdIas).toBe(210);
  });

  test('empty and whitespace-only input is ignored: no SYS line, no error plate, focus stays @full', async ({ openGame, sim }) => {
    const game = await openGame(APP);
    await sim.spawnAt(inbound('UAL9'));
    const n = (await sim.radio()).length;
    await game.cmdInput().click();
    await game.cmdInput().press('Enter');
    await game.cmdInput().fill('   ');
    await game.cmdInput().press('Enter');
    await expect(game.cmdParseError()).toHaveCount(0);
    await expect(game.cmdInput()).toBeFocused();
    await game.cmdInput().fill('');
    await expect(game.cmdSend()).toBeDisabled();                          // SEND has nothing to send
    await game.cmdInput().fill('   ');
    await expect(game.cmdSend()).toBeDisabled();
    await expect(game.cmdParseError()).toHaveCount(0);
    expect((await sim.radio()).length).toBe(n);
    await expect(game.radioLines()).toHaveCount(n);
    expect((await sim.aircraftOrFail('UAL9')).pendingCmds).toEqual([]);
  });

  test('very long input is rejected in place without breaking the page @full', async ({ openGame, sim }) => {
    const game = await openGame(APP);
    await sim.spawnAt(inbound('UAL9'));
    const junk = 'X'.repeat(600);
    await rejected(game, sim, `UAL9 ${junk}`, `Unknown instruction "${junk}"`);
    const many = `UAL9 ${'HDG 180 THEN '.repeat(30)}HDG 180`;
    const r = await game.send(many);
    // the parser folds repeated headings into one part; either a rejection or a single accepted vector is fine, never a crash
    if (r.accepted) { await game.waitRadio(/one eight zero/, { who: 'ATC', callsign: 'UAL9' }); }
    else { await expect(game.cmdParseError()).toBeVisible(); await game.cmdInput().press('Escape'); }
    await expect(game.cmdInput()).toBeEditable();
    const ok = await game.sendOk('UAL9 HDG 200');
    expect(ok.text).toMatch(/two zero zero/);
  });

  test('rapid double submit: Enter twice and SEND twice transmit once @full', async ({ openGame, sim }) => {
    const game = await openGame(APP);
    await sim.spawnAt(inbound('UAL9'));
    await game.cmdInput().fill('UAL9 HDG 200');
    await game.cmdInput().press('Enter');
    await game.cmdInput().press('Enter');
    await expect(game.cmdInput()).toHaveValue('');
    await game.waitRadio(/fly heading two zero zero/, { who: 'ATC', callsign: 'UAL9' });
    expect((await sim.radio()).filter((l) => l.who === 'ATC')).toHaveLength(1);
    await expect(game.radioLines('ATC')).toHaveCount(1);
    expect((await sim.aircraftOrFail('UAL9')).pendingCmds.map((c) => c.kind)).toEqual(['heading']);

    await game.cmdInput().fill('UAL9 DESCEND 6000');
    await expect(game.cmdSend()).toBeEnabled();
    await game.cmdSend().click();
    await expect(game.cmdInput()).toHaveValue('');
    await expect(game.cmdSend()).toBeDisabled();                          // the emptied line disarms SEND at once
    await game.waitRadio(/descend to six thousand/, { who: 'ATC', callsign: 'UAL9' });
    expect((await sim.radio()).filter((l) => l.who === 'ATC')).toHaveLength(2);
    await expect(game.radioLines('ATC')).toHaveCount(2);
    expect((await sim.aircraftOrFail('UAL9')).pendingCmds.map((c) => c.kind).sort()).toEqual(['altitude', 'heading']);
    await sim.advance(PD);
    expect((await sim.radio()).filter((l) => l.who === 'PILOT')).toHaveLength(2);
  });
});

test.describe('frequency and panel guardrails', () => {
  test('strict frequencies: an aircraft on the tower frequency is refused from APPROACH with R13 in the log and the panel @full', async ({ openGame, sim }) => {
    const game = await openGame({ ...APP, settings: { strictFrequencies: true } });
    expect((await sim.engineSettings()).strictFrequencies).toBe(true);
    await sim.spawnAt(inbound('UAL9', { onFrequency: 'tower' }));
    expect((await sim.aircraftOrFail('UAL9')).onFrequency).toBe('tower');
    await rejected(game, sim, 'UAL9 HDG 180', 'Not on your frequency');
    await rejected(game, sim, 'UAL9 DESCEND 6000', 'Not on your frequency');
    // panel: every action is disabled with the same reason, the header says so
    await game.openPanelFor('UAL9');
    await expect(game.page.getByTestId('panel-onfreq-note')).toBeVisible();
    await expect(game.page.getByTestId('panel-onfreq-note')).toContainText(/On TOWER frequency — not on your frequency/);
    for (const id of ['action-heading', 'action-altitude', 'action-speed', 'action-direct', 'action-ils']) {
      expect(await game.actionState(id), id).toEqual({ state: 'disabled', reason: 'Not on your frequency' });
    }
    const rows = await sim.actions('UAL9');
    expect(rows.filter((r) => r.state === 'enabled')).toHaveLength(0);
    expect(rows.find((r) => r.id === 'action-heading')).toMatchObject({ state: 'disabled', reasonText: 'Not on your frequency' });
    // the same line is accepted by the position that owns the frequency (the strip lives in TOWER's FINAL bay only once established; use the store)
    await sim.setPosition('tower');
    const r = await sim.command('UAL9 HDG 180');
    expect(r.ok).toBe(true);
    await sim.advance(PD);
    expect((await sim.aircraftOrFail('UAL9')).targetHeading).toBeCloseTo(180, -1);
  });

  test('without strict frequencies the same aircraft is accepted and the panel only notes its frequency @full', async ({ openGame, sim }) => {
    const game = await openGame(APP);
    expect((await sim.engineSettings()).strictFrequencies).toBe(false);
    await sim.spawnAt(inbound('UAL9', { onFrequency: 'tower' }));
    await game.openPanelFor('UAL9');
    await expect(game.page.getByTestId('panel-onfreq-note')).toHaveText(/On TOWER frequency$/);
    expect(await game.actionState('action-heading')).toMatchObject({ state: 'enabled' });
    await game.showAllFrequencies();                                      // the ATC line goes out on the tower frequency
    const ok = await game.sendOk('UAL9 HDG 180');
    expect(ok.text).toMatch(/one eight zero/);
    await sim.advance(PD);
    expect((await sim.aircraftOrFail('UAL9')).targetHeading).toBeCloseTo(180, -1);
  });

  test('stepper guardrails: no fix -> Next stays disabled; a closed runway blocks TRANSMIT with R14 @full', async ({ openGame, sim }) => {
    const game = await openGame({ ...APP, position: 'tower' });
    await sim.spawnAt(inbound('UAL9'));
    await sim.spawnAt({ callsign: 'BAW7', type: 'A320', kind: 'departure', phase: 'hold_short', runway: '27R', plan: { runway: '27R' } });
    await expect(game.strip('BAW7')).toHaveAttribute('data-bay', 'AT_HOLD');

    // the runway is closed: the panel's takeoff confirm step is hard-blocked, nothing can be transmitted
    await sim.setRunwayStatus('27R', 'closed');
    expect((await sim.runwayStates()).find((r) => r.name === '27R')?.status).toBe('closed');
    await game.openPanelFor('BAW7');
    const takeoff = await game.actionState('action-takeoff');
    if (takeoff.state === 'enabled') {
      await game.action('action-takeoff');
      while ((await game.stepType()) !== 'confirm') { await game.next(); }
      await expect(game.blockedReason()).toBeVisible();
      await expect(game.blockedReason()).toHaveAttribute('data-reason', 'Runway 27R closed');
      await expect(game.transmitBtn()).toHaveCount(0);
      await expect(game.transmitAnyway()).toHaveCount(0);
      await game.cancel();
    } else {
      expect(takeoff.reason).toBe('Runway 27R closed');
    }
    expect((await sim.aircraftOrFail('BAW7')).takeoffCleared).toBe(false);
    expect((await sim.radio()).filter((l) => l.who === 'ATC')).toHaveLength(0);
    // the typed path is refused with the same reason
    await rejected(game, sim, 'BAW7 CLEARED FOR TAKEOFF 27R', 'Runway 27R closed');
    await sim.setRunwayStatus('27R', 'open');

    // GROUND: the give-way aircraft picker has no default, so Next stays disabled until an aircraft is picked;
    // the direct-to fix picker offers no row for an unknown search and keeps its default
    await game.setPosition('ground');
    await sim.spawnAt({ callsign: 'BAW8', type: 'A320', kind: 'departure', phase: 'taxi', gate: '401' });
    await sim.spawnAt({ callsign: 'BAW9', type: 'A320', kind: 'departure', phase: 'taxi', gate: '402' });
    await game.openPanelFor('BAW8');
    await game.action('action-giveway');
    expect(await game.stepType()).toBe('aircraft');
    await expect(game.stepNext()).toBeDisabled();
    await expect(game.stepperFor('action-giveway')).toContainText('Pick a value');
    await expect(game.page.getByTestId('picker-aircraft-BAW8')).toHaveCount(0);           // never itself
    await game.stepNext().click({ force: true });
    expect(await game.stepType()).toBe('aircraft');                                          // a forced click does nothing
    await game.page.keyboard.press('Enter');
    expect(await game.stepType()).toBe('aircraft');                                          // Enter neither
    // (the candidate list itself is empty today — see 30-ground "give way by clicks" fixme; when it lists BAW9, picking enables Next)
    if (await game.page.getByTestId('picker-aircraft-BAW9').count()) {
      await game.pickAircraft('BAW9');
      await expect(game.stepNext()).toBeEnabled();
    }
    await game.cancel();
    expect((await sim.aircraftOrFail('BAW8')).pendingCmds).toEqual([]);

    await game.setPosition('approach');
    await game.openPanelFor('UAL9');
    await game.action('action-direct');
    expect(await game.stepType()).toBe('fix');
    await game.page.getByTestId('picker-fix-search').fill('ZZZZZ');
    await expect(game.page.locator('[data-testid^="picker-fix-"][role="option"]')).toHaveCount(0);
    await expect(game.page.getByRole('listbox', { name: 'Fixes' })).toContainText('No fix "ZZZZZ"');
    await game.page.getByTestId('picker-fix-search').fill('');
    await game.pickFix('BIG');
    await expect(game.stepNext()).toBeEnabled();
    await game.next();
    const tx = await game.transmit();
    expect(tx.code).toBe('ok_queued');
    await sim.advance(PD);
    expect((await sim.aircraftOrFail('UAL9')).directTargetName).toBe('BIG');
  });
});
