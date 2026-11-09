// The phone app's recogniser seen from the page (src/lib/voice/recognizer.ts createNativeRecognizer): a mocked
// `window.OpenATCNative` JavaScriptChannel records what the page posts, and the test answers with the
// `openatc-native` CustomEvents the Flutter app dispatches (mobile/lib/src/bridge/protocol.dart).
// Runs under node:test like the other engine tests (scripts/test-sim.sh tests/engine/voice-native.test.ts).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createNativeRecognizer, nativeSpeechAvailable, NATIVE_EVENT } from '../../src/lib/voice/recognizer';
import type { NativeEvent, NativeStatus } from '../../src/lib/voice/recognizer';

type Win = EventTarget & { OpenATCNative?: { postMessage(m: string): void }; setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
const g = globalThis as unknown as { window?: Win };
let posted: Array<Record<string, unknown>>;

function installWindow(withBridge = true) {
  const w = new EventTarget() as Win;
  w.setTimeout = setTimeout;
  w.clearTimeout = clearTimeout;
  if (withBridge) w.OpenATCNative = { postMessage: (m: string) => { posted.push(JSON.parse(m)); } };
  g.window = w;
}
const fromApp = (detail: NativeEvent) => g.window!.dispatchEvent(new CustomEvent(NATIVE_EVENT, { detail }));
const lastOf = (type: string) => [...posted].reverse().find((m) => m.type === type);

beforeEach(() => { posted = []; installWindow(); });
afterEach(() => { delete g.window; });

test('the native engine exists only when the app bridge is there', () => {
  assert.equal(nativeSpeechAvailable(), true);
  installWindow(false);
  assert.equal(nativeSpeechAvailable(), false);
  assert.equal(createNativeRecognizer(), null);
  delete g.window;
  assert.equal(nativeSpeechAvailable(), false, 'server render: no window');
});

test('asks the app for its status and follows the hello', () => {
  const seen: NativeStatus[] = [];
  const rec = createNativeRecognizer((s) => seen.push(s))!;
  assert.equal(rec.kind, 'native');
  assert.deepEqual(posted[0], { v: 1, type: 'hello' });
  fromApp({ type: 'hello', state: 'ready', model: { id: 'zipformer-en-2023-06-26-int8' }, hotwords: true, streaming: true });
  assert.equal(seen.at(-1)?.state, 'ready');
  assert.equal(seen.at(-1)?.model, 'zipformer-en-2023-06-26-int8');
});

test('push-to-talk: start with hotwords, partials, stop resolves with the final transcript and the phone timing', async () => {
  const seen: NativeStatus[] = [];
  const rec = createNativeRecognizer((s) => seen.push(s))!;
  const partials: string[] = [];
  rec.onPartial = (t) => partials.push(t);
  rec.setHints!(['speedbird 273', 'ups 973']);
  rec.start();
  const start = lastOf('start')!;
  assert.equal(start.v, 1);
  assert.equal(typeof start.id, 'number');
  assert.deepEqual(start.hotwords, ['speedbird 273', 'ups 973']);
  const id = start.id as number;

  fromApp({ type: 'started', id });
  fromApp({ type: 'partial', id, text: 'SPEEDBIRD TWO' });
  fromApp({ type: 'partial', id: id + 99, text: 'someone else' });
  assert.equal(partials.at(-1), 'SPEEDBIRD TWO');
  assert.ok(!partials.includes('someone else'), 'partials of another utterance are ignored');

  const done = rec.stop();
  assert.deepEqual(lastOf('stop'), { v: 1, type: 'stop', id });
  fromApp({ type: 'final', id, text: ' SPEEDBIRD TWO SEVEN THREE CLIMB FLIGHT LEVEL ONE ZERO ZERO ', ms: 84.2, computeMs: 410, audioMs: 3100, rtf: 0.132, model: 'zf@1' });
  assert.equal(await done, 'SPEEDBIRD TWO SEVEN THREE CLIMB FLIGHT LEVEL ONE ZERO ZERO');
  assert.equal(seen.at(-1)?.lastMs, 84.2);
  assert.equal(seen.at(-1)?.lastRtf, 0.132);
});

test('an app error for this utterance is shown and the stop resolves empty', async () => {
  const rec = createNativeRecognizer()!;
  const errors: string[] = [];
  rec.onError = (m) => errors.push(m);
  rec.start();
  const id = lastOf('start')!.id as number;
  fromApp({ type: 'error', id, code: 'mic-denied', message: 'Microphone permission is off.' });
  assert.deepEqual(errors, ['Microphone permission is off.']);
  const done = rec.stop();
  // the app already gave up on this id; it will not send a final, the timeout must not hang the command bar
  fromApp({ type: 'error', id, code: 'stt', message: 'no utterance' });
  assert.equal(await done, '');
});

test('a silent app does not hang the command bar', async () => {
  const rec = createNativeRecognizer(undefined, 30)!;
  const errors: string[] = [];
  rec.onError = (m) => errors.push(m);
  rec.start();
  assert.equal(await rec.stop(), '');
  assert.match(errors[0] ?? '', /did not return/);
});

test('each push-to-talk gets a new id; a late final for an old one does not leak into the new one', async () => {
  const rec = createNativeRecognizer()!;
  rec.start();
  const first = lastOf('start')!.id as number;
  const p1 = rec.stop();
  rec.start();
  const second = lastOf('start')!.id as number;
  assert.notEqual(first, second);
  const p2 = rec.stop();
  fromApp({ type: 'final', id: second, text: 'B', ms: 1, computeMs: 1, audioMs: 1, rtf: 1, model: 'm' });
  fromApp({ type: 'final', id: first, text: 'A', ms: 1, computeMs: 1, audioMs: 1, rtf: 1, model: 'm' });
  assert.deepEqual([await p1, await p2], ['A', 'B']);
});
