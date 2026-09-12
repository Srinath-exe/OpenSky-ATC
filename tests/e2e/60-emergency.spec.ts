/*
  Emergencies + ARFF (05-TEST-STRATEGY §4.12 E1-E6, adapted to the code; UX §G5.12 / 03 §4).

  Engine: src/lib/sim/emergencies.ts (catalogue, checklist, deadlines), src/lib/sim/engine.ts (declareEmergency,
  cmdEmergencyAck / execPriority / dispatchVehicle / reopenRunway, emergencyTick), src/lib/sim/vehicles.ts (ARFF fleet).
  UI: AlertStack card `toast-{alertId}` + `emergency-banner-{cs}`, StripCard `strip-{cs}-emerg`, CommandPanel
  `panel-emerg-band` / `emerg-band-*` / `emerg-check-*` / `emerg-*` action grid, VehiclePanel `btn-arff-dispatch` /
  `btn-ambulance-dispatch` / `arff-vehicle-{id}` / `veh-runway-{rwy}-status`.

  Every scenario boots `/play?icao=EGLL&seed=7&spawn=none&test=1` and builds its traffic with `sim.spawnAt`; time
  moves only through the `sim` fixture. Engine state is asserted through `sim.*`, visibility through test ids.
*/
import { test, expect, type SpawnSpec } from './fixtures/test';
import { VehiclePanelPage } from './pages/VehiclePanelPage';

/** An arrival 14 NM east of 27L at 4000 ft, inbound (posRel alongNM < 0 = before the threshold). */
function arrival(callsign: string, o: { alongNM?: number; offsetNM?: number; altFt?: number } = {}): SpawnSpec {
  return {
    callsign, type: 'A320', kind: 'arrival', phase: 'descent',
    posRel: { fromRunway: '27L', alongNM: o.alongNM ?? -14, offsetNM: o.offsetNM ?? 0, altFt: o.altFt ?? 4000 },
    heading: 270, speedKts: 220,
  };
}

const ALL_CHECKS = ['acknowledge', 'souls_fuel', 'priority_runway', 'arff', 'ambulance', 'hold_traffic', 'runway_closed', 'runway_reopened', 'inspection'] as const;

test.describe('emergencies', () => {
  test('engine fire: MAYDAY alert card, strip band, panel emergency band and EMERG actions @smoke', async ({ openGame, sim }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'approach' });
    await sim.spawnAt(arrival('BAW1'));
    await sim.forceEmergency('BAW1', 'engine_fire');

    // engine: the emergency record, squawk, priority, the opening MAYDAY call
    const a = await sim.aircraftOrFail('BAW1');
    expect(a.emergency).not.toBeNull();
    expect(a.emergency!.type).toBe('engine_fire');
    expect(a.emergency!.level).toBe('MAYDAY');
    expect(a.emergency!.status).toBe('declared');
    expect(a.emergency!.squawk).toBe('7700');
    expect(a.squawk).toBe('7700');
    expect(a.emergency!.soulsOnBoard).toBeGreaterThan(0);
    for (const k of ALL_CHECKS) expect(a.emergency!.checklist[k], `checklist ${k} untouched at declaration`).toBeNull();
    const mayday = await sim.lastRadio('PILOT');
    expect(mayday?.callsign).toBe('BAW1');
    expect(mayday?.text).toMatch(/^MAYDAY MAYDAY MAYDAY/);
    expect(mayday?.text).toMatch(/engine fire/i);
    const em = (await sim.activeAlerts()).find((x) => x.kind === 'emergency');
    expect(em, 'an emergency alert is raised at declaration').toBeTruthy();
    expect(em!.severity).toBe('critical');
    expect(em!.subjects).toEqual(['BAW1']);
    expect(em!.ack).toBe(false);

    // UI: MAYDAY card in the alert stack (critical, sticky, with ACK + MUTE), bell badge, comm log line
    await expect(game.alertCard(em!.id)).toBeVisible();
    await expect(game.alertCard(em!.id)).toHaveAttribute('data-kind', 'emergency');
    await expect(game.alertCard(em!.id)).toHaveAttribute('data-severity', 'critical');
    await expect(game.emergencyBanner('BAW1')).toBeVisible();
    await expect(game.alertItem(em!.id)).toContainText(/MAYDAY/);
    await expect(game.alertCardAck(em!.id)).toBeVisible();
    await expect(game.alertCardMute(em!.id)).toBeVisible();
    await expect(game.alertsBell()).toHaveAttribute('data-count', '1');
    await game.waitRadio(/^MAYDAY MAYDAY MAYDAY/, { who: 'PILOT', callsign: 'BAW1' });

    // UI: strip band + EMERG tag
    await expect(game.strip('BAW1')).toHaveAttribute('data-emergency', 'true');
    await expect(game.stripEmerg('BAW1')).toHaveAttribute('data-level', 'MAYDAY');
    await expect(game.stripEmerg('BAW1')).toContainText(/MAYDAY/);
    await expect(game.stripEmerg('BAW1')).toContainText(/engine fire/i);
    await expect(game.stripAlert('BAW1')).toHaveText('EMERG');

    // UI: command panel emergency band, fields, checklist, EMERG action grid + quick row
    await game.openPanelFor('BAW1');
    await expect(game.panel()).toHaveAttribute('data-emergency', 'true');
    await expect(game.emergBand()).toBeVisible();
    await expect(game.emergBand()).toHaveAttribute('data-level', 'MAYDAY');
    await expect(game.emergBand()).toHaveAttribute('data-type', 'engine_fire');
    await expect(game.emergBand()).toHaveAttribute('data-status', 'declared');
    await expect(game.emergBandPob()).toHaveText(String(a.emergency!.soulsOnBoard));
    await expect(game.emergBandStatus()).toHaveText('declared');
    await expect(game.emergChecklist()).toBeVisible();
    for (const k of ALL_CHECKS) await expect(game.emergCheck(k)).toHaveAttribute('data-done', 'false');
    for (const id of ['emerg-ack', 'emerg-priority', 'emerg-dispatch', 'emerg-hold-all']) {
      await expect(game.actionBtn(id)).toHaveAttribute('data-state', 'enabled');
      await expect(game.actionBtn(id)).toHaveAttribute('data-group', 'emergency');
    }
    await expect(game.actionBtn('emerg-ack')).toHaveAttribute('data-primary', 'true');
    await expect(game.quickBtn('emerg-ack')).toBeVisible();
    const rows = await sim.actions('BAW1');
    for (const id of ['emerg-ack', 'emerg-priority', 'emerg-dispatch', 'emerg-hold-all']) {
      expect(rows.find((r) => r.id === id)?.state, `${id} offered by the command tree`).toBe('enabled');
    }
  });

  test('acknowledge the MAYDAY through the stepper: POB / fuel / intentions, pilot answers with souls and fuel @full', async ({ openGame, sim }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'approach' });
    await sim.spawnAt(arrival('BAW1'));
    await sim.forceEmergency('BAW1', 'engine_fire');
    await game.openPanelFor('BAW1');

    await game.action('emerg-ack');
    expect(await game.stepType()).toBe('text');
    for (const chip of ['picker-info-pob', 'picker-info-fuel', 'picker-info-intentions']) {
      await expect(game.page.getByTestId(chip), `${chip} preselected`).toHaveAttribute('aria-pressed', 'true');
    }
    await expect(game.page.getByTestId('picker-info-nature')).not.toHaveAttribute('aria-pressed', 'true');
    await game.next();
    await expect(game.confirmSummary()).toContainText(/roger MAYDAY/i);
    const tx = await game.transmit();
    expect(tx.status).toBe('ok');
    expect(tx.tx).toMatch(/roger MAYDAY/i);
    expect(tx.tx).toMatch(/seven seven zero zero/i);
    const atc = await game.waitRadio(/roger MAYDAY/i, { who: 'ATC', callsign: 'BAW1' });
    expect(atc.text).toMatch(/persons on board|souls/i);

    // engine: status + checklist (acknowledge and souls_fuel are booked at transmission)
    const a = await sim.aircraftOrFail('BAW1');
    expect(a.emergency!.status).toBe('acknowledged');
    expect(a.emergency!.checklist.acknowledge).not.toBeNull();
    expect(a.emergency!.checklist.souls_fuel).not.toBeNull();
    expect(a.emergency!.checklist.priority_runway).toBeNull();

    // UI: band + checklist ticks
    await expect(game.emergBand()).toHaveAttribute('data-status', 'acknowledged');
    await expect(game.emergBandStatus()).toHaveText('acknowledged');
    await expect(game.emergCheck('acknowledge')).toHaveAttribute('data-done', 'true');
    await expect(game.emergCheck('souls_fuel')).toHaveAttribute('data-done', 'true');
    await expect(game.emergCheck('priority_runway')).toHaveAttribute('data-done', 'false');

    // the pilot answers after the readback delay
    await sim.advance(4.5);
    const reply = await game.waitRadio(/persons on board|souls on board/i, { who: 'PILOT', callsign: 'BAW1' });
    expect(reply.text).toMatch(/fuel/i);

    // acknowledging the MAYDAY on frequency does not acknowledge the ALERT: the card and the badge stay
    const em = (await sim.activeAlerts()).find((x) => x.kind === 'emergency')!;
    expect(em.ack).toBe(false);
    await expect(game.alertCard(em.id)).toBeVisible();
    await expect(game.alertsBell()).toHaveAttribute('data-count', '1');
  });

  test('priority runway 27L with a sterile runway: number one, cleared ILS, runway sterile in both ends, ATIS bumps @full', async ({ openGame, sim }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'approach' });
    await sim.spawnAt(arrival('BAW1'));
    await sim.forceEmergency('BAW1', 'engine_fire');
    await sim.dispatchAst({ kind: 'emergencyAck', callsign: 'BAW1', ask: ['pob', 'fuel', 'intentions'], squawk: true });
    const atis0 = (await sim.atis()).letter;
    expect((await sim.runwayStates()).find((r) => r.name === '27L')?.status).toBe('open');

    await game.openPanelFor('BAW1');
    await game.action('emerg-priority');
    expect(await game.stepType()).toBe('runway');
    await game.pickRunway('27L');
    await game.next();
    expect(await game.stepType()).toBe('text');
    await expect(game.page.getByTestId('picker-emerg-number-one')).toHaveAttribute('aria-pressed', 'true');
    await game.pickChip('picker-emerg-sterile');
    await game.next();
    await expect(game.confirmSummary()).toContainText(/two seven left/i);
    const tx = await game.transmit();
    expect(tx.code).toBe('ok_queued');
    expect(tx.tx).toMatch(/two seven left/i);
    expect(tx.tx).toMatch(/number one/i);
    expect(tx.tx).toMatch(/runway is yours/i);

    // the clearance lands after the pilot delay
    await sim.advance(4);
    const a = await sim.aircraftOrFail('BAW1');
    expect(a.emergency!.runway).toBe('27L');
    expect(a.emergency!.priority).toBe(true);
    expect(a.emergency!.sterile).toBe(true);
    expect(a.emergency!.checklist.priority_runway).not.toBeNull();
    expect(a.emergency!.checklist.hold_traffic).not.toBeNull();
    expect(a.assignedRunway).toBe('27L');
    expect(a.navMode).toBe('ils');
    expect(a.plan.runway).toBe('27L');
    const rws = await sim.runwayStates();
    expect(rws.find((r) => r.name === '27L')?.status).toBe('sterile');
    expect(rws.find((r) => r.name === '09R')?.status, 'both ends of the physical runway share the status').toBe('sterile');
    expect(rws.find((r) => r.name === '27R')?.status).toBe('open');
    expect(rws.find((r) => r.name === '27L')?.statusReason).toMatch(/BAW1/);
    expect((await sim.atis()).letter, 'a runway status change regenerates the ATIS').not.toBe(atis0);
    const pilot = await game.waitRadio(/cleared ILS two seven left/i, { who: 'PILOT', callsign: 'BAW1' });
    expect(pilot.text).toMatch(/number one/i);

    // UI: checklist ticks, band fields, the runway-status advisory card (info: does not count on the bell)
    await expect(game.emergCheck('priority_runway')).toHaveAttribute('data-done', 'true');
    await expect(game.emergCheck('hold_traffic')).toHaveAttribute('data-done', 'true');
    await expect(game.emergCheck('arff')).toHaveAttribute('data-done', 'false');
    await expect(game.emergBand()).toContainText(/27L sterile/);
    const rs = (await sim.activeAlerts()).find((x) => x.kind === 'runway_status');
    expect(rs?.severity).toBe('info');
    expect(rs?.title).toMatch(/09R\/27L sterile/);
    await expect(game.alertCard(rs!.id)).toHaveAttribute('data-severity', 'info');
    await expect(game.alertsBell()).toHaveAttribute('data-count', '1');
    await expect(game.atisChip()).toContainText(`ATIS ${(await sim.atis()).letter}`);
  });

  test('ARFF quick-dispatch: trucks roll and move, on scene before touchdown, landing closes the runway, reopen after inspection, trucks return @full', async ({ openGame, sim }) => {
    test.setTimeout(150_000);
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'approach' });
    await sim.spawnAt(arrival('BAW1'));
    await sim.forceEmergency('BAW1', 'engine_fire');
    await sim.dispatchAst({ kind: 'emergencyAck', callsign: 'BAW1', ask: ['pob', 'fuel', 'intentions'], squawk: true });
    await sim.dispatchAst({ kind: 'priority', callsign: 'BAW1', runway: '27L', straightIn: false, numberOne: true, sterile: true, clearIls: true });
    await sim.advance(4);
    expect((await sim.aircraftOrFail('BAW1')).emergency!.runway).toBe('27L');
    const atisSterile = (await sim.atis()).letter;

    // ── dispatch from the vehicles panel (ground map, TOWER) ──
    await game.setPosition('tower');
    await sim.waitMapReady();
    const fleet0 = (await sim.arff()).vehicles;
    expect(fleet0.length).toBeGreaterThanOrEqual(3);
    for (const v of fleet0) expect(v.state, `${v.id} at station before dispatch`).toBe('standby');
    await game.openVehiclesPanel();
    await expect(game.vehEmergency()).toHaveAttribute('data-callsign', 'BAW1');
    await expect(game.vehEmergency()).toContainText(/MAYDAY/);
    await expect(game.vehEmergency()).toContainText(/RWY 27L/);
    await expect(game.arffDispatchBtn()).toBeEnabled();
    await game.arffDispatchBtn().click();
    await expect(game.vehResult()).toHaveAttribute('data-ok', 'true');
    await expect(game.vehResult()).toContainText(/ARFF dispatched/);
    await expect(game.vehResult()).toContainText(/27L/);

    const enroute = (await sim.arff()).vehicles;
    expect(enroute.length).toBe(fleet0.length);
    for (const v of enroute) {
      expect(v.state, `${v.id} en route`).toBe('enroute');
      expect(v.target, `${v.id} tasked to the priority runway`).toBe('27L');
      await expect(game.arffVehicle(v.id)).toHaveAttribute('data-state', 'enroute');
      await expect(game.vehCardStatus(v.id)).toHaveAttribute('data-state', 'enroute');
    }
    let a = await sim.aircraftOrFail('BAW1');
    expect(a.emergency!.status).toBe('services_dispatched');
    expect(a.emergency!.arff).toBe('full');
    expect(a.emergency!.checklist.arff).not.toBeNull();
    await expect(game.arffDispatchBtn(), 'no ARFF left at station').toBeDisabled();
    const order = await sim.lastRadio('ATC');
    expect(order?.text).toMatch(/Fire 1, 2, 3, proceed to runway two seven left/i);
    expect(order?.text).toMatch(/runway is yours/i);

    // ── the trucks move on the map (screen projection changes over sim time) ──
    const p0: Record<string, { x: number; y: number }> = {};
    for (const v of enroute) { const p = await sim.vehicleScreenPos(v.id); expect(p).not.toBeNull(); p0[v.id] = p!; }
    await sim.advance(90);
    for (const v of enroute) {
      const p1 = await sim.vehicleScreenPos(v.id);
      expect(p1).not.toBeNull();
      const moved = Math.hypot(p1!.x - p0[v.id].x, p1!.y - p0[v.id].y);
      expect(moved, `${v.id} moved on screen after 90 s`).toBeGreaterThan(10);
      const now = (await sim.vehicle(v.id))!;
      expect(Math.hypot(now.pos.x - fleet0.find((f) => f.id === v.id)!.pos.x, now.pos.y - fleet0.find((f) => f.id === v.id)!.pos.y), `${v.id} left the station (engine metres)`).toBeGreaterThan(100);
    }
    // the fire station's own radio calls are queued by the fleet and land on the next step
    expect((await sim.radio()).some((l) => l.who === 'PILOT' && l.callsign === 'FIRE1' && /fire station copies, rolling/i.test(l.text)), 'fire station acknowledges on the radio').toBe(true);

    // ── on scene at the runway before the aircraft lands: all three trucks parked abeam the 27L touchdown zone ──
    await sim.advanceUntilOk("s => window.__atcTest.arff().vehicles.some(v => v.state === 'onscene')", 400);
    a = await sim.aircraftOrFail('BAW1');
    expect(a.emergency!.landedAt, 'still airborne when the first truck arrives').toBeNull();
    expect(['approach', 'landing']).toContain(a.phase);
    await expect(game.page.locator('[data-testid^="arff-vehicle-"][data-state="onscene"]').first()).toBeVisible();
    await sim.advanceUntilOk("s => window.__atcTest.arff().vehicles.every(v => v.state === 'onscene')", 200);
    a = await sim.aircraftOrFail('BAW1');
    expect(a.emergency!.landedAt, 'the headline scenario: 3 ARFF on scene before touchdown').toBeNull();
    const thr = (await sim.call<{ x: number; y: number } | null>('thresholdXY', '27L'))!;
    const hdg = ((await sim.runwayStates()).find((r) => r.name === '27L')!.headingTrue * Math.PI) / 180;
    for (const v of (await sim.arff()).vehicles) {
      const dx = v.pos.x - thr.x, dy = v.pos.y - thr.y;
      const along = dx * Math.sin(hdg) + dy * Math.cos(hdg);          // metres past the 27L threshold along the runway
      const cross = Math.abs(dx * Math.cos(hdg) - dy * Math.sin(hdg)); // metres off the centreline
      expect(along, `${v.id} inside the touchdown zone (300 m in)`).toBeGreaterThan(50);
      expect(along, `${v.id} not further down the runway than the touchdown zone`).toBeLessThan(900);
      expect(cross, `${v.id} parked beside the runway, not on it`).toBeGreaterThan(35);
      expect(cross, `${v.id} within the ARFF stand-by offset`).toBeLessThan(200);
      await expect(game.arffVehicle(v.id)).toHaveAttribute('data-state', 'onscene');
    }
    expect((await sim.radio()).filter((l) => l.who === 'PILOT' && /^FIRE\d/.test(l.callsign ?? '') && /in position runway 27L/i.test(l.text)).length, 'every truck reports in position on the radio').toBe(3);
    await sim.advance(1.5); // emergencyTick books arffOnSceneAt on the next sim second
    a = await sim.aircraftOrFail('BAW1');
    expect(a.emergency!.arffOnSceneAt).not.toBeNull();
    expect(a.onFrequency, 'auto-handed to tower on the ILS').toBe('tower');

    // ── cleared to land, touchdown, stop on the runway -> runway closed ──
    const atc = await game.sendOk('BAW1 CLEARED TO LAND 27L');
    expect(atc.text).toMatch(/cleared to land/i);
    await sim.advance(3.5);
    expect((await sim.aircraftOrFail('BAW1')).landingCleared).toBe(true);
    await sim.advanceUntilOk("s => { const a = s.aircraft.find(x => x.callsign === 'BAW1'); return !!a && !!a.emergency && a.emergency.landedAt != null; }", 400);
    a = await sim.aircraftOrFail('BAW1');
    expect(a.emergency!.status).toBe('landed');
    expect(a.emergency!.stopOnRunway, 'engine fire always stops on the runway').toBe(true);
    expect(a.emergency!.closureMin).toBeGreaterThan(0);
    expect(a.emergency!.arffOnSceneAt!).toBeLessThanOrEqual(a.emergency!.landedAt!);
    expect(a.phase).toBe('rollout');
    let rws = await sim.runwayStates();
    expect(rws.find((r) => r.name === '27L')?.status).toBe('closed');
    expect(rws.find((r) => r.name === '09R')?.status).toBe('closed');
    expect(rws.find((r) => r.name === '27L')?.statusReason).toMatch(/BAW1 stopping on the runway/);
    expect(rws.find((r) => r.name === '27L')?.occupiedBy.map((o) => o.callsign)).toContain('BAW1');
    expect((await sim.scoreEvents()).some((e) => e.code === 'ARFF_ON_TIME' && e.points > 0), 'ARFF on time bonus booked').toBe(true);
    expect((await sim.atis()).letter).not.toBe(atisSterile);
    await expect(game.vehRunwayStatus('27L')).toHaveAttribute('data-status', 'closed');
    await game.waitRadio(/touchdown runway 27L/i, { who: 'PILOT', callsign: 'BAW1' });

    await sim.advanceUntilOk("s => { const a = s.aircraft.find(x => x.callsign === 'BAW1'); return !!a && !!a.emergency && a.emergency.status === 'stopped'; }", 120);
    a = await sim.aircraftOrFail('BAW1');
    expect(a.emergency!.stoppedAt).not.toBeNull();
    expect(a.speed).toBeLessThan(1);
    expect(a.emergency!.checklist.runway_closed).not.toBeNull();
    expect(a.emergency!.checklist.runway_reopened).toBeNull();
    const em = (await sim.activeAlerts()).find((x) => x.kind === 'emergency' && x.subjects[0] === 'BAW1');
    expect(em?.severity, 'the emergency alert de-escalates once the aircraft is down').toBe('warning');
    await expect(game.strip('BAW1')).toBeVisible();
    await expect(game.strip('BAW1')).toHaveAttribute('data-phase', 'rollout');
    await game.openPanelFor('BAW1');
    await expect(game.emergBand()).toHaveAttribute('data-status', 'stopped');
    await expect(game.emergBandStatus()).toHaveText('stopped');
    await expect(game.emergCheck('runway_closed')).toHaveAttribute('data-done', 'true');
    await expect(game.emergCheck('runway_reopened')).toHaveAttribute('data-done', 'false');
    await expect(game.actionBtn('emerg-reopen')).toHaveAttribute('data-state', 'enabled');

    // ── reopen after inspection through the stepper: the aircraft is towed clear, the runway opens ──
    await game.action('emerg-reopen');
    expect(await game.stepType()).toBe('runway');
    await expect(game.page.getByTestId('picker-runway-27L')).toHaveAttribute('aria-pressed', 'true');
    await expect(game.page.getByTestId('picker-runway-27R'), 'an open runway cannot be reopened').toBeDisabled();
    await game.next();
    expect(await game.stepType()).toBe('text');
    await expect(game.page.getByTestId('picker-emerg-reopen-after-inspection')).toHaveAttribute('aria-pressed', 'true');
    await game.next();
    await expect(game.confirmStep()).toBeVisible();
    await expect(game.confirmSummary()).toContainText(/two seven left/i);
    await expect(game.page.getByTestId('confirm-transmit')).toHaveAttribute('data-state', 'enabled');
    await game.transmitBtn().click();
    // the towed aircraft leaves the sim, so the panel closes instead of showing a result plate
    await expect.poll(() => sim.aircraft('BAW1'), { message: 'BAW1 towed clear of the runway' }).toBeNull();
    await expect(game.strip('BAW1')).toHaveCount(0);
    rws = await sim.runwayStates();
    for (const r of rws) expect(r.status, `${r.name} open after the inspection`).toBe('open');
    expect(rws.find((r) => r.name === '27L')?.statusReason).toBe('inspection complete');
    expect(rws.find((r) => r.name === '27L')?.occupiedBy).toEqual([]);
    expect((await sim.scoreEvents()).some((e) => e.code === 'INSPECTION_CLEAN'), 'inspection bonus booked').toBe(true);
    await expect(game.vehRunwayStatus('27L')).toHaveCount(0);
    await expect(game.toast('info').filter({ hasText: /inspection clean/i })).toBeVisible();
    await sim.advance(6);
    expect((await sim.alertById(em!.id))?.resolvedAt, 'the emergency alert resolves once its subject is gone').not.toBeNull();
    await expect(game.alertCard(em!.id)).toHaveCount(0);

    // ── stand-down: trucks return to station ──
    await sim.advanceUntilOk("s => window.__atcTest.arff().vehicles.some(v => v.state === 'returning')", 1300);
    expect((await sim.arff()).vehicles.some((v) => v.state === 'returning')).toBe(true);
    await expect(game.page.locator('[data-testid^="arff-vehicle-"][data-state="returning"]').first()).toBeVisible();
    await sim.advanceUntilOk("s => window.__atcTest.arff().vehicles.every(v => v.state === 'standby')", 600);
    for (const v of (await sim.arff()).vehicles) {
      expect(v.state).toBe('standby');
      await expect(game.arffVehicle(v.id)).toHaveAttribute('data-state', 'standby');
      await expect(game.vehCardStatus(v.id)).toHaveAttribute('data-state', 'standby');
    }
    expect((await sim.radio()).filter((l) => /at station/.test(l.text)).length).toBeGreaterThanOrEqual(3);
  });

  test('medical PAN PAN: ambulance offered in the dispatch stepper and sent from the vehicles panel @full', async ({ openGame, sim }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'approach' });
    await sim.spawnAt(arrival('DLH2'));
    await sim.forceEmergency('DLH2', 'medical');

    const a0 = await sim.aircraftOrFail('DLH2');
    expect(a0.emergency!.level).toBe('PAN');
    expect(a0.emergency!.type).toBe('medical');
    expect(a0.emergency!.squawk).toBeNull();
    const pan = await sim.lastRadio('PILOT');
    expect(pan?.text).toMatch(/^PAN PAN PAN PAN PAN PAN/);
    expect(pan?.text).toMatch(/medical/i);
    const em = (await sim.activeAlerts()).find((x) => x.kind === 'emergency')!;
    expect(em.severity).toBe('critical');
    await expect(game.alertCard(em.id)).toHaveAttribute('data-kind', 'emergency');
    await expect(game.emergencyBanner('DLH2')).toBeVisible();
    await expect(game.stripEmerg('DLH2')).toHaveAttribute('data-level', 'PAN');
    await expect(game.stripEmerg('DLH2')).toContainText(/PAN · medical/);

    // the dispatch stepper for a medical offers ARFF + ambulance, ambulance preselected
    await game.openPanelFor('DLH2');
    await expect(game.emergBand()).toHaveAttribute('data-level', 'PAN');
    await expect(game.emergBand()).toHaveAttribute('data-type', 'medical');
    await game.action('emerg-dispatch');
    expect(await game.stepType()).toBe('vehicle');
    await expect(game.page.getByTestId('picker-vehicle-AMB1')).toHaveAttribute('data-state', 'enabled');
    await expect(game.page.getByTestId('picker-vehicle-AMB1')).toHaveAttribute('aria-pressed', 'true');
    await expect(game.page.getByTestId('picker-vehicle-FIRE1')).toHaveAttribute('aria-pressed', 'true');
    await expect(game.page.getByTestId('picker-vehicle-AMB1')).toHaveAttribute('data-vehicle-state', 'standby');
    await game.cancel();

    // quick ambulance from the vehicles panel (tower)
    await game.setPosition('tower');
    await sim.waitMapReady();
    await game.openVehiclesPanel();
    await expect(game.vehEmergency()).toHaveAttribute('data-callsign', 'DLH2');
    await expect(game.vehEmergency()).toContainText(/PAN/);
    await expect(game.ambulanceDispatchBtn()).toBeVisible();
    await expect(game.ambulanceDispatchBtn()).toBeEnabled();
    await game.ambulanceDispatchBtn().click();
    await expect(game.vehResult()).toHaveAttribute('data-ok', 'true');
    await expect(game.vehResult()).toContainText(/Medic 1/);

    const amb = await sim.vehicle('AMB1');
    expect(amb?.type).toBe('ambulance');
    expect(amb?.state).toBe('enroute');
    // no priority runway was assigned yet, so the quick dispatch targets the aircraft itself
    expect(amb?.target?.kind).toBe('aircraft');
    expect((amb?.target as { callsign?: string })?.callsign).toBe('DLH2');
    await expect(game.vehResult()).toContainText(/Medic 1 → DLH2/);
    const a = await sim.aircraftOrFail('DLH2');
    expect(a.emergency!.checklist.ambulance).not.toBeNull();
    expect(a.emergency!.status).toBe('services_dispatched');
    await expect(game.vehCardStatus('AMB1')).toHaveAttribute('data-state', 'enroute');
    await expect(game.ambulanceDispatchBtn(), 'the only ambulance is out').toBeDisabled();
    expect((await sim.radio()).some((l) => /Medic 1|AMB1/.test(l.text) && /DLH2/.test(l.text))).toBe(true);

    // the panel (selected from the store: the inbound strip lives in the APPROACH bay) shows the tick
    await sim.select('DLH2');
    await expect(game.panel()).toHaveAttribute('data-callsign', 'DLH2');
    await expect(game.emergCheck('ambulance')).toHaveAttribute('data-done', 'true');
    await expect(game.emergBand()).toHaveAttribute('data-status', 'services_dispatched');
  });

  test('fuel emergency: the countdown is visible on the strip, in the panel and on the alert card and follows sim time @full', async ({ openGame, sim }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'approach' });
    await sim.spawnAt(arrival('AFR3', { alongNM: -20, altFt: 6000 }));
    await sim.forceEmergency('AFR3', 'fuel');

    const a0 = await sim.aircraftOrFail('AFR3');
    const fuel0 = a0.emergency!.fuelMin;
    expect(fuel0).not.toBeNull();
    expect(fuel0!).toBeGreaterThanOrEqual(15);
    expect(fuel0!).toBeLessThanOrEqual(40);
    expect(a0.fuelMin).toBe(fuel0);
    expect(a0.emergency!.pilotLine).toMatch(/MAYDAY FUEL/);
    expect(a0.emergency!.pilotLine).toContain(`fuel ${Math.round(fuel0!)} minutes`);

    await game.openPanelFor('AFR3');
    await expect(game.emergBand()).toHaveAttribute('data-type', 'fuel');
    await expect(game.emergBandFuel()).toHaveText(`${Math.round(fuel0!)} min`);
    await expect(game.stripEmerg('AFR3')).toContainText(`fuel ${Math.round(fuel0!)} min`);
    const em = (await sim.activeAlerts()).find((x) => x.kind === 'emergency')!;
    await sim.advance(2); // the alert mirror refreshes its detail on the next alert pass; the stack re-renders per whole sim second
    await expect(game.alertItem(em.id)).toContainText(`fuel ${Math.round(fuel0! - 2 / 60)} min`);

    // two sim minutes later the countdown has moved by exactly two minutes, in the engine and in every readout
    await sim.advance(118);
    const a1 = await sim.aircraftOrFail('AFR3');
    expect(a1.emergency!.fuelMin!).toBeCloseTo(fuel0! - 2, 1);
    expect(a1.fuelMin!).toBeCloseTo(fuel0! - 2, 1);
    const shown = Math.round(fuel0! - 2);
    await expect(game.emergBandFuel()).toHaveText(`${shown} min`);
    await expect(game.stripEmerg('AFR3')).toContainText(`fuel ${shown} min`);
    await expect(game.alertItem(em.id)).toContainText(`fuel ${shown} min`);
    expect((await sim.alertById(em.id))?.detail).toContain(`fuel ${shown} min`);
    expect(a1.emergency!.status, 'no controller action yet').toBe('declared');
  });

  test('ignored emergency: the pilot re-calls every minute, the checklist deadlines cost -100 each and the top bar escalates @full', async ({ openGame, sim }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'approach' });
    await sim.spawnAt(arrival('UAL4', { alongNM: -25, altFt: 8000 }));
    await sim.forceEmergency('UAL4', 'engine_failure');
    await sim.clearEvents();
    const score0 = (await sim.snapshot()).score;
    const em = (await sim.activeAlerts()).find((x) => x.kind === 'emergency')!;
    await expect(game.topBar()).toHaveAttribute('data-escalated', 'false');

    // 60 s unanswered: "did you copy?" and the escalated top bar (unacked critical older than 10 s)
    await sim.advance(62);
    const recall = await game.waitRadio(/did you copy\?/i, { who: 'PILOT', callsign: 'UAL4' });
    expect(recall.text).toMatch(/^MAYDAY/);
    await expect(game.topBar()).toHaveAttribute('data-escalated', 'true');
    expect((await sim.scoreEvents()).filter((e) => e.code === 'EMERGENCY_CHECKLIST_MISS')).toHaveLength(0);

    // 180 s: souls / fuel never obtained -> EMERGENCY_CHECKLIST_MISS (-100)
    await sim.advance(120);
    let misses = (await sim.scoreEvents()).filter((e) => e.code === 'EMERGENCY_CHECKLIST_MISS');
    expect(misses).toHaveLength(1);
    expect(misses[0].points).toBe(-100);
    expect(misses[0].primary).toBe('UAL4');
    expect(misses[0].detail).toMatch(/Souls & fuel/);
    const expected = score0 + (await sim.scoreEvents()).reduce((s, e) => s + e.points, 0);
    expect((await sim.snapshot()).score).toBe(expected);
    await expect(game.score()).toHaveAttribute('data-value', String(expected));
    await expect(game.toast('error').filter({ hasText: /checklist miss/i })).toBeVisible();
    await expect(game.toast('error').filter({ hasText: /checklist miss/i })).toContainText(/Souls & fuel/);

    // three re-calls then the acknowledge deadline: a second -100
    await sim.advance(65);
    misses = (await sim.scoreEvents()).filter((e) => e.code === 'EMERGENCY_CHECKLIST_MISS');
    expect(misses).toHaveLength(2);
    expect(misses[1].detail).toMatch(/Acknowledge/);
    expect((await sim.radio()).filter((l) => l.callsign === 'UAL4' && /did you copy/i.test(l.text)).length).toBe(3);
    const a = await sim.aircraftOrFail('UAL4');
    expect(a.emergency!.status).toBe('declared');
    expect(a.emergency!.checklist.acknowledge).toBeNull();
    const al = await sim.alertById(em.id);
    expect(al?.ack).toBe(false);
    expect(al?.resolvedAt).toBeNull();
    await expect(game.alertCard(em.id)).toBeVisible();
    await expect(game.alertsBell()).toHaveAttribute('data-count', '1');
    await expect(game.score()).toHaveAttribute('data-value', String(score0 + (await sim.scoreEvents()).reduce((s, e) => s + e.points, 0)));
  });
});

// ────────────────────────────────────────────────────────────────────────────
//  Every catalogue entry (src/lib/sim/emergencies.ts EMERGENCY_CATALOGUE): declaration phraseology, strip band,
//  panel band + EMERG grid, alert card / bell. One test per type; airborne types on an inbound arrival (APPROACH bay),
//  brake_fire on a taxiing departure (GROUND bay).
// ────────────────────────────────────────────────────────────────────────────
interface CatalogueRow {
  level: 'MAYDAY' | 'PAN';
  /** Squawk the declaration sets (null = the aircraft keeps its own code). */
  squawk: string | null;
  /** Who speaks the declaration line and what it must contain. */
  who: 'PILOT' | 'SYS';
  line: RegExp;
  /** Type label on the strip band (StripCard EMERGENCY_TYPE). */
  stripLabel: string;
  ground?: boolean;
}
const CATALOGUE: Record<string, CatalogueRow> = {
  engine_fire: { level: 'MAYDAY', squawk: '7700', who: 'PILOT', line: /^MAYDAY MAYDAY MAYDAY, .+, engine fire number two, request immediate return, vectors ILS \d\d[LRC]?\.$/, stripLabel: 'engine fire' },
  engine_failure: { level: 'MAYDAY', squawk: '7700', who: 'PILOT', line: /^MAYDAY MAYDAY MAYDAY, .+, engine failure, request return, runway \d\d[LRC]?\.$/, stripLabel: 'engine failure' },
  medical: { level: 'PAN', squawk: null, who: 'PILOT', line: /^PAN PAN PAN PAN PAN PAN, .+, medical emergency, passenger unconscious, request priority landing and medical assistance on arrival\.$/, stripLabel: 'medical' },
  fuel: { level: 'MAYDAY', squawk: '7700', who: 'PILOT', line: /^MAYDAY MAYDAY MAYDAY, .+, MAYDAY FUEL, fuel \d+ minutes, request immediate landing runway \d\d[LRC]?\.$/, stripLabel: 'fuel' },
  depressurization: { level: 'MAYDAY', squawk: '7700', who: 'PILOT', line: /^MAYDAY MAYDAY MAYDAY, .+, emergency descent, depressurization, descending ten thousand, request nearest suitable airport\.$/, stripLabel: 'depress' },
  bird_strike: { level: 'PAN', squawk: null, who: 'PILOT', line: /^PAN PAN PAN PAN PAN PAN, .+, bird strike on rotation, request return, runway \d\d[LRC]?\.$/, stripLabel: 'bird strike' },
  gear: { level: 'PAN', squawk: null, who: 'PILOT', line: /^PAN PAN PAN PAN PAN PAN, .+, unsafe gear indication, request low approach for gear check, then hold to troubleshoot\.$/, stripLabel: 'gear' },
  smoke: { level: 'MAYDAY', squawk: '7700', who: 'PILOT', line: /^MAYDAY MAYDAY MAYDAY, .+, smoke in the cabin, request immediate landing, nearest runway, may evacuate on the runway\.$/, stripLabel: 'smoke' },
  hydraulic: { level: 'PAN', squawk: null, who: 'PILOT', line: /^PAN PAN PAN PAN PAN PAN, .+, hydraulic failure, request longest runway, will need to stop on the runway and tow, request no crossing traffic behind\.$/, stripLabel: 'hydraulic' },
  hijack: { level: 'MAYDAY', squawk: '7500', who: 'PILOT', line: /^.+, squawking seven five zero zero\.$/, stripLabel: 'hijack' },
  radio_failure: { level: 'PAN', squawk: '7600', who: 'SYS', line: /squawking 7600 — radio failure \(no transmissions\)$/, stripLabel: 'NORDO' },
  general: { level: 'MAYDAY', squawk: '7700', who: 'PILOT', line: /^MAYDAY MAYDAY MAYDAY, .+, flight control problem, request return, priority landing\.$/, stripLabel: 'emergency' },
  brake_fire: { level: 'PAN', squawk: null, who: 'PILOT', line: /^PAN PAN PAN PAN PAN PAN, .+, hot brakes, possible brake fire, request to hold on the taxiway and fire service check\.$/, stripLabel: 'brake fire', ground: true },
};

test.describe('emergencies: catalogue', () => {
  for (const [type, row] of Object.entries(CATALOGUE)) {
    test(`${type}: ${row.level} declaration on frequency, strip band, panel band + EMERG grid, alert card and bell @full`, async ({ openGame, sim }) => {
      const cs = 'EMG1';
      const game = await openGame({ icao: 'EGLL', spawn: 'none', position: row.ground ? 'ground' : 'approach' });
      if (row.ground) {
        await sim.spawnAt({ callsign: cs, type: 'A320', kind: 'departure', phase: 'taxi', gate: '512', taxiTo: '27R' });
        await sim.advance(10);                                          // rolling on the taxiway (stage taxi_out)
      } else {
        await sim.spawnAt(arrival(cs, { alongNM: -16, altFt: 5000 }));
      }
      const before = await sim.aircraftOrFail(cs);
      expect(before.emergency).toBeNull();
      await expect(game.strip(cs)).toHaveAttribute('data-emergency', 'false');
      const bell0 = await game.bellCount();

      await sim.forceEmergency(cs, type as Parameters<typeof sim.forceEmergency>[1]);

      // ── engine ──
      const a = await sim.aircraftOrFail(cs);
      expect(a.emergency).not.toBeNull();
      expect(a.emergency!.type).toBe(type);
      expect(a.emergency!.level).toBe(row.level);
      expect(a.emergency!.status).toBe('declared');
      expect(a.emergency!.squawk).toBe(row.squawk);
      expect(a.squawk).toBe(row.squawk ?? before.squawk);
      expect(a.emergency!.soulsOnBoard).toBeGreaterThan(0);
      expect(a.emergency!.declaredAt).toBeCloseTo(await sim.time(), 0);
      const decl = (await sim.radio()).filter((l) => l.callsign === cs && l.who === row.who).pop();
      expect(decl, 'declaration line logged').toBeTruthy();
      expect(decl!.text).toMatch(row.line);
      if (row.who === 'PILOT') expect(decl!.text).toBe(a.emergency!.pilotLine);
      const em = (await sim.activeAlerts()).find((x) => x.kind === 'emergency' && x.subjects[0] === cs);
      expect(em, 'an emergency alert is raised at declaration').toBeTruthy();
      expect(em!.severity).toBe('critical');
      expect(em!.ack).toBe(false);

      // ── comm log ──
      await game.waitRadio(row.line, { who: row.who, callsign: cs });

      // ── strip ──
      await expect(game.strip(cs)).toHaveAttribute('data-emergency', 'true');
      await expect(game.stripEmerg(cs)).toHaveAttribute('data-level', row.level);
      await expect(game.stripEmerg(cs)).toContainText(`${row.level} · ${row.stripLabel}`);
      await expect(game.stripAlert(cs)).toHaveText('EMERG');

      // ── alert stack + bell ──
      await expect(game.alertCard(em!.id)).toBeVisible();
      await expect(game.alertCard(em!.id)).toHaveAttribute('data-kind', 'emergency');
      await expect(game.alertCard(em!.id)).toHaveAttribute('data-severity', 'critical');
      await expect(game.emergencyBanner(cs)).toBeVisible();
      await expect(game.alertCardPair(em!.id, cs)).toBeVisible();
      await expect(game.alertsBell()).toHaveAttribute('data-count', String(bell0 + 1));
      await sim.advance(2);                                             // the alert mirror re-titles the card on the next pass; the stack re-renders per whole sim second
      await expect(game.alertItem(em!.id)).toContainText(row.level === 'PAN' ? 'PAN PAN' : 'MAYDAY');
      await expect(game.alertItem(em!.id)).toContainText(type.replace('_', ' '));

      // ── panel: band, checklist, emergency grid per the action matrix (priority runway only airborne) ──
      await game.openPanelFor(cs);
      await expect(game.panel()).toHaveAttribute('data-emergency', 'true');
      await expect(game.emergBand()).toHaveAttribute('data-level', row.level);
      await expect(game.emergBand()).toHaveAttribute('data-type', type);
      await expect(game.emergBand()).toHaveAttribute('data-status', 'declared');
      await expect(game.emergBand()).toContainText(row.level);
      await expect(game.emergBandPob()).toHaveText(String(a.emergency!.soulsOnBoard));
      await expect(game.emergBandStatus()).toHaveText('declared');
      await expect(game.emergChecklist()).toBeVisible();
      await expect(game.emergCheck('acknowledge')).toHaveAttribute('data-done', 'false');
      for (const id of ['emerg-ack', 'emerg-dispatch', 'emerg-hold-all']) await expect(game.actionBtn(id)).toHaveAttribute('data-state', 'enabled');
      await expect(game.actionBtn('emerg-ack')).toHaveAttribute('data-primary', 'true');
      if (row.ground) await expect(game.actionBtn('emerg-priority'), 'priority runway is hidden on the ground (G2 emerg-* row)').toHaveCount(0);
      else await expect(game.actionBtn('emerg-priority')).toHaveAttribute('data-state', 'enabled');
      const rows = await sim.actions(cs);
      expect(rows.filter((r) => r.group === 'emergency' && r.state === 'enabled').map((r) => r.id)).toEqual(expect.arrayContaining(['emerg-ack', 'emerg-dispatch', 'emerg-hold-all']));
      expect(rows.some((r) => r.id === 'emerg-priority')).toBe(!row.ground);
    });
  }

  test('emergency strips sort to the top of their bay @full', async ({ openGame, sim }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'approach' });
    await sim.spawnAt(arrival('BAW1', { alongNM: -12 }));
    await sim.spawnAt(arrival('DLH2', { alongNM: -18, altFt: 6000 }));
    await sim.spawnAt(arrival('AFR3', { alongNM: -24, altFt: 8000 }));
    expect(await game.bayCallsigns('INBOUND')).toEqual(['BAW1', 'DLH2', 'AFR3']);
    await sim.forceEmergency('AFR3', 'smoke');
    expect(await game.bayCallsigns('INBOUND')).toEqual(['AFR3', 'BAW1', 'DLH2']);
    await expect(game.bay('INBOUND').locator('[role="option"][data-testid^="strip-"]').first()).toHaveAttribute('data-emergency', 'true');
    // the alert filter of the bay keeps only the emergency
    await game.bayFilter('alert').click();
    await expect.poll(() => game.bayCallsigns('INBOUND')).toEqual(['AFR3']);
    await game.bayFilter('all').click();
    await expect.poll(() => game.bayCallsigns('INBOUND')).toEqual(['AFR3', 'BAW1', 'DLH2']);
  });
});

// ────────────────────────────────────────────────────────────────────────────
//  Emergency quick-actions driven through the panel (UX §G2 emerg-* rows): hold all / resume all, break off the other
//  arrival, stop-on-runway / vacate, cancel MAYDAY / PAN PAN, and the services dispatched from the panel stepper and
//  from the Vehicles panel flow (src/game/VehiclePanel).
// ────────────────────────────────────────────────────────────────────────────
test.describe('emergencies: actions and services', () => {
  test('hold all traffic (scope: all ground movement) holds the departures with R24, resume all releases them @smoke', async ({ openGame, sim }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'approach' });
    await sim.spawnAt(arrival('BAW1'));
    await sim.forceEmergency('BAW1', 'engine_fire');
    await sim.spawnAt({ callsign: 'DEP1', type: 'A320', kind: 'departure', phase: 'hold_short', runway: '27R', onFrequency: 'tower' });
    expect((await sim.actions('DEP1')).find((r) => r.id === 'action-lineup')?.state).toBe('enabled');

    await game.openPanelFor('BAW1');
    await game.action('emerg-hold-all');
    expect(await game.stepType()).toBe('text');
    await expect(game.page.getByTestId('picker-emerg-scope-departures'), 'departures preselected').toHaveAttribute('aria-pressed', 'true');
    await game.pickChip('picker-emerg-scope-all');
    await game.next();
    await expect(game.confirmSummary()).toContainText(/all aircraft hold position/i);
    const tx = await game.transmit();
    expect(tx.status).toBe('ok');
    expect(tx.tx).toMatch(/All stations, Heathrow Tower, emergency in progress, all aircraft hold position/);
    await game.waitRadio(/all aircraft hold position/i, { who: 'ATC' });

    // engine: the departure is held, its movement actions are R24, the emergency's hold_traffic item is ticked
    const d = await sim.aircraftOrFail('DEP1');
    expect(d.trafficHold).toBe(true);
    for (const id of ['action-lineup', 'action-takeoff', 'action-taxi-runway']) {
      const row = (await sim.actions('DEP1')).find((r) => r.id === id);
      expect(row?.state, `${id} blocked by the hold`).toBe('disabled');
      expect(row?.reason).toBe('R24');
    }
    let e = (await sim.aircraftOrFail('BAW1')).emergency!;
    expect(e.checklist.hold_traffic).not.toBeNull();
    expect(e.sterile).toBe(true);
    expect((await sim.actions('BAW1')).find((r) => r.id === 'emerg-resume-all')?.state, 'resume all offered while the hold is active').toBe('enabled');

    // UI: checklist tick, the HELD tag on the departure strip, the disabled buttons with the canonical reason
    await expect(game.emergCheck('hold_traffic')).toHaveAttribute('data-done', 'true');
    await expect(game.actionBtn('emerg-resume-all')).toHaveAttribute('data-state', 'enabled');
    await game.setPosition('tower');
    await expect(game.page.getByTestId('strip-DEP1-held')).toHaveText('HELD');
    await game.openPanelFor('DEP1');
    expect(await game.actionState('action-lineup')).toEqual({ state: 'disabled', reason: 'Emergency in progress' });
    expect(await game.actionState('action-takeoff')).toEqual({ state: 'disabled', reason: 'Emergency in progress' });

    // resume all from the emergency band
    await game.setPosition('approach');
    await game.openPanelFor('BAW1');
    await game.action('emerg-resume-all');
    const tx2 = await game.transmit();
    expect(tx2.status).toBe('ok');
    expect(tx2.tx).toMatch(/emergency terminated, resume normal operations/i);
    await game.waitRadio(/resume normal operations/i, { who: 'ATC' });
    expect((await sim.aircraftOrFail('DEP1')).trafficHold).toBe(false);
    expect((await sim.actions('DEP1')).find((r) => r.id === 'action-lineup')?.state).toBe('enabled');
    expect((await sim.actions('BAW1')).some((r) => r.id === 'emerg-resume-all')).toBe(false);
    await expect(game.actionBtn('emerg-resume-all')).toHaveCount(0);
    e = (await sim.aircraftOrFail('BAW1')).emergency!;
    expect(e.status, 'the emergency itself is untouched').toBe('declared');
    await game.setPosition('tower');
    await expect(game.page.getByTestId('strip-DEP1-held')).toHaveCount(0);
    await game.openPanelFor('DEP1');
    expect((await game.actionState('action-lineup')).state).toBe('enabled');
  });

  test('break off the other arrival on the same final: cancel approach + heading + altitude to the non-emergency aircraft @full', async ({ openGame, sim }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'approach' });
    await sim.spawnAt({ ...arrival('BAW1'), plan: { runway: '27L' } });
    await sim.forceEmergency('BAW1', 'engine_fire');
    // emerg-breakoff is hidden until another arrival is established on the same runway
    expect((await sim.actions('BAW1')).some((r) => r.id === 'emerg-breakoff')).toBe(false);
    await sim.spawnAt({ callsign: 'OTH1', type: 'A320', kind: 'arrival', phase: 'approach', posRel: { fromRunway: '27L', alongNM: -9, altFt: 2800 }, speedKts: 170, ils: '27L', plan: { runway: '27L' } });
    await sim.advance(1);
    const o0 = await sim.aircraftOrFail('OTH1');
    expect(o0.ilsCaptured).toBe(true);
    expect(o0.stage).toBe('arr_established');
    expect((await sim.actions('BAW1')).find((r) => r.id === 'emerg-breakoff')?.state).toBe('enabled');

    await game.openPanelFor('BAW1');
    await expect(game.actionBtn('emerg-breakoff')).toHaveAttribute('data-state', 'enabled');
    await game.action('emerg-breakoff');
    expect(await game.stepType()).toBe('aircraft');
    await expect(game.page.getByTestId('picker-emerg-break-OTH1')).toBeVisible();
    await expect(game.page.getByTestId('picker-emerg-break-BAW1'), 'the emergency itself is not a break-off candidate').toHaveCount(0);
    await game.page.getByTestId('picker-emerg-break-OTH1').click();
    await game.next();
    expect(await game.stepType()).toBe('heading');
    await game.dial(360);
    await game.next();
    expect(await game.stepType()).toBe('altitude');
    await game.ladderAlt(4000);
    await game.next();
    await expect(game.confirmSummary()).toContainText(/Oscar Tango Hotel one, cancel approach clearance/i);
    await expect(game.confirmSummary()).toContainText(/emergency traffic/i);
    const tx = await game.transmit();
    expect(tx.code).toBe('ok_queued');
    expect(tx.tx).toMatch(/cancel approach clearance/i);
    expect(tx.tx).toMatch(/heading tree six zero/i);
    expect(tx.tx).toMatch(/climb to four thousand/i);
    const atc = await game.waitRadio(/cancel approach clearance/i, { who: 'ATC', callsign: 'OTH1' });
    expect(atc.text).toMatch(/emergency traffic/i);

    await sim.advance(3.5);
    await game.showAllFrequencies();                                    // OTH1 was auto-handed to tower on the ILS: its readback is on 118.5
    const o = await sim.aircraftOrFail('OTH1');
    expect(o.navMode).toBe('heading');
    expect(o.ilsArmed).toBe(false);
    expect(o.ilsCaptured).toBe(false);
    expect(o.cmdAltitude).toBe(4000);
    expect(Math.abs(((o.targetHeading % 360) + 360) % 360 - 0) < 2 || Math.abs(o.targetHeading - 360) < 2, 'target heading 360').toBe(true);
    expect(o.stage).toBe('arr_inbound');
    const rb = await game.waitRadio(/cancel approach/i, { who: 'PILOT', callsign: 'OTH1' });
    expect(rb.text).toMatch(/climb four thousand/i);
    await expect(game.strip('OTH1')).toHaveAttribute('data-stage', 'arr_inbound');
    const b = await sim.aircraftOrFail('BAW1');
    expect(b.emergency!.status, 'the emergency aircraft is untouched').toBe('declared');
    expect(b.pendingCmds).toHaveLength(0);
  });

  test('stop on runway / vacate if able: the post-landing instruction is recorded with the vacate taxiway @full', async ({ openGame, sim }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'approach' });
    await sim.spawnAt(arrival('BAW1'));
    await sim.forceEmergency('BAW1', 'hydraulic');
    // not on final yet: the row is hidden (G2: emerg-stop-runway only in arr_final / arr_short_final / rollout)
    expect((await sim.actions('BAW1')).some((r) => r.id === 'emerg-stop-runway')).toBe(false);
    await game.openPanelFor('BAW1');
    await expect(game.actionBtn('emerg-stop-runway')).toHaveCount(0);
    await sim.remove('BAW1');

    await sim.spawnAt({ callsign: 'FIN2', type: 'A320', kind: 'arrival', phase: 'approach', posRel: { fromRunway: '27R', alongNM: -6, altFt: 1900 }, speedKts: 160, ils: '27R', plan: { runway: '27R' }, onFrequency: 'tower' });
    await sim.forceEmergency('FIN2', 'hydraulic');
    await sim.advance(1);
    const f0 = await sim.aircraftOrFail('FIN2');
    expect(f0.stage).toBe('arr_final');
    expect(f0.emergency!.stopOnRunway).toBe(false);
    expect((await sim.actions('FIN2')).find((r) => r.id === 'emerg-stop-runway')?.state).toBe('enabled');

    await game.setPosition('tower');
    await game.openPanelFor('FIN2');
    await expect(game.emergBand()).toHaveAttribute('data-type', 'hydraulic');
    await game.action('emerg-stop-runway');
    expect(await game.stepType()).toBe('text');
    await expect(game.page.getByTestId('picker-emerg-stop-stop'), 'stop on the runway preselected').toHaveAttribute('aria-pressed', 'true');
    await game.pickChip('picker-emerg-stop-vacate-if-able');
    await game.next();
    expect(await game.stepType()).toBe('taxiway');
    const twy = game.page.locator('[data-testid^="picker-taxiway-"]:not([data-testid$="-search"]):not([data-testid$="-wrap"])').first();
    const twyName = ((await twy.getAttribute('data-testid')) ?? '').slice('picker-taxiway-'.length);
    expect(twyName).toMatch(/^[A-Z0-9]+$/);
    await twy.click();
    await game.next();
    await expect(game.confirmSummary()).toContainText(/vacate/i);
    const tx = await game.transmit();
    expect(tx.code).toBe('ok_queued');
    expect(tx.tx).toMatch(/vacate/i);
    await game.waitRadio(/vacate/i, { who: 'ATC', callsign: 'FIN2' });

    await sim.advance(3.5);
    const f = await sim.aircraftOrFail('FIN2');
    expect(f.emergency!.stopOnRunway).toBe(false);
    expect(f.emergency!.requests).toContain('vacate_if_able');
    expect((await sim.state('FIN2'))?.exitTaxiway).toBe(twyName);
    const rb = await game.waitRadio(/vacating if able via/i, { who: 'PILOT', callsign: 'FIN2' });
    expect(rb.text).toMatch(/Foxtrot India November two/);
    await expect(game.emergBand()).toHaveAttribute('data-status', 'declared');
    await expect(game.emergBand()).toContainText('vacate_if_able');
  });

  test('cancel PAN PAN: the pilot request band answers with "roger, PAN PAN cancelled" and every emergency surface clears @smoke', async ({ openGame, sim }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'approach' });
    await sim.spawnAt(arrival('DLH2'));
    const sq0 = (await sim.aircraftOrFail('DLH2')).squawk;
    await sim.forceEmergency('DLH2', 'medical');
    const em = (await sim.activeAlerts()).find((x) => x.kind === 'emergency')!;
    await expect(game.alertCard(em.id)).toBeVisible();
    await sim.request('DLH2', 'cancel_mayday');
    await game.waitRadio(/cancel PAN PAN, problem resolved/i, { who: 'PILOT', callsign: 'DLH2' });

    await game.openPanelFor('DLH2');
    await expect(game.reqBand()).toHaveAttribute('data-request', 'cancel_mayday');
    await expect(game.reqAnswer()).toContainText(/mayday cancelled/i);
    await expect(game.actionBtn('emerg-cancel-ack')).toHaveAttribute('data-state', 'enabled');
    expect((await sim.actions('DLH2')).find((r) => r.id === 'emerg-cancel-ack')?.state).toBe('enabled');
    await game.reqAnswer().click();
    await expect(game.confirmStep()).toBeVisible();
    await expect(game.confirmSummary()).toContainText(/roger, PAN PAN cancelled/i);
    const tx = await game.transmit();
    expect(tx.status).toBe('ok');
    expect(tx.tx).toMatch(/Lufthansa two, roger, PAN PAN cancelled\./);
    await game.waitRadio(/roger, PAN PAN cancelled/i, { who: 'ATC', callsign: 'DLH2' });

    // engine: resolved, priority dropped, squawk untouched (PAN has none), alert resolved, request answered
    const a = await sim.aircraftOrFail('DLH2');
    expect(a.emergency!.status).toBe('resolved');
    expect(a.emergency!.resolvedAt).not.toBeNull();
    expect(a.squawk).toBe(sq0);
    expect(a.requests.every((r) => r.answeredAt != null)).toBe(true);
    expect((await sim.alertById(em.id))?.resolvedAt).not.toBeNull();
    expect((await sim.scoreEvents()).some((e) => e.code === 'EMERGENCY_DONE'), 'EMERGENCY_DONE booked at resolution').toBe(true);
    await game.waitRadio(/emergency resolved \(cancelled by pilot\)/i, { who: 'SYS', callsign: 'DLH2' });

    // UI: band, strip band, alert card and bell all gone; the resolved toast shows; no emerg-* buttons remain
    await expect(game.emergBand()).toHaveCount(0);
    await expect(game.panel()).not.toHaveAttribute('data-emergency', 'true');
    await expect(game.reqBand()).toHaveCount(0);
    await expect(game.stripEmerg('DLH2')).toHaveCount(0);
    await expect(game.strip('DLH2')).toHaveAttribute('data-emergency', 'false');
    await expect(game.stripAlert('DLH2')).toHaveCount(0);
    await expect(game.alertCard(em.id)).toHaveCount(0);
    await expect(game.alertsBell()).toHaveAttribute('data-count', '0');
    await expect(game.toast('success').filter({ hasText: /Emergency resolved · DLH2/ })).toBeVisible();
    await expect(game.page.locator('[data-testid^="emerg-"][data-state]')).toHaveCount(0);
    await sim.advance(2);
    await expect(game.emergBand()).toHaveCount(0);
  });

  test('cancel MAYDAY after a sterile priority runway: the runway reopens, the ATIS bumps, the emergency alert resolves @full', async ({ openGame, sim, browserConsole }) => {
    // The emergency alert and the "27L sterile" advisory resolve in the same tick: AlertStack keys both resolved pills with
    // the same Date.now() (src/game/AlertStack/AlertStack.tsx:114) — covered by the fixme in 65-alerts.spec.ts; tolerated here.
    browserConsole.allow(/Encountered two children with the same key/);
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'approach' });
    await sim.spawnAt(arrival('BAW1'));
    await sim.forceEmergency('BAW1', 'engine_fire');
    await sim.dispatchAst({ kind: 'emergencyAck', callsign: 'BAW1', ask: ['pob', 'fuel', 'intentions'], squawk: true });
    await sim.dispatchAst({ kind: 'priority', callsign: 'BAW1', runway: '27L', straightIn: false, numberOne: true, sterile: true, clearIls: true });
    await sim.advance(4);
    expect((await sim.runwayStates()).find((r) => r.name === '27L')?.status).toBe('sterile');
    expect((await sim.aircraftOrFail('BAW1')).squawk).toBe('7700');
    const atis0 = (await sim.atis()).letter;
    const em = (await sim.activeAlerts()).find((x) => x.kind === 'emergency')!;

    await sim.request('BAW1', 'cancel_mayday');
    await game.waitRadio(/cancel MAYDAY, problem resolved/i, { who: 'PILOT', callsign: 'BAW1' });
    await game.openPanelFor('BAW1');
    await expect(game.reqBand()).toHaveAttribute('data-request', 'cancel_mayday');
    await expect(game.stripReq('BAW1')).toBeVisible();
    await game.action('emerg-cancel-ack');
    await expect(game.confirmSummary()).toContainText(/roger, MAYDAY cancelled/i);
    const tx = await game.transmit();
    expect(tx.status).toBe('ok');
    expect(tx.tx).toMatch(/Speedbird one, roger, MAYDAY cancelled\./);
    await game.waitRadio(/roger, MAYDAY cancelled/i, { who: 'ATC', callsign: 'BAW1' });

    const a = await sim.aircraftOrFail('BAW1');
    expect(a.emergency!.status).toBe('resolved');
    expect(a.assignedRunway, 'the ILS clearance survives the cancellation').toBe('27L');
    expect(a.navMode).toBe('ils');
    const rws = await sim.runwayStates();
    expect(rws.find((r) => r.name === '27L')?.status).toBe('open');
    expect(rws.find((r) => r.name === '27L')?.statusReason).toBe('emergency resolved');
    expect(rws.find((r) => r.name === '09R')?.status).toBe('open');
    expect((await sim.atis()).letter, 'reopening the runway regenerates the ATIS').not.toBe(atis0);
    expect((await sim.alertById(em.id))?.resolvedAt).not.toBeNull();
    const rs = (await sim.alerts()).filter((x) => x.kind === 'runway_status' && x.subjects[0] === '09R/27L');
    expect(rs).toHaveLength(1);
    expect(rs[0].title).toMatch(/09R\/27L sterile/);
    expect(rs[0].resolvedAt, 'the sterile advisory resolves when the runway reopens').not.toBeNull();

    await expect(game.emergBand()).toHaveCount(0);
    await expect(game.stripEmerg('BAW1')).toHaveCount(0);
    await expect(game.alertCard(em.id)).toHaveCount(0);
    await expect(game.alertsBell()).toHaveAttribute('data-count', '0');
    await expect(game.toast('success').filter({ hasText: /Emergency resolved · BAW1/ })).toBeVisible();
    await expect(game.atisChip()).toContainText(`ATIS ${(await sim.atis()).letter}`);
    await game.openAlertsDrawer();
    await expect(game.alertsRowState(em.id)).toHaveAttribute('data-state', 'resolved');
  });

  test('cancel MAYDAY drops the 7700 squawk @full', async ({ openGame, sim }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'approach' });
    await sim.spawnAt(arrival('BAW1'));
    const sq0 = (await sim.aircraftOrFail('BAW1')).squawk;
    await sim.forceEmergency('BAW1', 'engine_fire');
    expect((await sim.aircraftOrFail('BAW1')).squawk).toBe('7700');
    await sim.request('BAW1', 'cancel_mayday');
    await game.openPanelFor('BAW1');
    await game.action('emerg-cancel-ack');
    const tx = await game.transmit();
    expect(tx.status).toBe('ok');
    const a = await sim.aircraftOrFail('BAW1');
    expect(a.emergency!.status).toBe('resolved');
    expect(a.squawk).not.toBe('7700');
    expect(a.squawk).toBe(sq0);
    await sim.advance(2);
    await expect(game.strip('BAW1')).not.toContainText('7700');
  });

  test('brake fire on the taxiway: local standby (2 ARFF) sent to the aircraft position from the panel stepper, trucks reach it, ARFF on time, recall from the Vehicles panel @full', async ({ openGame, sim }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'ground', waitMap: true });
    await sim.spawnAt({ callsign: 'GND1', type: 'A320', kind: 'departure', phase: 'taxi', gate: '512', taxiTo: '27R' });
    await sim.advance(30);
    await sim.forceEmergency('GND1', 'brake_fire');
    await sim.clearEvents();
    await game.openPanelFor('GND1');
    await expect(game.emergBand()).toHaveAttribute('data-type', 'brake_fire');
    await expect(game.emergBand()).toHaveAttribute('data-level', 'PAN');

    await game.action('emerg-dispatch');
    expect(await game.stepType()).toBe('vehicle');
    // brake fire = local standby: FIRE1 + FIRE2 preselected, FIRE3 available, no ambulance preselected
    for (const id of ['FIRE1', 'FIRE2']) await expect(game.page.getByTestId(`picker-vehicle-${id}`)).toHaveAttribute('aria-pressed', 'true');
    await expect(game.page.getByTestId('picker-vehicle-FIRE3')).toHaveAttribute('aria-pressed', 'false');
    await expect(game.page.getByTestId('picker-vehicle-FIRE3')).toHaveAttribute('data-vehicle-state', 'standby');
    await expect(game.page.getByTestId('picker-vehicle-AMB1')).toHaveAttribute('aria-pressed', 'false');
    await game.next();
    expect(await game.stepType()).toBe('text');
    await expect(game.page.getByTestId('picker-emerg-location-runway')).toHaveAttribute('aria-pressed', 'true');
    await game.pickChip('picker-emerg-location-aircraft');
    await game.next();
    await expect(game.confirmSummary()).toContainText(/Fire 1, Fire 2, proceed to the GND1/);
    const tx = await game.transmit();
    expect(tx.status).toBe('ok');
    expect(tx.tx).toMatch(/Fire 1, Fire 2, proceed to the GND1\./);
    await game.waitRadio(/Fire 1, Fire 2, proceed to the GND1/, { who: 'ATC' });

    // engine: two trucks en route to the aircraft, FIRE3 at station, checklist + status
    const fleet = (await sim.arff()).vehicles;
    expect(fleet.filter((v) => v.state === 'enroute' && v.target === 'GND1').map((v) => v.id).sort()).toEqual(['FIRE1', 'FIRE2']);
    expect(fleet.find((v) => v.id === 'FIRE3')?.state).toBe('standby');
    let g = await sim.aircraftOrFail('GND1');
    expect(g.emergency!.status).toBe('services_dispatched');
    expect(g.emergency!.arff).toBe('local');
    expect(g.emergency!.checklist.arff).not.toBeNull();
    expect(g.emergency!.arffOnSceneAt).toBeNull();
    await expect(game.emergCheck('arff')).toHaveAttribute('data-done', 'true');
    await expect(game.emergBandStatus()).toHaveText('services dispatched');
    await expect(game.emergBand()).toHaveAttribute('data-status', 'services_dispatched');

    // the trucks leave the station and reach the aircraft; the panel and the strip bay mirror the states
    const station = fleet.find((v) => v.id === 'FIRE1')!.pos;
    await game.openVehiclesPanel();
    await expect(game.vehEmergency()).toHaveAttribute('data-callsign', 'GND1');
    await expect(game.vehEmergency()).toContainText(/2 ARFF responding/);
    for (const id of ['FIRE1', 'FIRE2']) await expect(game.vehCardStatus(id)).toHaveAttribute('data-state', 'enroute');
    await expect(game.vehCardStatus('FIRE3')).toHaveAttribute('data-state', 'standby');
    await expect(game.page.getByTestId('strip-vehicle-FIRE1')).toBeVisible();
    await expect(game.page.getByTestId('strip-vehicle-FIRE1')).toHaveAttribute('data-state', 'enroute');
    await expect(game.page.getByTestId('strip-vehicle-FIRE1-state')).toHaveText(/en route/i);
    const took = await sim.advanceUntilOk("s => window.__atcTest.arff().vehicles.filter(v => v.state === 'onscene').length >= 1", 240);
    expect(took).toBeLessThanOrEqual(180);
    await sim.advance(2);
    g = await sim.aircraftOrFail('GND1');
    expect(g.emergency!.arffOnSceneAt).not.toBeNull();
    const now = (await sim.arff()).vehicles;
    const first = now.find((v) => v.state === 'onscene')!;
    expect(Math.hypot(first.pos.x - g.pos.x, first.pos.y - g.pos.y), `${first.id} parked abeam the aircraft`).toBeLessThan(200);
    expect(Math.hypot(first.pos.x - station.x, first.pos.y - station.y)).toBeGreaterThan(300);
    expect(now.find((v) => v.id === 'FIRE3')?.state).toBe('standby');
    expect((await sim.scoreEvents()).some((e) => e.code === 'ARFF_ON_TIME' && e.points > 0), 'ARFF on time (within 3 min) is rewarded').toBe(true);
    await expect(game.vehCardStatus(first.id)).toHaveAttribute('data-state', 'onscene');
    await expect(game.arffVehicle(first.id)).toHaveAttribute('data-state', 'onscene');
    await game.waitRadio(/Fire \d in position at GND1/i, { who: 'PILOT' });
    await expect(game.toast('success').filter({ hasText: /arff on time/i })).toBeVisible();

    // recall the first truck from its card: returning, then home at station
    await game.vehCardRecall(first.id).click();
    expect((await sim.vehicle(first.id))?.state).toBe('returning');
    expect((await sim.vehicle(first.id))?.target).toEqual({ kind: 'station' });
    await sim.advance(1);                                               // the card re-renders on the next sim second (65-alerts fixme: in-place mutation vs useSim)
    await expect(game.vehCardStatus(first.id)).toHaveAttribute('data-state', 'returning');
    await expect(game.vehCardRecall(first.id), 'recall is one-shot').toBeDisabled();
    await game.waitRadio(new RegExp(`${first.id} returning to station`), { who: 'SYS' });
    await sim.advanceUntilOk(`s => window.__atcTest.vehicles().some(v => v.id === '${first.id}' && v.state === 'standby')`, 400);
    const home = (await sim.vehicle(first.id))!;
    expect(Math.hypot(home.pos.x - station.x, home.pos.y - station.y)).toBeLessThan(5);
    await expect(game.vehCardStatus(first.id)).toHaveAttribute('data-state', 'standby');
    await expect(game.page.getByTestId(`veh-card-${first.id}-dispatch`)).toBeVisible();
  });

  test('Recall on a Vehicles panel card updates the card state at once (no sim tick needed) @full', async ({ openGame, sim }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'tower', waitMap: true });
    await sim.spawnAt(arrival('BAW1'));
    await sim.forceEmergency('BAW1', 'engine_fire');
    await game.openVehiclesPanel();
    await game.arffDispatchBtn().click();
    await expect(game.vehCardStatus('FIRE1')).toHaveAttribute('data-state', 'enroute');
    await sim.advance(5);
    await game.vehCardRecall('FIRE1').click();
    expect((await sim.vehicle('FIRE1'))?.state).toBe('returning');
    await expect(game.vehCardStatus('FIRE1')).toHaveAttribute('data-state', 'returning', { timeout: 2_000 });
    await expect(game.vehCardRecall('FIRE1')).toBeDisabled({ timeout: 2_000 });
  });

  test('Vehicles panel dispatch flow: ambulance to the selected aircraft, it drives there, on scene, recall home @full', async ({ openGame, sim }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'ground', waitMap: true });
    const veh = new VehiclePanelPage(game.page);
    await sim.spawnAt({ callsign: 'GND2', type: 'A320', kind: 'departure', phase: 'taxi', gate: '401', taxiTo: '27R' });
    await sim.advance(30);
    await sim.forceEmergency('GND2', 'medical');
    await game.openPanelFor('GND2');
    await expect(game.emergBand()).toHaveAttribute('data-type', 'medical');
    await expect(game.emergCheck('ambulance')).toHaveAttribute('data-done', 'false');

    await veh.open();
    await expect(game.vehEmergency()).toHaveAttribute('data-callsign', 'GND2');
    await expect(game.vehEmergency()).toContainText(/PAN · GND2/);
    await expect(veh.cardStatus('AMB1')).toHaveAttribute('data-state', 'standby');
    await veh.startDispatch('AMB1');
    expect(await veh.step()).toBe('target');
    await expect(veh.target('aircraft'), 'the selected aircraft is offered as the target').toHaveText('GND2');
    await veh.pickTarget({ kind: 'aircraft' });
    await expect(veh.target('aircraft')).toHaveAttribute('aria-pressed', 'true');
    const r = await veh.confirmDispatch();
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/Medic 1 → GND2 · ETA \d\d:\d\d/);
    await expect(veh.result()).toHaveAttribute('data-ok', 'true');

    // engine: ambulance en route to the aircraft with an ETA, checklist ticked, status services_dispatched
    const amb0 = (await sim.vehicle('AMB1'))!;
    expect(amb0.state).toBe('enroute');
    expect(amb0.target).toEqual({ kind: 'aircraft', id: (await sim.aircraftOrFail('GND2')).id, callsign: 'GND2' });
    expect(amb0.etaAt).not.toBeNull();
    const g0 = await sim.aircraftOrFail('GND2');
    expect(g0.emergency!.checklist.ambulance).not.toBeNull();
    expect(g0.emergency!.status).toBe('services_dispatched');
    await expect(veh.cardStatus('AMB1')).toHaveAttribute('data-state', 'enroute');
    await expect(veh.cardEta('AMB1')).toHaveAttribute('data-value', /^\d+$/);
    await expect(veh.card('AMB1')).toContainText(/→ GND2/);
    await game.waitRadio(/Medic 1, proceed to the GND2/, { who: 'ATC' });
    await expect(veh.root()).toHaveAttribute('data-responding', '1');

    // it moves on the map and in engine metres
    const p0 = await sim.vehicleScreenPos('AMB1');
    await sim.advance(60);
    const p1 = await sim.vehicleScreenPos('AMB1');
    const amb1 = (await sim.vehicle('AMB1'))!;
    expect(Math.hypot(amb1.pos.x - amb0.pos.x, amb1.pos.y - amb0.pos.y)).toBeGreaterThan(200);
    expect(Math.hypot(p1!.x - p0!.x, p1!.y - p0!.y), 'moved on screen after 60 s').toBeGreaterThan(10);
    const eta = Number(await veh.cardEta('AMB1').getAttribute('data-value'));
    expect(eta).toBeLessThan(amb0.etaAt! - (await sim.time()) + 61);

    await sim.advanceUntilOk("s => window.__atcTest.vehicles().some(v => v.id === 'AMB1' && v.state === 'onscene')", 400);
    const g = await sim.aircraftOrFail('GND2');
    const amb = (await sim.vehicle('AMB1'))!;
    expect(Math.hypot(amb.pos.x - g.pos.x, amb.pos.y - g.pos.y), 'the ambulance stops abeam the aircraft').toBeLessThan(200);
    expect(amb.onSceneUntil).not.toBeNull();
    await expect(veh.cardStatus('AMB1')).toHaveAttribute('data-state', 'onscene');
    await game.waitRadio(/Medic 1 in position at GND2/, { who: 'PILOT' });

    // recall from the card
    await veh.recallBtn('AMB1').click();
    expect((await sim.vehicle('AMB1'))?.state).toBe('returning');
    await sim.advance(1);                                               // the card re-renders on the next sim second (65-alerts fixme: in-place mutation vs useSim)
    await expect(veh.cardStatus('AMB1')).toHaveAttribute('data-state', 'returning');
    await game.waitRadio(/Medic 1, return to base/, { who: 'ATC' });
    await sim.advanceUntilOk("s => window.__atcTest.vehicles().some(v => v.id === 'AMB1' && v.state === 'standby')", 600);
    await expect(veh.cardStatus('AMB1')).toHaveAttribute('data-state', 'standby');
    await expect(veh.root()).toHaveAttribute('data-responding', '0');
    const home = (await sim.vehicle('AMB1'))!;
    expect(Math.hypot(home.pos.x - home.station.x, home.pos.y - home.station.y)).toBeLessThan(5);
    expect(home.target).toBeNull();
  });
});
