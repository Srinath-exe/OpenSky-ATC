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

    // ── on scene at the runway before the aircraft lands ──
    await sim.advanceUntilOk("s => window.__atcTest.arff().vehicles.some(v => v.state === 'onscene')", 400);
    a = await sim.aircraftOrFail('BAW1');
    expect(a.emergency!.landedAt, 'still airborne when the first truck arrives').toBeNull();
    expect(['approach', 'landing']).toContain(a.phase);
    await expect(game.page.locator('[data-testid^="arff-vehicle-"][data-state="onscene"]').first()).toBeVisible();
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
