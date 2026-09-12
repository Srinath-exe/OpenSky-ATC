/*
  Top bar + shell chrome (src/game/NavBar/NavBar.tsx, GameShell/useShellHotkeys.ts, HelpOverlay, PauseMenu,
  SettingsModal, StatsPanel, AtisWeather, AlertStack, TxIndicator; UX 04 §2.1 top bar, §G6 hotkeys, §10 ids):
    - position tabs (click, F1-F3, [ ]) with aria-pressed / aria-selected and the shell data-mode
    - pause (button, Space) with data-state=paused|running; the sim clock is frozen while paused
    - rates 1x / 2x / 4x (aria-pressed, data-state) + hotkeys 1 / 2 / 4 , . ; the store rate scales real time
    - ATIS chip -> panel (letter, wind, QNH, active runways match the store ATIS; setWind advances the letter)
    - score chip -> stats popover with breakdown rows fed by the score ledger
    - bell -> alerts drawer; badge follows unacknowledged alerts; ack via the stack card
    - TX indicator lights on a transmission; aria-pressed mirrors the ATC voice toggle
    - help overlay (? and the help button): tabs, search, close, Escape
    - pause menu (Esc with nothing selected): resume / restart (same seed) / quit -> home
    - settings modal: toggles apply live to the store; "All settings" opens /settings
    - hotkeys are inert while the command line has focus; Escape blurs it first
*/
import { test, expect, type SimApi } from './fixtures/test';

const A320 = 'A320';

async function spawnArrival(sim: SimApi, cs = 'UAL9'): Promise<void> {
  await sim.spawnAt({ callsign: cs, type: A320, kind: 'arrival', phase: 'descent', posRel: { fromRunway: '27L', alongNM: -20, offsetNM: -6, altFt: 8000 }, heading: 90, speedKts: 250 });
}

const pad = (n: number, w: number) => String(Math.round(n)).padStart(w, '0');

test.describe('nav bar and shell chrome', () => {
  test('position tabs: click, F1 / F2 / F3 and [ ] switch the position (aria-pressed, data-mode, view) @smoke', async ({ openGame, sim, page }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'ground', settings: { strictFrequencies: true } });
    let changed = false;                                                                   // aria-pressed is asserted after the first change (see the fixme below for boot)
    const expectPos = async (p: 'ground' | 'tower' | 'approach') => {
      await expect(game.modeTab(p)).toHaveAttribute('aria-selected', 'true');
      for (const q of ['ground', 'tower', 'approach'] as const) if (q !== p) await expect(game.modeTab(q)).toHaveAttribute('aria-selected', 'false');
      if (changed) {
        await expect(game.modeTab(p)).toHaveAttribute('aria-pressed', 'true');
        for (const q of ['ground', 'tower', 'approach'] as const) if (q !== p) await expect(game.modeTab(q)).toHaveAttribute('aria-pressed', 'false');
      }
      await expect(game.shell()).toHaveAttribute('data-mode', p);
      await expect(page.locator('body')).toHaveAttribute('data-mode', p);
      await expect(game.view(p === 'approach' ? 'radar' : 'ground')).toBeVisible();
      await expect(game.stripBay()).toHaveAttribute('data-position', p);
      expect((await sim.storeState()).position).toBe(p);
    };
    await expectPos('ground');
    await expect(page.getByTestId('position-tabs')).toBeVisible();

    await game.modeTab('tower').click();
    changed = true;
    await expectPos('tower');
    await game.modeTab('approach').click();
    await expectPos('approach');
    await expect(game.radarCanvas()).toBeVisible();
    await game.modeTab('ground').click();
    await expectPos('ground');
    await expect(game.groundMap()).toBeVisible();

    await game.hotkey('F2');
    await expectPos('tower');
    await game.hotkey('F3');
    await expectPos('approach');
    await game.hotkey('F1');
    await expectPos('ground');
    await game.hotkey(']');
    await expectPos('tower');
    await game.hotkey(']');
    await expectPos('approach');
    await game.hotkey(']');                                                            // wraps
    await expectPos('ground');
    await game.hotkey('[');
    await expectPos('approach');
    await game.hotkey('[');
    await expectPos('tower');
    // the engine follows: under strict frequencies a parked departure (ground frequency) is off-frequency for TOWER (R13)
    const gates = await sim.gates();
    await sim.spawnAt({ callsign: 'BAW1', type: A320, kind: 'departure', phase: 'parked', gate: gates[0], plan: { runway: '27L' } });
    const push = async () => (await sim.actions('BAW1')).find((r) => r.id === 'action-pushback')!;
    expect((await push()).state).toBe('disabled');
    expect((await push()).reason).toBe('R13');
    await game.hotkey('F1');
    expect((await push()).state).toBe('enabled');
    await game.selectStrip('BAW1');
    await expect(game.actionBtn('action-pushback')).toHaveAttribute('data-state', 'enabled');
    await game.hotkey('F2');
    await expectPos('tower');
    await expect(game.strip('BAW1')).toHaveCount(0);                                             // not in a TOWER bay
    await game.hotkey('F1');
    await expect(game.actionBtn('action-pushback')).toHaveAttribute('data-state', 'enabled');
  });

  test('position tabs mirror aria-pressed already at boot @full', async ({ openGame }) => {
    test.fixme(true, 'BUG: src/game/NavBar/NavBar.tsx:20-27 — the aria-pressed mirror runs in a layout effect keyed on [position] only; the tabs remount when hasRadar flips (the Tooltip wrapper is dropped once the engine loads), so a freshly booted game has no aria-pressed on any position tab until the first position change');
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'ground' });
    await expect(game.modeTab('ground')).toHaveAttribute('aria-selected', 'true');
    await expect(game.modeTab('ground')).toHaveAttribute('aria-pressed', 'true');
    await expect(game.modeTab('tower')).toHaveAttribute('aria-pressed', 'false');
    await expect(game.modeTab('approach')).toHaveAttribute('aria-pressed', 'false');
  });

  test('pause: button and Space toggle data-state paused|running; no sim time passes while paused @smoke', async ({ openGame, sim, page }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'tower' });
    await expect(game.pauseBtn()).toHaveAttribute('data-state', 'running');
    await expect(game.pauseBtn()).toHaveAttribute('aria-pressed', 'false');
    await expect(game.pausedPill()).toHaveCount(0);
    await expect(game.shell()).toHaveAttribute('data-paused', 'false');
    const t0 = await sim.time();
    await sim.advance(2);
    expect(await sim.time()).toBeCloseTo(t0 + 2, 1);

    await game.pauseBtn().click();
    await expect(game.pauseBtn()).toHaveAttribute('data-state', 'paused');
    await expect(game.pauseBtn()).toHaveAttribute('aria-pressed', 'true');
    await expect(game.pausedPill()).toBeVisible();
    await expect(game.shell()).toHaveAttribute('data-paused', 'true');
    await expect(page.locator('body')).toHaveAttribute('data-paused', 'true');
    expect((await sim.snapshot()).paused).toBe(true);
    const t1 = await sim.time();
    expect(await sim.advance(10)).toEqual([]);                                          // advance() is a no-op while paused
    expect(await sim.time()).toBeCloseTo(t1, 3);
    await expect(game.clockPopover()).toHaveCount(0);
    await page.getByTestId('clock-utc').click();
    await expect(game.clockPopover()).toContainText(/Paused/);
    await page.getByTestId('clock-utc').click();
    await expect(game.clockPopover()).toHaveCount(0);

    await game.hotkey('Space');
    await expect(game.pauseBtn()).toHaveAttribute('data-state', 'running');
    await expect(game.pausedPill()).toHaveCount(0);
    expect((await sim.snapshot()).paused).toBe(false);
    await sim.advance(1);
    expect(await sim.time()).toBeCloseTo(t1 + 1, 1);
    await game.hotkey('Space');
    await expect(game.pauseBtn()).toHaveAttribute('data-state', 'paused');
    await game.togglePause();
    await expect(game.pauseBtn()).toHaveAttribute('data-state', 'running');
  });

  test('rates 1x / 2x / 4x: buttons and 1 2 4 , . hotkeys mirror aria-pressed and scale real time @smoke', async ({ openGame, sim, page }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'tower' });
    const expectRate = async (r: 1 | 2 | 4) => {
      await expect(game.rateBtn(r)).toHaveAttribute('aria-pressed', 'true');
      await expect(game.rateBtn(r)).toHaveAttribute('data-state', 'on');
      for (const q of [1, 2, 4] as const) if (q !== r) await expect(game.rateBtn(q)).toHaveAttribute('data-state', 'off');
      await expect(page.locator('body')).toHaveAttribute('data-rate', String(r));
      expect((await sim.snapshot()).rate).toBe(r);
    };
    await expectRate(1);

    await game.rateBtn(2).click();
    await expectRate(2);
    let t0 = await sim.time();
    await sim.advanceReal(1);                                                           // one real second through the rate
    expect((await sim.time()) - t0).toBeCloseTo(2, 1);
    expect(await sim.lastStepDt()).toBeCloseTo(2 / 60, 4);

    await game.setRate(4);
    await expectRate(4);
    t0 = await sim.time();
    await sim.advanceReal(1);
    expect((await sim.time()) - t0).toBeCloseTo(4, 1);
    await page.getByTestId('clock-utc').click();
    await expect(game.clockPopover()).toContainText('4×');
    await game.hotkey('Escape');
    await expect(game.clockPopover()).toHaveCount(0);

    await game.rateBtn(1).click();
    await expectRate(1);
    t0 = await sim.time();
    await sim.advanceReal(1);
    expect((await sim.time()) - t0).toBeCloseTo(1, 1);

    // hotkeys: 1 / 2 / 4 set, "," slower and "." faster (clamped at the ends)
    await game.hotkey('4');
    await expectRate(4);
    await game.hotkey(',');
    await expectRate(2);
    await game.hotkey(',');
    await expectRate(1);
    await game.hotkey(',');
    await expectRate(1);
    await game.hotkey('.');
    await expectRate(2);
    await game.hotkey('2');
    await expectRate(2);
    await game.hotkey('.');
    await expectRate(4);
    await game.hotkey('.');
    await expectRate(4);
    await game.hotkey('1');
    await expectRate(1);
    // advance() (the deterministic driver) ignores the rate
    await game.setRate(4);
    t0 = await sim.time();
    await sim.advance(3);
    expect((await sim.time()) - t0).toBeCloseTo(3, 1);
  });

  test('ATIS chip opens the panel: letter, wind, QNH and active runways match the store ATIS; F9 toggles; wind change advances the letter @full', async ({ openGame, sim, page }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'tower' });
    const atis = await sim.atis();
    const full = await sim.storeAtis();
    expect(full).not.toBeNull();
    expect(full!.letter).toBe(atis.letter);
    const windText = `${pad(atis.wind.dir, 3)}/${pad(atis.wind.kts, 2)}`;
    await expect(game.atisChip()).toContainText(`ATIS ${atis.letter}`);
    await expect(game.wind()).toHaveText(windText);
    await expect(game.atisChip()).toHaveAttribute('aria-expanded', 'false');
    await expect(game.atisPanel()).toHaveCount(0);

    await game.atisChip().click();
    await expect(game.atisPanel()).toBeVisible();
    await expect(game.atisChip()).toHaveAttribute('aria-expanded', 'true');
    await expect(game.atisLetter()).toContainText(`Information ${atis.letter}`);
    // the Wind KPI is the live weather (the ATIS broadcast rounds it to 10 degrees); the broadcast text carries the ATIS wind
    const wx = await sim.storeWeather();
    expect(wx).not.toBeNull();
    await expect(game.atisWind()).toContainText(`${pad(wx!.windDirTrue, 3)}/${pad(wx!.windKt, 2)}`);
    expect(Math.abs(wx!.windDirTrue - atis.wind.dir)).toBeLessThanOrEqual(5);
    expect(Math.round(wx!.windKt)).toBe(Math.round(atis.wind.kts));
    expect(full!.text).toContain(`Wind ${Math.round(atis.wind.dir)} degrees ${Math.round(atis.wind.kts)} knots`);
    await expect(game.atisQnh()).toContainText(String(Math.round(full!.qnh)));
    await expect(game.atisQnh()).toContainText('hPa');
    await expect(game.atisText()).toContainText(full!.text);
    for (const r of full!.activeDep) await expect(game.atisDep(r)).toHaveText(r);
    for (const r of full!.activeArr) await expect(game.atisArr(r)).toHaveText(r);
    expect([...new Set([...full!.activeDep, ...full!.activeArr])].sort()).toEqual([...atis.activeRunways].sort());
    // every runway end has a status chip (open) — the runways() view agrees
    for (const r of await sim.runways()) await expect(game.atisRunwayStatus(r.name)).toHaveAttribute('data-status', 'open');

    await game.atisClose().click();
    await expect(game.atisPanel()).toHaveCount(0);
    await expect(game.atisChip()).toHaveAttribute('aria-expanded', 'false');
    await game.hotkey('F9');
    await expect(game.atisPanel()).toBeVisible();
    await game.hotkey('Escape');
    await expect(game.atisPanel()).toHaveCount(0);

    // a significant wind change regenerates the ATIS: next letter, new wind on the chip and in the log
    await sim.setWind(90, 15);
    await sim.advance(0.1);                                                                       // the weather model queues the ATIS event for the next step
    const next = await sim.atis();
    expect(next.letter).toBe(String.fromCharCode(atis.letter.charCodeAt(0) + 1));
    expect(next.wind).toEqual({ dir: 90, kts: 15 });
    await expect(game.atisChip()).toContainText(`ATIS ${next.letter}`);
    await expect(game.wind()).toHaveText('090/15');
    await game.showAllFrequencies();
    await game.waitRadio(new RegExp(`ATIS ${next.letter}`), { who: 'SYS' });
    await game.atisChip().click();
    await expect(game.atisLetter()).toContainText(`Information ${next.letter}`);
    await expect(game.atisWind()).toContainText('090/15');
    await expect(page.getByTestId('atis-wind-arrow')).toHaveAttribute('aria-label', 'wind from 90');
  });

  test('score chip shows the live score and opens the stats popover with breakdown rows from the ledger @full', async ({ openGame, sim, page }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'tower' });
    await expect(game.score()).toHaveAttribute('data-value', '0');
    await expect(game.scoreHi()).toHaveCount(0);                                         // no high score yet
    await sim.setScore(5);
    await expect(game.score()).toHaveAttribute('data-value', '5');
    await expect(game.score()).toHaveText('5');

    // a real scored movement: a departure rolling on 27R gets airborne (+10 MOVEMENT)
    await sim.spawnAt({ callsign: 'RYR6', type: 'B738', kind: 'departure', phase: 'takeoff', runway: '27R' });
    await sim.advanceUntilPhase('RYR6', 'climb', 120);
    const scored = (await sim.events()).filter((e) => e.type === 'score');
    expect(scored.some((e) => /movement/i.test(e.message))).toBe(true);
    const points = (await sim.snapshot()).score;
    expect(points).toBe(15);
    await expect(game.score()).toHaveAttribute('data-value', '15');

    await expect(game.scoreChip()).toHaveAttribute('aria-expanded', 'false');
    await game.scoreChip().click();
    await expect(game.scoreBreakdown()).toBeVisible();
    await expect(game.scoreChip()).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('score-points')).toHaveText('15');
    await expect(page.getByTestId('score-skill')).toContainText('/ 12');
    await expect(page.getByTestId('score-rows')).toBeVisible();
    await expect(game.scoreRow('movements')).toHaveAttribute('data-value', '10');
    await expect(game.scoreRow('movements')).toContainText('×1');
    await expect(game.scoreRow('movements')).toContainText('+10');
    await expect(game.scoreRow('frequency_load')).toBeVisible();
    await expect(game.scoreRow('responsiveness')).toBeVisible();
    await expect(game.scoreRow('separation_loss')).toHaveCount(0);                      // rows only for codes that scored
    await expect(page.getByTestId('score-incidents-empty')).toBeVisible();
    await expect(page.getByTestId('score-highscore')).toBeVisible();

    await game.scoreBreakdownClose().click();
    await expect(game.scoreBreakdown()).toHaveCount(0);
    await expect(game.scoreChip()).toHaveAttribute('aria-expanded', 'false');
    await game.scoreChip().click();
    await expect(game.scoreBreakdown()).toBeVisible();
    await game.hotkey('Escape');
    await expect(game.scoreBreakdown()).toHaveCount(0);
    await expect(game.pauseMenu()).toHaveCount(0);                                        // Esc closed the popover, not the game
  });

  test('bell opens the alerts drawer; the badge follows unacknowledged alerts; the stack card acks @full', async ({ openGame, sim, page }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'approach' });
    await spawnArrival(sim);
    await expect(game.alertsBell()).toHaveAttribute('data-count', '0');
    await expect(game.alertsBell()).toHaveAttribute('aria-expanded', 'false');
    await game.alertsBell().click();
    await expect(game.alertsDrawer()).toBeVisible();
    await expect(game.alertsBell()).toHaveAttribute('aria-expanded', 'true');
    await expect(game.alertsEmpty()).toBeVisible();
    await game.alertsDrawerClose().click();
    await expect(game.alertsDrawer()).toHaveCount(0);

    // an emergency raises a critical alert: badge 1, stack card, drawer row "active"
    await sim.forceEmergency('UAL9', 'engine_fire');
    const alerts = await sim.alerts();
    const al = alerts.find((a) => a.kind === 'emergency');
    expect(al).toBeTruthy();
    expect(al!.severity).toBe('critical');
    expect(al!.ack).toBe(false);
    await expect(game.alertsBell()).toHaveAttribute('data-count', '1');
    await expect(page.getByTestId(`toast-${al!.id}`)).toBeVisible();
    await expect(page.getByTestId(`toast-${al!.id}`)).toHaveAttribute('data-severity', 'critical');
    await expect(page.getByTestId(`emergency-banner-UAL9`)).toBeVisible();
    await game.alertsBell().click();
    await expect(game.alertsDrawer()).toBeVisible();
    await expect(game.alertsRow(al!.id)).toBeVisible();
    await expect(page.getByTestId(`alerts-row-${al!.id}-state`)).toHaveAttribute('data-state', 'active');
    await expect(page.getByTestId('alerts-filter-critical')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('alerts-filter-critical').click();                             // filter out critical -> row gone
    await expect(game.alertsRow(al!.id)).toHaveCount(0);
    await page.getByTestId('alerts-filter-critical').click();
    await expect(game.alertsRow(al!.id)).toBeVisible();
    await game.alertsDrawerClose().click();

    // ACK on the stack card clears the badge; the engine alert is acknowledged; the drawer row shows "acked"
    await page.getByTestId(`toast-${al!.id}-ack`).click();
    await expect(game.alertsBell()).toHaveAttribute('data-count', '0');
    expect((await sim.alerts()).find((a) => a.id === al!.id)?.ack).toBe(true);
    await game.alertsBell().click();
    await expect(page.getByTestId(`alerts-row-${al!.id}-state`)).toHaveAttribute('data-state', 'acked');
    // clicking a row selects and locates its subject
    await game.alertsRow(al!.id).click();
    await expect(game.panel()).toHaveAttribute('data-callsign', 'UAL9');
    await expect(game.strip('UAL9')).toHaveAttribute('data-selected', 'true');
  });

  test('ACK on the stack card collapses it into an acknowledged pill at once @full', async ({ openGame, sim, page }) => {
    test.fixme(true, 'BUG: src/lib/sim/alerts.ts:558 AlertEngine.ack() mutates the Alert in place and simStore.useSim (simStore.ts:1186) shallow-equals the `alerts()` array, so the AlertStack (`useSim((s) => s.alerts())`) does not re-render on ack: the card with its ACK button stays until the next sim-second tick instead of collapsing into alert-pill-{id}');
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'approach' });
    await spawnArrival(sim);
    await sim.forceEmergency('UAL9', 'engine_fire');
    const al = (await sim.alerts()).find((a) => a.kind === 'emergency')!;
    await expect(page.getByTestId(`toast-${al.id}`)).toBeVisible();
    await page.getByTestId(`toast-${al.id}-ack`).click();
    await expect(game.alertsBell()).toHaveAttribute('data-count', '0');
    expect((await sim.alerts()).find((a) => a.id === al.id)?.ack).toBe(true);
    await expect(page.getByTestId(`toast-${al.id}`)).toHaveCount(0);
    await expect(page.getByTestId(`alert-pill-${al.id}`)).toBeVisible();
  });

  test('TX indicator lights on a transmission and mirrors the ATC voice toggle @full', async ({ openGame, sim }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'approach' });
    await spawnArrival(sim);
    await expect(game.txIndicator()).toHaveAttribute('data-state', 'idle');
    await expect(game.txIndicator()).toHaveAttribute('aria-pressed', 'false');            // TTS off (seeded settings)
    await expect(game.txIndicator()).toHaveAttribute('data-voice', 'off');

    await game.cmdInput().fill('UAL9 HEADING 180');
    await game.cmdInput().press('Enter');
    await expect(game.txIndicator()).toHaveAttribute('data-state', 'tx', { timeout: 1_000 });
    await game.waitRadio(/one eight zero/i, { who: 'ATC', callsign: 'UAL9' });
    await expect(game.txIndicator()).toHaveAttribute('data-state', 'idle', { timeout: 5_000 });   // ~1.2 s wall-clock lamp

    // a refused (silent) line does not light the lamp
    const r = await game.send('ZZZ999 HEADING 180');
    expect(r.accepted).toBe(false);
    await expect(game.txIndicator()).toHaveAttribute('data-state', 'idle');
    // the pilot readback is not a transmission either
    await sim.advance(3.1);
    await game.waitRadio(/one eight zero|180/i, { who: 'PILOT', callsign: 'UAL9' });
    await expect(game.txIndicator()).toHaveAttribute('data-state', 'idle');

    // click toggles the ATC voice setting
    await game.txIndicator().click();
    await expect(game.txIndicator()).toHaveAttribute('aria-pressed', 'true');
    await expect(game.txIndicator()).toHaveAttribute('data-voice', 'on');
    expect((await sim.storeSettings()).tts).toBe(true);
    await game.txIndicator().click();
    await expect(game.txIndicator()).toHaveAttribute('aria-pressed', 'false');
    expect((await sim.storeSettings()).tts).toBe(false);
  });

  test('help overlay: ? and the help button open it; tabs, search and close work; Escape closes @full', async ({ openGame, page }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'tower' });
    await expect(game.helpOverlay()).toHaveCount(0);
    await game.hotkey('?');
    await expect(game.helpOverlay()).toBeVisible();
    await expect(game.helpOverlay()).toHaveAttribute('role', 'dialog');
    await expect(game.helpTab('hotkeys')).toHaveAttribute('aria-selected', 'true');
    await expect(game.helpHotkeyRow('f1')).toBeVisible();
    await expect(game.helpHotkeyRow('space')).toContainText(/pause/i);
    const total = await game.helpHotkeyRows().count();
    expect(total).toBeGreaterThan(20);

    // search filters the rows of the current tab
    await game.helpSearch().fill('pause');
    await expect.poll(() => game.helpHotkeyRows().count()).toBeLessThan(total);
    await expect(game.helpHotkeyRow('space')).toBeVisible();
    await expect(game.helpHotkeyRow('f1')).toHaveCount(0);
    await game.helpSearch().fill('zzzz-no-such-key');
    await expect(game.helpHotkeyRows()).toHaveCount(0);
    await expect(game.helpOverlay()).toContainText(/No shortcut matches/i);
    await game.helpSearch().fill('');
    await expect(game.helpHotkeyRows()).toHaveCount(total);

    // tabs
    await game.helpTab('phraseology').click();
    await expect(game.helpTab('phraseology')).toHaveAttribute('aria-selected', 'true');
    await expect(game.helpHotkeyRows()).toHaveCount(0);
    expect(await game.helpPhraseRows().count()).toBeGreaterThan(5);
    await game.helpTab('matrix').click();
    await expect(game.helpMatrix()).toBeVisible();
    await expect(page.getByTestId('help-matrix-cell-parked-action-pushback')).toHaveAttribute('data-cell', /^(on|dyn)$/);
    await expect(page.getByTestId('help-matrix-cell-parked-action-takeoff')).toHaveAttribute('data-cell', 'hidden');
    await game.helpSearch().fill('heading');
    await expect(page.getByTestId('help-matrix-cell-parked-action-pushback')).toHaveCount(0);
    await expect(page.getByTestId('help-matrix-cell-arr_inbound-action-heading')).toHaveAttribute('data-cell', 'on');
    await game.helpSearch().fill('');
    await game.helpTab('alerts').click();
    expect(await game.helpAlertRows().count()).toBeGreaterThan(3);
    await expect(page.getByTestId('help-alert-stca')).toBeVisible();
    await game.helpTab('glossary').click();
    expect(await game.helpGlossaryRows().count()).toBeGreaterThan(3);

    // close button, help button, Escape; the search resets on reopen
    await game.helpClose().click();
    await expect(game.helpOverlay()).toHaveCount(0);
    await game.helpBtn().click();
    await expect(game.helpOverlay()).toBeVisible();
    await expect(game.helpSearch()).toHaveValue('');
    await game.hotkey('Escape');
    await expect(game.helpOverlay()).toHaveCount(0);
    await expect(game.pauseMenu()).toHaveCount(0);
    await game.helpBtn().click();
    await expect(game.helpOverlay()).toBeVisible();
    await expect(game.helpBtn()).toHaveAttribute('aria-pressed', 'true');                   // the nav button mirrors the open state
    await game.hotkey('?');                                                                // the hotkey toggles it closed again
    await expect(game.helpOverlay()).toHaveCount(0);
    await expect(game.helpBtn()).not.toHaveAttribute('aria-pressed', 'true');              // IconButton drops the attribute when inactive
  });

  test('pause menu (Esc): opens paused, Resume resumes, Restart reloads the same seed, Quit goes home @full', async ({ openGame, sim, page }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'approach' });
    await spawnArrival(sim);
    await sim.advance(5);
    const t = await sim.time();

    // Esc priority: a selected aircraft is deselected first, then the menu opens
    await game.selectStrip('UAL9');
    await game.hotkey('Escape');
    await expect(game.shell()).toHaveAttribute('data-has-panel', 'false');
    await expect(game.pauseMenu()).toHaveCount(0);
    await game.hotkey('Escape');
    await expect(game.pauseMenu()).toBeVisible();
    await expect(game.pauseBtn()).toHaveAttribute('data-state', 'paused');
    expect((await sim.snapshot()).paused).toBe(true);
    await expect(game.pauseMenu()).toContainText('EGLL');
    await expect(game.pauseMenu()).toContainText('1 aircraft');

    // Resume
    await game.pauseItem('resume').click();
    await expect(game.pauseMenu()).toHaveCount(0);
    await expect(game.pauseBtn()).toHaveAttribute('data-state', 'running');
    expect((await sim.snapshot()).paused).toBe(false);
    expect(await sim.time()).toBeCloseTo(t, 3);
    await expect(game.strip('UAL9')).toBeVisible();

    // Restart: confirm step, Back keeps the session, Restart reloads the same airport + seed with fresh traffic
    await game.hotkey('Escape');
    await game.pauseItem('restart').click();
    await expect(game.pauseConfirm('restart')).toBeVisible();
    await game.pauseConfirmNo().click();
    await expect(game.pauseConfirm('restart')).toHaveCount(0);
    await expect(game.pauseItem('resume')).toBeVisible();
    await game.pauseItem('restart').click();
    await game.pauseConfirmYes().click();
    await game.waitReady();
    await expect(game.pauseMenu()).toHaveCount(0);
    await expect(game.pauseBtn()).toHaveAttribute('data-state', 'running');
    const st = await sim.storeState();
    expect(st.icao).toBe('EGLL');
    expect(st.seed).toBe(7);
    expect(st.testMode).toBe(true);
    expect(st.paused).toBe(false);
    expect(await sim.time()).toBe(0);
    expect((await sim.snapshot()).aircraft).toEqual([]);                                   // spawn=none session rebuilt
    await expect(game.strip('UAL9')).toHaveCount(0);
    await expect(game.radioLines('SYS').first()).toContainText(/test mode · seed 7/);

    // Quit: confirm, then the home page (the shift is over)
    await game.hotkey('Escape');
    await expect(game.pauseMenu()).toBeVisible();
    await game.pauseItem('quit').click();
    await expect(game.pauseConfirm('quit')).toBeVisible();
    await game.pauseConfirmYes().click();
    await expect(page.getByTestId('page-home')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/');
  });

  test('settings modal: settings button opens it, toggles apply live to the store, Done closes, "All settings" opens /settings @full', async ({ openGame, sim, page }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'tower' });
    expect((await sim.storeSettings()).sound).toBe(false);
    await expect(game.settingsModal()).toHaveCount(0);
    await game.settingsBtn().click();
    await expect(game.settingsModal()).toBeVisible();
    await expect(game.settingsModal()).toHaveAttribute('role', 'dialog');

    const sound = game.settingsToggle('set-sound');
    await expect(sound).toHaveAttribute('aria-checked', 'false');
    await sound.click();
    await expect(sound).toHaveAttribute('aria-checked', 'true');
    await expect.poll(async () => (await sim.storeSettings()).sound).toBe(true);
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('skycontrol_settings') ?? '{}').sound)).toBe(true);
    const tts = game.settingsToggle('set-tts');
    await expect(tts).toHaveAttribute('aria-checked', 'false');
    await tts.click();
    await expect(tts).toHaveAttribute('aria-checked', 'true');
    await expect.poll(async () => (await sim.storeSettings()).tts).toBe(true);
    await expect(game.txIndicator()).toHaveAttribute('aria-pressed', 'true');              // the nav mirrors it at once
    await tts.click();
    await expect.poll(async () => (await sim.storeSettings()).tts).toBe(false);
    await sound.click();
    await expect.poll(async () => (await sim.storeSettings()).sound).toBe(false);

    await game.settingsClose().click();
    await expect(game.settingsModal()).toHaveCount(0);
    await game.settingsBtn().click();
    await expect(game.settingsModal()).toBeVisible();
    await game.hotkey('Escape');
    await expect(game.settingsModal()).toHaveCount(0);
    await expect(game.pauseMenu()).toHaveCount(0);

    // reachable from the pause menu too (returns to the menu afterwards); "All settings" leaves for /settings
    await game.hotkey('Escape');
    await expect(game.pauseMenu()).toBeVisible();
    await game.pauseItem('settings').click();
    await expect(game.settingsModal()).toBeVisible();
    await expect(game.pauseMenu()).toHaveCount(0);
    await game.settingsClose().click();
    await expect(game.pauseMenu()).toBeVisible();
    await expect(game.pauseBtn()).toHaveAttribute('data-state', 'paused');
    await game.pauseItem('settings').click();
    await game.settingsOpenFull().click();
    await expect(page.getByTestId('page-settings')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/settings');
  });

  test('hotkeys are inert while the command line has focus; Escape blurs it, then they work again @full', async ({ openGame, sim, page }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'tower' });
    const gates = await sim.gates();
    await sim.spawnAt({ callsign: 'BAW1', type: A320, kind: 'departure', phase: 'parked', gate: gates[0], plan: { runway: '27L' } });
    await game.setPosition('ground');
    await game.hotkey('/');
    await expect(game.cmdInput()).toBeFocused();
    await expect(page.locator('body')).toHaveAttribute('data-focus-region', 'log');

    await page.keyboard.press('Space');
    await page.keyboard.press('2');
    await page.keyboard.type('?');
    await page.keyboard.press('Tab');
    await expect(game.cmdInput()).toHaveValue(' 2?');
    await expect(game.pauseBtn()).toHaveAttribute('data-state', 'running');
    expect((await sim.snapshot()).paused).toBe(false);
    expect((await sim.snapshot()).rate).toBe(1);
    await expect(game.helpOverlay()).toHaveCount(0);
    expect((await sim.snapshot()).selectedId).toBeNull();                                   // Tab did not cycle the strips
    await expect(game.strip('BAW1')).toHaveAttribute('data-selected', 'false');
    // the function keys stay global
    await game.cmdInput().focus();
    await page.keyboard.press('F2');
    await expect(game.shell()).toHaveAttribute('data-mode', 'tower');
    await page.keyboard.press('F1');
    await expect(game.shell()).toHaveAttribute('data-mode', 'ground');

    // Escape: blur first (nothing else happens), then the shell keys are live again
    await game.cmdInput().focus();
    await game.cmdInput().fill('');
    await page.keyboard.press('Escape');
    await expect(game.cmdInput()).not.toBeFocused();
    await expect(game.pauseMenu()).toHaveCount(0);
    await page.keyboard.press('Space');
    await expect(game.pauseBtn()).toHaveAttribute('data-state', 'paused');
    await page.keyboard.press('Space');
    await expect(game.pauseBtn()).toHaveAttribute('data-state', 'running');
    await page.keyboard.press('2');
    await expect(game.rateBtn(2)).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Tab');
    await expect(game.strip('BAW1')).toHaveAttribute('data-selected', 'true');
    await page.keyboard.press('Shift+/');
    await expect(game.helpOverlay()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(game.helpOverlay()).toHaveCount(0);

    // the strip-bay search box is an input too: no shell keys while typing there
    await game.baySearch().click();
    await page.keyboard.press('1');
    await expect(game.baySearch()).toHaveValue('1');
    expect((await sim.snapshot()).rate).toBe(2);
    // Ctrl+K focuses the command line from anywhere
    await game.baySearch().fill('');
    await page.keyboard.press('Control+k');
    await expect(game.cmdInput()).toBeFocused();
  });
  test('runway configuration dialog: airport badge / ATIS "Change" / pause menu open it; Apply flips the active ends and bumps the ATIS; Cancel and Esc discard @full', async ({ openGame, sim, page }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'tower' });
    const atis0 = (await sim.storeAtis())!;
    const before = { dep: [...atis0.activeDep].sort(), arr: [...atis0.activeArr].sort() };
    expect(before.dep.length).toBeGreaterThan(0);
    expect(before.arr.length).toBeGreaterThan(0);
    expect([...new Set([...before.dep, ...before.arr])].sort()).toEqual((await sim.runways()).filter((r) => r.active).map((r) => r.name).sort());
    const letter0 = atis0.letter;
    const ends = (await sim.runways()).map((r) => r.name);
    expect(ends.sort()).toEqual(['09L', '09R', '27L', '27R']);
    const target = { dep: ['09R'], arr: ['09L'] };
    expect(before).not.toEqual(target);
    await expect(game.runwayConfigDialog()).toHaveCount(0);

    // airport badge opens it with the live config as the draft
    await game.airportBadge().click();
    await expect(game.runwayConfigDialog()).toBeVisible();
    await expect(game.runwayConfigDialog()).toHaveAttribute('role', 'dialog');
    for (const r of ends) {
      await expect(game.rwycfgEnd(r, 'dep')).toHaveAttribute('aria-pressed', String(before.dep.includes(r)));
      await expect(game.rwycfgEnd(r, 'arr')).toHaveAttribute('aria-pressed', String(before.arr.includes(r)));
      await expect(page.getByTestId(`rwycfg-end-${r}`)).toContainText(/Head|Tail/);              // wind components per end
    }
    // Cancel discards a draft change
    const flip = ends.find((r) => !before.dep.includes(r)) ?? ends[0];
    const was = before.dep.includes(flip);
    await game.rwycfgEnd(flip, 'dep').click();
    await expect(game.rwycfgEnd(flip, 'dep')).toHaveAttribute('aria-pressed', String(!was));
    await game.rwycfgCancel().click();
    await expect(game.runwayConfigDialog()).toHaveCount(0);
    expect({ dep: [...(await sim.storeAtis())!.activeDep].sort(), arr: [...(await sim.storeAtis())!.activeArr].sort() }).toEqual(before);
    await game.airportBadge().click();
    await expect(game.rwycfgEnd(flip, 'dep')).toHaveAttribute('aria-pressed', String(was));        // fresh draft
    await game.hotkey('Escape');
    await expect(game.runwayConfigDialog()).toHaveCount(0);
    await expect(game.pauseMenu()).toHaveCount(0);

    // from the ATIS panel: swap to the 09s and apply -> engine runways, nav chip, ATIS letter + SYS line, both end chips
    await game.openRunwayConfig();
    for (const r of before.dep) await game.rwycfgEnd(r, 'dep').click();                              // no departure runway left
    await expect(game.rwycfgBlockedReason()).toBeVisible();
    await expect(game.rwycfgApply()).toBeDisabled();
    for (const r of before.arr) await game.rwycfgEnd(r, 'arr').click();
    await game.rwycfgEnd('09L', 'arr').click();
    await game.rwycfgEnd('09R', 'dep').click();
    await expect(game.rwycfgBlockedReason()).toHaveCount(0);
    await game.rwycfgApply().click();
    await expect(game.runwayConfigDialog()).toHaveCount(0);
    const rows = await sim.runways();
    expect(rows.filter((r) => r.active).map((r) => r.name).sort()).toEqual(['09L', '09R']);
    const st = (await sim.storeState()).runways!;
    expect(st.find((r) => r.name === '09R')!.active).toBe(true);
    expect(st.find((r) => r.name === '27L')!.active).toBe(false);
    expect(st.find((r) => r.name === '27R')!.active).toBe(false);
    const atis = await sim.storeAtis();
    expect(atis!.activeDep).toEqual(['09R']);
    expect(atis!.activeArr).toEqual(['09L']);
    expect(atis!.letter).toBe(String.fromCharCode(letter0.charCodeAt(0) + 1));
    await expect(game.atisChip()).toContainText(`ATIS ${atis!.letter}`);
    await expect(game.atisChip()).toContainText('09R / 09L');
    await sim.advance(0.1);
    await game.showAllFrequencies();
    await game.waitRadio(new RegExp(`ATIS ${atis!.letter}`), { who: 'SYS' });
    await game.openAtis();
    await expect(game.atisDep('09R')).toBeVisible();
    await expect(game.atisArr('09L')).toBeVisible();
    await expect(game.atisDep('27L')).toHaveCount(0);
    await expect(game.atisArr('27R')).toHaveCount(0);
    await game.closeAtis();

    // reachable from the pause menu; closing it returns to the (still paused) menu
    await game.hotkey('Escape');
    await expect(game.pauseMenu()).toBeVisible();
    await game.pauseItem('runways').click();
    await expect(game.runwayConfigDialog()).toBeVisible();
    await expect(game.pauseMenu()).toHaveCount(0);
    await game.rwycfgCancel().click();
    await expect(game.pauseMenu()).toBeVisible();
    await expect(game.pauseBtn()).toHaveAttribute('data-state', 'paused');
    await game.pauseItem('resume').click();
    await expect(game.pauseBtn()).toHaveAttribute('data-state', 'running');
  });

  test('brand link asks before leaving the shift (Stay keeps it, Leave goes home); the fast-forward button holds 4x and restores the rate @full', async ({ openGame, sim, page }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'tower' });
    await expect(page.getByTestId('home-leave-confirm')).toHaveCount(0);
    await game.brand().click();
    await expect(page.getByTestId('home-leave-confirm')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/play');
    await page.getByTestId('home-leave-confirm-no').click();
    await expect(page.getByTestId('home-leave-confirm')).toHaveCount(0);
    expect((await sim.storeState()).hasEngine).toBe(true);
    await expect(game.pauseBtn()).toHaveAttribute('data-state', 'running');                        // leaving is not a pause

    // fast-forward: 4x while the pointer is down, previous rate back on release; it also un-pauses
    await game.setRate(2);
    const ff = page.getByTestId('rate-ff');
    await expect(ff).toHaveAttribute('data-state', 'off');
    const box = (await ff.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await expect(ff).toHaveAttribute('data-state', 'on');
    await expect(game.rateBtn(4)).toHaveAttribute('aria-pressed', 'true');
    expect((await sim.snapshot()).rate).toBe(4);
    await page.mouse.up();
    await expect(ff).toHaveAttribute('data-state', 'off');
    await expect(game.rateBtn(2)).toHaveAttribute('aria-pressed', 'true');
    expect((await sim.snapshot()).rate).toBe(2);
    await game.togglePause();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await expect(game.pauseBtn()).toHaveAttribute('data-state', 'running');
    await page.mouse.up();
    await expect(game.rateBtn(2)).toHaveAttribute('aria-pressed', 'true');

    // Leave -> home page, the store engine is stopped
    await game.brand().click();
    await page.getByTestId('home-leave-confirm-yes').click();
    await expect(page.getByTestId('page-home')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/');
  });

  test('onboarding tips: "Replay" in the settings modal shows tip 1; Next / Enter advance, selecting an aircraft auto-advances, Skip persists the dismissal @full', async ({ openGame, sim, page }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'ground' });
    const gates = await sim.gates();
    await sim.spawnAt({ callsign: 'BAW1', type: A320, kind: 'departure', phase: 'parked', gate: gates[0], plan: { runway: '27L' } });
    await expect(page.getByTestId('tip-1')).toHaveCount(0);                                        // seeded as already seen
    expect(await page.evaluate(() => localStorage.getItem('skycontrol_onboarding_seen'))).toBe('1');

    await game.settingsBtn().click();
    await page.getByTestId('set-reset-tips').click();
    await expect(game.settingsModal()).toHaveCount(0);
    await expect(page.getByTestId('tip-1')).toBeVisible();
    await expect(page.getByTestId('tip-1')).toHaveAttribute('data-step', '0');
    await expect(page.getByTestId('tip-1')).toContainText('BAW1');                                 // names the first departure
    await expect(page.getByTestId('tip-progress-1')).toHaveAttribute('data-on', 'true');
    await expect(page.getByTestId('tip-progress-2')).toHaveAttribute('data-on', 'false');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('skycontrol_onboarding_seen'))).not.toBe('1');

    // step 1 completes itself when the player selects the aircraft
    await game.selectStrip('BAW1');
    await expect(page.getByTestId('tip-2')).toBeVisible();
    await expect(page.getByTestId('tip-2')).toHaveAttribute('data-step', '1');
    await expect(page.getByTestId('tip-progress-1')).toHaveAttribute('data-done', 'true');
    await expect(page.getByTestId('tip-2')).toContainText(/Pushback approved/);
    // Next button and Enter (with nothing focused) advance; the help overlay hides the tip while open
    await page.getByTestId('tip-next').click();
    await expect(page.getByTestId('tip-3')).toBeVisible();
    await expect(page.getByTestId('tip-3')).toContainText((await sim.storeAtis())!.activeDep[0]);  // the first active departure runway
    await game.helpBtn().click();
    await expect(game.helpOverlay()).toBeVisible();
    await expect(page.getByTestId('tip-3')).toHaveCount(0);
    await game.helpClose().click();
    await expect(page.getByTestId('tip-3')).toBeVisible();
    await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur?.(); });
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('tip-4')).toBeVisible();
    // Skip dismisses for good
    await page.getByTestId('tip-skip-all').click();
    await expect(page.locator('[data-testid^="tip-"][data-step]')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => localStorage.getItem('skycontrol_onboarding_seen'))).toBe('1');
    await page.reload();
    await game.waitReady();
    await expect(page.locator('[data-testid^="tip-"][data-step]')).toHaveCount(0);
    // the last tip's button reads Done and finishes
    await game.settingsBtn().click();
    await page.getByTestId('set-reset-tips').click();
    await expect(page.getByTestId('tip-1')).toBeVisible();
    for (let i = 0; i < 4; i++) await page.getByTestId('tip-next').click();
    await expect(page.getByTestId('tip-5')).toBeVisible();
    await expect(page.getByTestId('tip-next')).toHaveText('Done');
    await page.getByTestId('tip-next').click();
    await expect(page.locator('[data-testid^="tip-"][data-step]')).toHaveCount(0);
  });

  test('Esc with the help overlay open over an onboarding tip closes the overlay and keeps the tip @full', async ({ openGame, page }) => {
    test.fixme(true, 'BUG: src/game/HelpOverlay/OnboardingTips.tsx:63-75 — the tips\' capture-phase keydown listener stays armed while the tip is not rendered (shell.open.help / pause return null), so Esc pressed to close the help overlay is swallowed (stopPropagation) and dismisses the tips for good (onboarding_seen=1) while the overlay stays open ; expected first Esc closes help-overlay and tip-1 is visible again ; actual help-overlay still open, tip gone, skycontrol_onboarding_seen=1, a second Esc closes the overlay ; repro settings -> Replay tips, press ?, press Esc');
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'ground' });
    await game.settingsBtn().click();
    await page.getByTestId('set-reset-tips').click();
    await expect(page.getByTestId('tip-1')).toBeVisible();
    await game.hotkey('?');
    await expect(game.helpOverlay()).toBeVisible();
    await expect(page.getByTestId('tip-1')).toHaveCount(0);
    await game.hotkey('Escape');
    await expect(game.helpOverlay()).toHaveCount(0);
    await expect(page.getByTestId('tip-1')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('skycontrol_onboarding_seen'))).not.toBe('1');
  });
});

test.describe('holding screen below 1280 px', () => {
  test.use({ viewport: { width: 1100, height: 800 } });

  test('"Desktop required" covers a narrow window; Continue anyway is remembered; Home leaves @full', async ({ openGame, sim, page }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'tower' });
    const hold = page.getByTestId('desktop-required');
    await expect(hold).toBeVisible();
    await expect(hold).toHaveAttribute('role', 'dialog');
    await expect(hold).toHaveAttribute('data-width', '1100');
    await expect(hold).toContainText(/1100 px/);
    await expect(hold).toContainText(/1280 px/);
    // the shift keeps running underneath
    await sim.advance(2);
    expect(await sim.time()).toBeCloseTo(2, 0);
    await expect(game.shell()).toHaveAttribute('data-mode', 'tower');

    await page.getByTestId('desktop-required-continue').click();
    await expect(hold).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('skycontrol_allow_narrow'))).toBeTruthy();
    await page.reload();
    await game.waitReady();
    await expect(hold).toHaveCount(0);                                                              // the choice sticks

    // a fresh choice: Home leaves the game
    await page.evaluate(() => localStorage.removeItem('skycontrol_allow_narrow'));
    await page.reload();
    await game.waitReady();
    await expect(hold).toBeVisible();
    await page.getByTestId('desktop-required-home').click();
    await expect(page.getByTestId('page-home')).toBeVisible();
  });
});

for (const width of [1280, 1920]) {
  test.describe(`layout at ${width} px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test(`nav chrome, panels and the TRANSMIT button fit without overlap at ${width} px @full`, async ({ openGame, sim, page }) => {
      const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'ground' });
      await expect(page.getByTestId('desktop-required')).toHaveCount(0);
      const box = async (id: string) => { const b = await page.getByTestId(id).boundingBox(); expect(b, `${id} has no box`).not.toBeNull(); return b!; };
      const inView = (b: { x: number; y: number; width: number; height: number }) => b.x >= 0 && b.y >= 0 && b.x + b.width <= width && b.y + b.height <= 900;
      const overlap = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
        a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

      // top bar: left-to-right order with no overlap, everything inside the viewport
      const navIds = ['brand-home', 'airport-badge', 'position-tabs', 'atis-chip', 'clock-utc', 'rate-pause', 'rate-1x', 'rate-4x', 'rate-ff', 'score-chip', 'alerts-bell', 'tx-indicator', 'settings-btn', 'help-btn'];
      const boxes: Record<string, { x: number; y: number; width: number; height: number }> = {};
      for (const id of navIds) { boxes[id] = await box(id); expect(inView(boxes[id]), `${id} outside the viewport: ${JSON.stringify(boxes[id])}`).toBe(true); }
      for (let i = 0; i < navIds.length; i++) for (let j = i + 1; j < navIds.length; j++) {
        expect(overlap(boxes[navIds[i]], boxes[navIds[j]]), `${navIds[i]} overlaps ${navIds[j]}`).toBe(false);
      }
      for (let i = 1; i < navIds.length; i++) expect(boxes[navIds[i]].x, `${navIds[i]} is left of ${navIds[i - 1]}`).toBeGreaterThanOrEqual(boxes[navIds[i - 1]].x + boxes[navIds[i - 1]].width - 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);   // no horizontal scroll

      // strip bay vs command panel vs comm log
      const gates = await sim.gates();
      await sim.spawnAt({ callsign: 'BAW1', type: A320, kind: 'departure', phase: 'parked', gate: gates[0], plan: { runway: '27L' } });
      await sim.spawnAt({ callsign: 'UAL9', type: A320, kind: 'arrival', phase: 'descent', posRel: { fromRunway: '27L', alongNM: -20, offsetNM: -6, altFt: 8000 }, heading: 90, speedKts: 250 });
      await game.openPanelFor('BAW1');
      const bay = await box('strip-bay'); const panel = await box('detail-panel'); const log = await box('comm-log');
      expect(overlap(bay, panel), 'strip bay overlaps the command panel').toBe(false);
      expect(overlap(bay, log), 'strip bay overlaps the comm log').toBe(false);
      expect(overlap(panel, log), 'command panel overlaps the comm log').toBe(false);
      expect(inView(await box('cmd-input'))).toBe(true);

      // TRANSMIT button in view at the confirm step, and actually clickable (nothing floats over it)
      await game.action('action-pushback');
      await game.pickRunway('27L');
      await game.next();                                                                          // -> facing
      await game.next();                                                                          // -> confirm
      await expect(game.confirmStep()).toBeVisible();
      const tx = await box('btn-transmit');
      expect(inView(tx), `btn-transmit outside the viewport: ${JSON.stringify(tx)}`).toBe(true);
      const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('[data-testid="btn-transmit"]') != null, [tx.x + tx.width / 2, tx.y + tx.height / 2] as const);
      expect(hit, 'btn-transmit is covered by another element').toBe(true);
      await game.cancel();

      // alert stack vs the vehicles panel (GROUND / TOWER floating chrome)
      await sim.forceEmergency('UAL9', 'engine_fire');
      const al = (await sim.alerts()).find((a) => a.kind === 'emergency')!;
      await expect(game.alertCard(al.id)).toBeVisible();
      await game.hotkey('F10');
      await expect(game.vehiclesPanel()).toBeVisible();
      const card = await box(`toast-${al.id}`); const veh = await box('vehicle-panel');
      expect(inView(card)).toBe(true);
      expect(inView(veh)).toBe(true);
      expect(overlap(card, veh), `alert card ${JSON.stringify(card)} overlaps the vehicles panel ${JSON.stringify(veh)}`).toBe(false);
      expect(overlap(veh, await box('strip-bay')), 'vehicles panel overlaps the strip bay').toBe(false);
    });
  });
}
