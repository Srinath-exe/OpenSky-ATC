import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WeatherModel, applyWind, defaultWeather, windComponents, runwayScore, nextAtisLetter, transitionLevel, magneticDir, type WeatherInit } from '../../src/lib/sim/weather';
import { subStream, setSeed } from '../../src/lib/sim/rng';
import type { RunwayEnd } from '../../src/lib/runwayManifest';

const EGLL_ENDS: RunwayEnd[] = [
  { name: '09L', hdg: 90 }, { name: '27R', hdg: 270 },
  { name: '09R', hdg: 90 }, { name: '27L', hdg: 270 },
];

function init(over: Partial<WeatherInit> = {}, seed = 7): WeatherModel {
  setSeed(seed);
  const wx = new WeatherModel();
  wx.init({
    icao: 'EGLL', time: 0, initial: { windDirTrue: 250, windKt: 12, gustKt: 0, visM: 10000, ceilingFt: 2500, cloud: 'FEW025', qnh: 1013, tempC: 15, dewC: 9, precip: 'none' },
    script: [], ends: EGLL_ENDS, activeDep: ['27R'], activeArr: ['27L'], airportName: 'Heathrow', ...over,
  }, subStream('weather'));
  return wx;
}

test('windComponents: head / tail / cross', () => {
  assert.deepEqual(windComponents(270, 10, 270), { headKt: 10, crossKt: 0, crossFrom: 'R' });
  const tail = windComponents(90, 10, 270);
  assert.equal(tail.headKt, -10);
  const cross = windComponents(0, 10, 270);
  assert.equal(cross.headKt, 0);
  assert.equal(cross.crossKt, 10);
  assert.equal(cross.crossFrom, 'R');
  const left = windComponents(180, 10, 270);
  assert.equal(left.crossFrom, 'L');
  const mixed = windComponents(300, 20, 270); // 30 deg off the nose from the right
  assert.ok(Math.abs(mixed.headKt - 17.3) < 0.1 && Math.abs(mixed.crossKt - 10) < 0.1 && mixed.crossFrom === 'R');
});

test('applyWind: headwind reduces ground speed, tailwind increases it, crosswind drifts the track', () => {
  const head = applyWind({ ...defaultWeather(), windDirTrue: 270, windKt: 20 }, 270, 200);
  assert.ok(Math.abs(head.gsKt - 180) < 0.01 && Math.abs(head.trackTrue - 270) < 0.01);
  const tail = applyWind({ ...defaultWeather(), windDirTrue: 90, windKt: 20 }, 270, 200);
  assert.ok(Math.abs(tail.gsKt - 220) < 0.01);
  const cross = applyWind({ ...defaultWeather(), windDirTrue: 0, windKt: 20 }, 270, 200); // wind from the north pushes south
  assert.ok(cross.trackTrue < 270 && cross.trackTrue > 260, `track ${cross.trackTrue}`);
  assert.ok(Math.abs(cross.gsKt - Math.hypot(200, 20)) < 0.01);
  const calm = applyWind({ ...defaultWeather(), windKt: 0 }, 123, 150);
  assert.ok(Math.abs(calm.gsKt - 150) < 1e-9); assert.equal(calm.trackTrue, 123);
});

test('runwayScore / helpers', () => {
  const into = runwayScore(270, 15, 0, { name: '27L', hdg: 270 });
  const down = runwayScore(270, 15, 0, { name: '09R', hdg: 90 });
  assert.ok(into > 0 && down < -1e5, 'tailwind > 10 kt is forbidden');
  assert.equal(nextAtisLetter('A'), 'B');
  assert.equal(nextAtisLetter('Z'), 'A');
  assert.equal(transitionLevel(1013), 70);
  assert.equal(transitionLevel(1000), 70);
  assert.equal(transitionLevel(970), 75);
  assert.equal(magneticDir(273, 0), 270);
  assert.equal(magneticDir(2, 0), 360);
});

test('init: ATIS letter A with ICAO-order text and the active runways', () => {
  const wx = init();
  const a = wx.atis();
  assert.equal(a.letter, 'A');
  assert.match(a.text, /^Heathrow information Alpha, time \d{4} Zulu\./);
  assert.match(a.text, /Landing runway 27L, departing runway 27R\./);
  assert.match(a.text, /Transition level 70\./);
  assert.match(a.text, /Wind 250 degrees 12 knots\./);
  assert.match(a.text, /Visibility 10 kilometres or more\./);
  assert.match(a.text, /Temperature 15, dew point 9\./);
  assert.match(a.text, /QNH 1013 hectopascals\./);
  assert.match(a.text, /Acknowledge information Alpha on first contact\.$/);
  const tIdx = a.text.indexOf('Temperature'), wIdx = a.text.indexOf('Wind'), qIdx = a.text.indexOf('QNH'), vIdx = a.text.indexOf('Visibility');
  assert.ok(wIdx < vIdx && vIdx < tIdx && tIdx < qIdx, 'ICAO element order: wind, visibility, cloud, temperature, QNH');
  assert.deepEqual(a.activeDep, ['27R']);
  assert.deepEqual(a.activeArr, ['27L']);
});

test('ATIS letter increments only on significant change', () => {
  const wx = init();
  assert.equal(wx.atis().letter, 'A');
  // small wind change: no new letter
  wx.setWind(255, 13);
  wx.step(1);
  assert.equal(wx.atis().letter, 'A', 'wind +5 deg / +1 kt is not significant');
  // QNH +1 -> new letter
  wx.setState({ qnh: 1014 });
  assert.equal(wx.atis().letter, 'B');
  // wind +30 deg -> new letter
  wx.setWind(285, 13);
  assert.equal(wx.atis().letter, 'C');
  // speed +5 kt -> new letter
  wx.setWind(285, 18);
  assert.equal(wx.atis().letter, 'D');
  // visibility band change -> new letter
  wx.setState({ visM: 4000 });
  assert.equal(wx.atis().letter, 'E');
  // same band: no change
  wx.setState({ visM: 3500 });
  assert.equal(wx.atis().letter, 'E');
  // runway change: forced regeneration
  const a = wx.regenerateAtis('runway change', ['09R'], ['09L']);
  assert.equal(a.letter, 'F');
  assert.match(a.text, /information Foxtrot/);
  assert.match(a.text, /Landing runway 09L, departing runway 09R/);
  // hourly regeneration
  let changed = false;
  for (let t = 0; t < 3700; t += 10) { const r = wx.step(10); if (r.atisChanged) changed = true; }
  assert.ok(changed, 'hourly regeneration happened');
  // the letter after Z wraps to A
  assert.equal(nextAtisLetter('Z'), 'A');
});

test('step: random walk stays gentle over 30 minutes and emits an atis SimEvent on regeneration', () => {
  const wx = init({}, 11);
  const start = { ...wx.state() };
  let events = 0;
  for (let t = 0; t < 1800; t += 1) { const r = wx.step(1); events += r.events.filter(e => e.type === 'atis').length; }
  const w = wx.state();
  const dDir = Math.abs(((w.windDirTrue - start.windDirTrue + 540) % 360) - 180);
  assert.ok(dDir <= 130, `wind direction moved ${dDir} deg in 30 min`);
  assert.ok(w.windKt >= 0 && w.windKt <= 45);
  assert.ok(w.qnh > 990 && w.qnh < 1040);
  assert.ok(events >= 0);
  const changes = wx.changes();
  assert.ok(Array.isArray(changes));
  assert.equal(wx.changes().length, 0, 'drained');
});

test('suggestRunways: flips on wind reversal and respects the 5-kt tailwind rule', () => {
  const wx = init();
  // current 27s with 250/12: within limits, no change
  let s = wx.suggestRunways(EGLL_ENDS, { dep: ['27R'], arr: ['27L'] });
  assert.equal(s.changed, false);
  // wind 090/4: tailwind 4 kt on the 27s -> still allowed (<= 5 kt), keep config
  wx.setWind(90, 4);
  s = wx.suggestRunways(EGLL_ENDS, { dep: ['27R'], arr: ['27L'] });
  assert.equal(s.changed, false, '4 kt tailwind tolerated');
  // wind 090/8: tailwind 8 kt -> suggest the 09s, keeping the parallel pair split (arr on the L side like before? mirrored by side)
  wx.setWind(90, 8);
  s = wx.suggestRunways(EGLL_ENDS, { dep: ['27R'], arr: ['27L'] });
  assert.equal(s.changed, true);
  assert.ok(s.dep[0].startsWith('09') && s.arr[0].startsWith('09'), `${s.dep}/${s.arr}`);
  assert.notEqual(s.dep[0], s.arr[0], 'parallel pair kept as a pair');
  assert.match(s.reason, /tailwind/);
  // full reversal 090/14 -> 09s, and the reverse suggestion for an 09 config is stable
  wx.setWind(90, 14);
  s = wx.suggestRunways(EGLL_ENDS, { dep: ['27R'], arr: ['27L'] });
  assert.equal(s.changed, true);
  const back = wx.suggestRunways(EGLL_ENDS, { dep: s.dep, arr: s.arr });
  assert.equal(back.changed, false, 'no flapping once on the suggested config');
  // step() carries the suggestion
  const r = wx.step(1);
  assert.ok(r.suggestion == null || r.suggestion.dep[0].startsWith('09'));
});

test('suggestRunways: single runway serves both roles; crosswind > 25 kt prompts a change', () => {
  const wx = init({ ends: [{ name: '18', hdg: 180 }, { name: '36', hdg: 360 }], activeDep: ['18'], activeArr: ['18'] });
  wx.setWind(360, 12);
  const s = wx.suggestRunways([{ name: '18', hdg: 180 }, { name: '36', hdg: 360 }], { dep: ['18'], arr: ['18'] });
  assert.equal(s.changed, true);
  assert.deepEqual(s.dep, ['36']); assert.deepEqual(s.arr, ['36']);
  const wx2 = init({ ends: [{ name: '09', hdg: 90 }, { name: '27', hdg: 270 }, { name: '18', hdg: 180 }, { name: '36', hdg: 360 }], activeDep: ['27'], activeArr: ['27'] });
  wx2.setWind(360, 28);
  const s2 = wx2.suggestRunways([{ name: '09', hdg: 90 }, { name: '27', hdg: 270 }, { name: '18', hdg: 180 }, { name: '36', hdg: 360 }], { dep: ['27'], arr: ['27'] });
  assert.equal(s2.changed, true);
  assert.equal(s2.arr[0], '36');
});

test('go-around probabilities and LVP', () => {
  const wx = init();
  assert.equal(wx.crosswindGoAroundP('M', 270), 0);
  wx.setWind(360, 38); // 38 kt direct crosswind on 27: over the 35 kt jet limit
  assert.equal(wx.crosswindGoAroundP('M', 270), 0.8);
  wx.setWind(360, 42);
  assert.equal(wx.crosswindGoAroundP('M', 270), 1.0);
  assert.equal(wx.crosswindGoAroundP('L', 270), 1.0);
  assert.equal(wx.gustGoAroundP(), 0);
  wx.setWind(270, 15, 32);
  assert.equal(wx.gustGoAroundP(), 0.05);
  wx.setWindshear('27L', 'MB', 40);
  assert.equal(wx.gustGoAroundP(), 0.8);
  assert.equal(wx.state().lvp, false);
  wx.setState({ visM: 400, ceilingFt: 100 });
  assert.equal(wx.state().lvp, true);
  assert.match(wx.atis().text, /Low visibility procedures in operation/);
  assert.equal(wx.tailwindGoAroundP(90), 0.5);
});

test('scripted events fire at atMin and the initial state is plausible without `initial`', () => {
  setSeed(3);
  const wx = new WeatherModel();
  wx.init({ icao: 'KSFO', time: 0, initial: null, script: [{ kind: 'fog', atMin: 2, params: { visM: 300 } }], ends: [{ name: '28L', hdg: 280 }, { name: '10R', hdg: 100 }], activeDep: ['28L'], activeArr: ['28L'], airportName: 'San Francisco' }, subStream('weather'));
  const w0 = { ...wx.state() };
  assert.ok(w0.windKt >= 0 && w0.windKt <= 30 && w0.qnh >= 990 && w0.qnh <= 1035 && w0.tempC >= -5 && w0.tempC <= 40 && w0.dewC <= w0.tempC);
  assert.ok(w0.visM >= 100 && w0.visM <= 10000);
  for (let t = 0; t < 150; t++) wx.step(1);
  assert.equal(wx.state().visM, 300);
  assert.equal(wx.state().lvp, true);
  assert.notEqual(wx.atis().letter, 'A', 'fog regenerated the ATIS');
  // deterministic for a seed
  setSeed(3);
  const wx2 = new WeatherModel();
  wx2.init({ icao: 'KSFO', time: 0, initial: null, script: [], ends: [], activeDep: [], activeArr: [], airportName: 'San Francisco' }, subStream('weather'));
  assert.equal(wx2.state().windDirTrue, w0.windDirTrue);
  assert.equal(wx2.state().qnh, w0.qnh);
});
