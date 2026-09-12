/*
  Comm log + command line (src/game/CommLog/CommLog.tsx; UX 04 §2.1 "Comm log", §7.2, §G9 undo, §G12 log-line data
  attributes):
    - frequency filter tabs GND / TWR / APP / ALL (default follows the position; persisted per position)
    - radio-line data-who / data-status / data-callsign / data-selected mirror the store's RadioLine
    - typed command with autocomplete (arrow keys + Tab accept), parse error plate keeps the text, history ArrowUp
    - UNDO chip countdown (sim time) + click reverts the pending command, U hotkey, REPEAT after "say again"
    - collapse (button + F8) keeps the last line, persists; "n new" pill when scrolled up

  Boot: `/play?icao=EGLL&seed=7&spawn=none&test=1` (typedInstant on by default: Enter transmits at once; the pilot
  delay is fixed at 3 sim-s so `sim.advance(3.1)` lands the readback). Radio text is the product: text assertions are
  allowed on radio lines and reply strings only (05 §3.1).
*/
import { test, expect, type SimApi } from './fixtures/test';

const A320 = 'A320';

async function spawnArrival(sim: SimApi, cs = 'UAL9'): Promise<void> {
  await sim.spawnAt({ callsign: cs, type: A320, kind: 'arrival', phase: 'descent', posRel: { fromRunway: '27L', alongNM: -20, offsetNM: -6, altFt: 8000 }, heading: 90, speedKts: 250 });
}

test.describe('comm log', () => {
  test('filter tabs GND / TWR / APP / ALL gate lines by frequency and follow the position @smoke', async ({ openGame, sim, page }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'ground' });
    const gates = await sim.gates();
    await sim.spawnAt({ callsign: 'BAW1', type: A320, kind: 'departure', phase: 'parked', gate: gates[0], plan: { runway: '27L' } });   // ground
    await sim.spawnAt({ callsign: 'AFR3', type: A320, kind: 'departure', phase: 'hold_short', runway: '27L' });                       // tower
    await spawnArrival(sim, 'UAL9');                                                                                                // approach
    const all = await sim.radio();
    const posOf = (cs: string) => all.find((l) => l.callsign === cs)?.position;
    expect(posOf('BAW1')).toBe('ground');
    expect(posOf('AFR3')).toBe('tower');
    expect(posOf('UAL9')).toBe('approach');

    // default filter = the position's own frequency; the boot line (no frequency) shows everywhere
    await expect(game.logFilter('gnd')).toHaveAttribute('aria-selected', 'true');
    await expect(game.logFilter('gnd')).toHaveAttribute('data-state', 'on');
    await expect(game.logFilter('all')).toHaveAttribute('data-state', 'off');
    const shown = async () => (await game.radioRows()).map((r) => r.callsign ?? 'SYS');
    await expect.poll(shown).toEqual(['SYS', 'BAW1']);

    await game.logFilter('twr').click();
    await expect(game.logFilter('twr')).toHaveAttribute('aria-selected', 'true');
    await expect.poll(shown).toEqual(['SYS', 'AFR3']);
    await game.logFilter('app').click();
    await expect.poll(shown).toEqual(['SYS', 'UAL9']);
    await game.showAllFrequencies();
    await expect.poll(shown).toEqual(['SYS', 'BAW1', 'AFR3', 'UAL9']);
    expect((await game.radioRows()).map((r) => r.text)).toEqual(all.map((l) => l.text));

    // the choice is per position and persisted; other positions keep their own default
    await expect.poll(() => page.evaluate(() => localStorage.getItem('skycontrol_log_filter'))).toBe(JSON.stringify({ ground: 'all' }));
    await game.setPosition('tower');
    await expect(game.logFilter('twr')).toHaveAttribute('aria-selected', 'true');
    await expect.poll(shown).toEqual(['SYS', 'AFR3']);
    await game.setPosition('approach');
    await expect(game.logFilter('app')).toHaveAttribute('aria-selected', 'true');
    await game.setPosition('ground');
    await expect(game.logFilter('all')).toHaveAttribute('aria-selected', 'true');
    await page.reload();
    await game.waitReady();
    await expect(game.logFilter('all')).toHaveAttribute('aria-selected', 'true');
  });

  test('radio lines carry data-who / data-status / data-callsign and select the aircraft on click @smoke', async ({ openGame, sim }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'approach' });
    await spawnArrival(sim);
    await expect(game.radioLines().first()).toHaveAttribute('data-who', 'SYS');
    await expect(game.radioLines().first()).toHaveAttribute('data-clickable', 'false');
    await expect(game.radioLines().nth(1)).toHaveAttribute('data-callsign', 'UAL9');
    await expect(game.radioLines().nth(1)).toHaveAttribute('data-clickable', 'true');

    const atc = await game.sendOk('UAL9 HEADING 180');
    expect(atc.who).toBe('ATC');
    expect(atc.callsign).toBe('UAL9');
    expect(atc.status).toBe('pending');                                        // UNDO ring open until the readback
    const line = game.radioLineByKey(atc.key);
    await expect(line).toHaveAttribute('data-who', 'ATC');
    await expect(line).toHaveAttribute('data-status', 'pending');
    await expect(line.getByTestId('radio-text')).toContainText(/one eight zero/i);
    const stored = (await sim.radio()).find((l) => l.key === atc.key);
    expect(stored?.who).toBe('ATC');
    expect(stored?.text).toBe(atc.text);
    expect(stored?.undoUntil).toBeGreaterThan(await sim.time());

    // pilot readback lands after the pilot delay; the ATC line is then executed
    await sim.advance(3.1);
    const rb = await game.waitRadio(/one eight zero|180/i, { who: 'PILOT', callsign: 'UAL9' });
    expect(rb.status).toBe('executed');
    await expect(game.radioLineByKey(rb.key)).toHaveAttribute('data-who', 'PILOT');
    await expect(line).toHaveAttribute('data-status', 'executed');
    expect((await sim.lastRadio('PILOT'))?.callsign).toBe('UAL9');

    // the log mirrors the store (order + speaker) and clicking a line selects its aircraft
    const dom = await game.radioRows();
    const store = await sim.radio();
    expect(dom.map((r) => [r.who, r.text])).toEqual(store.map((l) => [l.who, l.text]));
    await expect(line).toHaveAttribute('data-selected', 'false');
    await line.click();
    await expect(game.panel()).toHaveAttribute('data-callsign', 'UAL9');
    await expect(game.strip('UAL9')).toHaveAttribute('data-selected', 'true');
    await expect(line).toHaveAttribute('data-selected', 'true');
    expect((await sim.snapshot()).selectedId).toBe((await sim.aircraftOrFail('UAL9')).id);

    // a refused (silent) command is a SYS error line with the reason
    const bad = await game.send('ZZZ999 HEADING 180');
    expect(bad.accepted).toBe(false);
    await game.showAllFrequencies();
    const sys = await game.waitRadio(/ZZZ999/i, { who: 'SYS' });
    expect(sys.status).toBe('error');
  });

  test('typed command with autocomplete: Tab accepts, arrow keys move the active item, Enter transmits @full', async ({ openGame, sim }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'approach' });
    await spawnArrival(sim, 'UAL9');
    await spawnArrival(sim, 'DAL5');
    await expect(game.cmdAutocomplete()).toHaveCount(0);

    // callsign completion
    await game.cmdInput().click();
    await game.cmdInput().pressSequentially('UA');
    await expect(game.cmdAutocomplete()).toBeVisible();
    await expect(game.cmdInput()).toHaveAttribute('aria-expanded', 'true');
    await expect(game.cmdAutocompleteItem(0)).toContainText('UAL9');
    await game.cmdInput().press('Tab');
    await expect(game.cmdInput()).toHaveValue('UAL9 ');
    await expect(game.cmdAutocomplete()).toBeVisible();                       // the aircraft's verbs follow the callsign
    const kind = /(callsign|verb|runway|taxiway|fix|stand|aircraft|vehicle|number|keyword)$/;
    const verbs = await game.autocompleteLabels();
    expect(verbs.length).toBeGreaterThan(0);
    expect(verbs.every((l) => kind.exec(l)?.[1] === 'verb')).toBe(true);

    // verb completion: typing narrows the list, ArrowDown moves the active item, Tab accepts it
    await game.cmdInput().pressSequentially('HE');
    await expect(game.cmdAutocomplete()).toBeVisible();
    await expect.poll(async () => (await game.autocompleteLabels()).every((l) => /HEADING/i.test(l))).toBe(true);
    const labels = await game.autocompleteLabels();
    expect(labels.length).toBeGreaterThanOrEqual(2);
    const verb = (i: number) => labels[i].replace(kind, '');
    await game.cmdInput().press('ArrowDown');
    await game.cmdInput().press('Tab');
    await expect(game.cmdInput()).toHaveValue(`UAL9 ${verb(1)} `);
    await game.cmdInput().pressSequentially('180');
    await game.cmdInput().press('Enter');
    await expect(game.cmdInput()).toHaveValue('');
    const atc = await game.waitRadio(/one eight zero/i, { who: 'ATC', callsign: 'UAL9' });
    expect(atc.status).toBe('pending');
    await sim.advance(3.1);
    const a = await sim.aircraftOrFail('UAL9');
    expect(a.navMode).toBe('heading');
    expect(Math.round(((a.targetHeading % 360) + 360) % 360)).toBeCloseTo(180, -1);

    // ArrowUp wraps to the last item; Escape closes the menu (keeps the text); the SEND button transmits too
    await game.cmdInput().pressSequentially('DA');
    await expect(game.cmdAutocomplete()).toBeVisible();
    await expect(game.cmdAutocompleteItem(0)).toContainText('DAL5');
    await game.cmdInput().press('Escape');
    await expect(game.cmdAutocomplete()).toHaveCount(0);
    await expect(game.cmdInput()).toHaveValue('DA');
    await game.sendViaButton('DAL5 SPEED 210');
    await expect(game.cmdInput()).toHaveValue('');
    await game.waitRadio(/two one zero|210/i, { who: 'ATC', callsign: 'DAL5' });
    await sim.advance(3.1);
    expect((await sim.aircraftOrFail('DAL5')).cmdIas).toBe(210);
  });

  test('parse error shows the reason and keeps the text; history recalls with ArrowUp / ArrowDown @full', async ({ openGame, sim, page }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'approach' });
    await spawnArrival(sim);
    const before = (await sim.radio()).length;

    const bad = await game.send('UAL9 FOO BAR');
    expect(bad.accepted).toBe(false);
    expect(bad.error).toMatch(/FOO|unknown|unable/i);
    await expect(game.cmdParseError()).toBeVisible();
    await expect(game.cmdParseError()).toHaveAttribute('role', 'alert');
    await expect(game.cmdInput()).toHaveValue('UAL9 FOO BAR');
    await expect(game.cmdInput()).toBeFocused();
    expect((await sim.aircraftOrFail('UAL9')).pendingCmds).toEqual([]);
    // nothing transmitted: only the SYS reason was logged
    const after = await sim.radio();
    expect(after.length).toBe(before + 1);
    expect(after[after.length - 1].who).toBe('SYS');
    expect(after[after.length - 1].status).toBe('error');
    expect(after[after.length - 1].text).toMatch(/FOO/);
    await expect(game.radioLines().last()).toHaveAttribute('data-status', 'error');
    // editing clears the plate
    await game.cmdInput().press('End');
    await game.cmdInput().press('Backspace');
    await expect(game.cmdParseError()).toHaveCount(0);
    await expect(game.cmdInput()).toHaveValue('UAL9 FOO BA');

    // Escape clears the text, a second Escape blurs the input
    await game.cmdInput().press('Escape');
    await expect(game.cmdInput()).toHaveValue('');
    await expect(game.cmdInput()).toBeFocused();
    await game.cmdInput().press('Escape');
    await expect(game.cmdInput()).not.toBeFocused();

    // history: newest first with ArrowUp, ArrowDown walks back to the empty line
    await game.sendOk('UAL9 HEADING 180');
    await game.sendOk('UAL9 DESCEND 5000');
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('skycontrol_cmd_history') ?? '[]'))).toEqual(['UAL9 DESCEND 5000', 'UAL9 HEADING 180']);
    await game.cmdInput().click();
    await expect(game.cmdInput()).toHaveValue('');
    await game.cmdInput().press('ArrowUp');
    await expect(game.cmdInput()).toHaveValue('UAL9 DESCEND 5000');
    // a recalled line re-sends as a new transmission and the history stays de-duplicated
    const atcBefore = (await sim.radio()).filter((l) => l.who === 'ATC').length;
    await game.cmdInput().press('Enter');
    await expect(game.cmdInput()).toHaveValue('');
    await expect.poll(async () => (await sim.radio()).filter((l) => l.who === 'ATC').length).toBe(atcBefore + 1);
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('skycontrol_cmd_history') ?? '[]'))).toEqual(['UAL9 DESCEND 5000', 'UAL9 HEADING 180']);
    // "last plane called" prefills the callsign
    await game.logLastCalled().click();
    await expect(game.cmdInput()).toHaveValue('UAL9 ');
    await expect(game.cmdInput()).toBeFocused();
    await game.hotkey('Escape');
    await game.cmdInput().fill('');
    await game.hotkey('Shift+R');
    await expect(game.cmdInput()).toHaveValue('UAL9 ');
  });

  test('history walks with repeated ArrowUp and back down with ArrowDown @full', async ({ openGame, sim }) => {
    test.fixme(true, 'BUG: src/game/CommLog/CommLog.tsx:289-306 — the recalled text opens the autocomplete menu (value non-empty + focused), and while menuOpen ArrowUp / ArrowDown move the menu\'s active item instead of the history index, so only the newest entry can ever be recalled');
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'approach' });
    await spawnArrival(sim);
    await game.sendOk('UAL9 HEADING 180');
    await game.sendOk('UAL9 DESCEND 5000');
    await game.cmdInput().click();
    await game.cmdInput().press('ArrowUp');
    await expect(game.cmdInput()).toHaveValue('UAL9 DESCEND 5000');
    await game.cmdInput().press('ArrowUp');
    await expect(game.cmdInput()).toHaveValue('UAL9 HEADING 180');
    await game.cmdInput().press('ArrowUp');                                 // stays at the oldest entry
    await expect(game.cmdInput()).toHaveValue('UAL9 HEADING 180');
    await game.cmdInput().press('ArrowDown');
    await expect(game.cmdInput()).toHaveValue('UAL9 DESCEND 5000');
    await game.cmdInput().press('ArrowDown');
    await expect(game.cmdInput()).toHaveValue('');
  });

  test('UNDO chip counts down in sim time and reverts the pending command; U hotkey; the ring closes at the readback @smoke', async ({ openGame, sim, page }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'approach' });
    await spawnArrival(sim);
    const hdg0 = (await sim.aircraftOrFail('UAL9')).targetHeading;
    await game.selectStrip('UAL9');

    const atc = await game.sendOk('UAL9 HEADING 180');
    const chip = game.lineUndo(atc.key);
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute('data-remaining', '3.0');
    await expect(chip).toContainText(/UNDO/);
    await expect(game.undoChip()).toHaveAttribute('data-remaining', '3.0');       // panel footer chip for the selected aircraft
    expect((await sim.aircraftOrFail('UAL9')).pendingCmds.map((c) => c.kind)).toEqual(['heading']);

    await sim.advance(1);
    await expect(chip).toHaveAttribute('data-remaining', '2.0');
    await expect(game.undoChip()).toHaveAttribute('data-remaining', '2.0');
    await sim.advance(0.5);
    await expect(chip).toHaveAttribute('data-remaining', '1.5');

    // click -> "disregard" transmitted, the line is marked undone, the pending command is gone
    await chip.click();
    await expect(game.radioLineByKey(atc.key)).toHaveAttribute('data-status', 'undone');
    await expect(game.radioLineByKey(atc.key).getByTestId('radio-text')).toContainText(/disregarded/i);
    await expect(chip).toHaveCount(0);
    await expect(game.undoChip()).toHaveCount(0);
    const disregard = await game.waitRadio(/disregard/i, { who: 'ATC', callsign: 'UAL9' });
    expect(disregard.key).toBeGreaterThan(atc.key);
    expect((await sim.aircraftOrFail('UAL9')).pendingCmds).toEqual([]);
    expect((await sim.radio()).find((l) => l.key === atc.key)?.status).toBe('undone');
    await sim.advance(3.5);
    const a = await sim.aircraftOrFail('UAL9');
    expect(a.targetHeading).toBeCloseTo(hdg0, 0);                                     // the turn never happened
    expect(a.pendingCmds).toEqual([]);

    // U hotkey undoes the newest transmission inside its window
    const second = await game.sendOk('UAL9 DESCEND 5000');
    await expect(game.lineUndo(second.key)).toBeVisible();
    expect((await sim.aircraftOrFail('UAL9')).pendingCmds.map((c) => c.kind)).toEqual(['altitude']);
    await game.hotkey('U');
    await expect(game.radioLineByKey(second.key)).toHaveAttribute('data-status', 'undone');
    expect((await sim.aircraftOrFail('UAL9')).pendingCmds).toEqual([]);
    await sim.advance(3.5);
    expect((await sim.aircraftOrFail('UAL9')).cmdAltitude).not.toBe(5000);

    // the ring closes with the readback: after the pilot delay there is nothing to undo and the command executed
    const third = await game.sendOk('UAL9 SPEED 220');
    await expect(game.lineUndo(third.key)).toBeVisible();
    await sim.advance(3.1);
    await expect(game.lineUndo(third.key)).toHaveCount(0);
    await expect(game.radioLineByKey(third.key)).toHaveAttribute('data-status', 'executed');
    await expect(page.locator('[data-testid$="-undo"]')).toHaveCount(0);
    expect((await sim.aircraftOrFail('UAL9')).cmdIas).toBe(220);
    await game.hotkey('U');                                                          // nothing to undo: no new line
    const n = (await sim.radio()).length;
    await sim.flush();
    expect((await sim.radio()).length).toBe(n);
  });

  test('after UNDO the pilot does not read back the disregarded instruction @full', async ({ openGame, sim }) => {
    test.fixme(true, 'BUG: src/lib/sim/engine.ts:2292 cmdDisregard() drops the pending command but leaves its ScheduledReadback in `readbacks`: after "disregard" at t+1.5 the pilot still reads back "Heading one eight zero" at t+3.0, then "Disregard" at t+4.5');
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'approach' });
    await spawnArrival(sim);
    const atc = await game.sendOk('UAL9 HEADING 180');
    await sim.advance(1.5);
    await game.lineUndo(atc.key).click();
    await expect(game.radioLineByKey(atc.key)).toHaveAttribute('data-status', 'undone');
    await sim.advance(5);
    const pilot = (await sim.radio()).filter((l) => l.who === 'PILOT' && l.callsign === 'UAL9');
    expect(pilot.map((l) => l.text).join(' | ')).not.toMatch(/one eight zero/i);       // the cancelled instruction is never read back
    expect(pilot.some((l) => /disregard/i.test(l.text))).toBe(true);
    await expect(game.radioLines('PILOT').filter({ hasText: /one eight zero/i })).toHaveCount(0);
  });

  test('REPEAT chip appears on the ATC line answered with "say again" and re-transmits it @full', async ({ openGame, sim, page }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'approach' });
    await spawnArrival(sim);
    const atc = await game.sendOk('UAL9 HEADING 180');
    await expect(game.lineRepeat(atc.key)).toHaveCount(0);
    await sim.advance(3.1);
    await game.waitRadio(/one eight zero|180/i, { who: 'PILOT', callsign: 'UAL9' });

    // the pilot asks for a repeat (engine request) -> PILOT line + REPEAT chip on the last ATC line for that aircraft
    await sim.request('UAL9', 'say_again');
    const ask = await game.waitRadio(/say again/i, { who: 'PILOT', callsign: 'UAL9' });
    expect(ask.key).toBeGreaterThan(atc.key);
    await expect(game.lineRepeat(atc.key)).toBeVisible();
    await expect(page.locator('[data-testid$="-repeat"]')).toHaveCount(1);
    expect((await sim.aircraftOrFail('UAL9')).requests.some((r) => r.kind === 'say_again' && r.answeredAt == null)).toBe(true);

    // click -> the same instruction is transmitted again as a new ATC line (a new pending heading, same value)
    const atcBefore = (await sim.radio()).filter((l) => l.who === 'ATC').length;
    await game.lineRepeat(atc.key).click();
    await expect.poll(async () => (await sim.radio()).filter((l) => l.who === 'ATC').length).toBe(atcBefore + 1);
    const again = (await sim.radio()).filter((l) => l.who === 'ATC').pop()!;
    expect(again.key).toBeGreaterThan(ask.key);
    expect(again.text).toBe(atc.text);
    await expect(game.radioLineByKey(again.key)).toHaveAttribute('data-who', 'ATC');
    await expect(game.lineUndo(again.key)).toBeVisible();
    expect((await sim.aircraftOrFail('UAL9')).pendingCmds.map((c) => c.kind)).toEqual(['heading']);
    await sim.advance(3.1);
    expect(Math.round((await sim.aircraftOrFail('UAL9')).targetHeading)).toBeCloseTo(180, -1);
  });

  test('collapse keeps the last line and the command line; F8 toggles; persists across reload @full', async ({ openGame, sim, page }) => {
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'approach' });
    await spawnArrival(sim);
    await expect(game.commLog()).toHaveAttribute('data-collapsed', 'false');
    await expect(game.logCollapse()).toHaveAttribute('data-state', 'open');
    await expect(game.logCollapse()).toHaveAttribute('aria-expanded', 'true');
    await expect(game.radioLog()).toBeVisible();
    await expect(game.logLastLine()).toHaveCount(0);

    await game.logCollapse().click();
    await expect(game.commLog()).toHaveAttribute('data-collapsed', 'true');
    await expect(game.shell()).toHaveAttribute('data-log-collapsed', 'true');
    await expect(game.logCollapse()).toHaveAttribute('data-state', 'collapsed');
    await expect(game.radioLog()).toHaveCount(0);
    const last = (await sim.radio()).pop()!;
    await expect(game.logLastLine()).toContainText(last.text);
    await expect(game.logLastLine()).toContainText(last.who);
    await expect(game.cmdInput()).toBeVisible();                                    // the command line stays usable
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('skycontrol_panels') ?? '{}').log)).toBe(true);

    // the collapsed header tracks the newest line (the list itself is not rendered while collapsed)
    const r = await game.send('UAL9 HEADING 180');
    expect(r.accepted).toBe(true);
    const newest = (await sim.radio()).pop()!;
    expect(newest.who).toBe('ATC');
    expect(newest.callsign).toBe('UAL9');
    await expect(game.logLastLine()).toContainText(newest.text);
    await expect(game.logLastLine()).toContainText('UAL9');

    // F8 expands; reload restores the persisted state; "/" focuses the command line
    await game.hotkey('F8');
    await expect(game.commLog()).toHaveAttribute('data-collapsed', 'false');
    await expect(game.radioLog()).toBeVisible();
    await game.hotkey('F8');
    await expect(game.commLog()).toHaveAttribute('data-collapsed', 'true');
    await page.reload();
    await game.waitReady();
    await expect(game.commLog()).toHaveAttribute('data-collapsed', 'true');
    await game.hotkey('/');
    await expect(game.cmdInput()).toBeFocused();
    await expect(game.commLog()).toHaveAttribute('data-collapsed', 'false');       // focusing the command line expands the log
  });

  test('"n new" pill appears when scrolled up and new lines arrive; clicking it scrolls to the bottom @full', async ({ openGame, sim }) => {
    // BUG: src/design/primitives/ScrollArea/ScrollArea.tsx:30 calls `onAtBottomChange` inside the `setAtBottom` updater,
    // so React logs "Cannot update a component (`CommLog`) while rendering a different component (`ScrollArea`)" as a
    // console.error whenever the log is scrolled (the console collector fails the test on it).
    test.fixme(true, 'BUG: src/design/primitives/ScrollArea/ScrollArea.tsx:30 — onAtBottomChange is invoked inside the setAtBottom updater; React reports "Cannot update a component (CommLog) while rendering a different component (ScrollArea)" (console.error) on every scroll of the radio log');
    const game = await openGame({ icao: 'EGLL', spawn: 'none', position: 'ground' });
    const gates = await sim.gates();
    for (let i = 0; i < 20; i++) await sim.spawnAt({ callsign: `TST${i}`, type: A320, kind: 'departure', phase: 'parked', gate: gates[5 + i], plan: { runway: '27L' } });
    await expect(game.radioLines()).toHaveCount(21);
    await expect(game.logNewPill()).toHaveCount(0);
    const scrolled = await game.radioLog().evaluate((el) => el.scrollHeight > el.clientHeight + 8);
    expect(scrolled).toBe(true);

    await game.radioLog().evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
    await sim.request('TST1', 'pushback');
    await expect(game.logNewPill()).toBeVisible();
    await expect(game.logNewPill()).toHaveText(/1 new/);
    await sim.request('TST2', 'pushback');
    await expect(game.logNewPill()).toHaveText(/2 new/);
    expect((await sim.radio()).slice(-2).every((l) => l.who === 'PILOT')).toBe(true);

    await game.logNewPill().click();
    await expect(game.logNewPill()).toHaveCount(0);
    await expect.poll(() => game.radioLog().evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 8)).toBe(true);
  });
});
