// S1 voice model worker (docs/spec/11-VOICE-MODEL.md L1). Runs the hand-written transformer engine
// (src/lib/voice/s1.ts, compiled to ./gen/s1.js by scripts/build-voice.sh) off the main thread.
//   in:  {type:'load', id, url} | {type:'prefill', id, ctx} | {type:'complete', id, said, callsigns, ctx?, mode?}
//        mode: 'score' (default: callsign by likelihood) | 'trie' (the first, greedy decoder), see S1Model.callsignMode
//   out: {type:'ready'|'prefilled'|'completion'|'error', id, ...}; a completion also carries `signals` (per-token evidence)
// Messages are handled in order; prefill is synchronous compute, so a completion never runs on a half-built cache.
import { S1Model } from './gen/s1.js';

let model = null;
let loading = null;

self.onmessage = async (e) => {
  const m = e.data || {};
  try {
    if (m.type === 'load') {
      loading = loading || S1Model.load(m.url).then((x) => { model = x; }, (err) => { loading = null; throw err; });   // a failed load is retried next time
      await loading;
      postMessage({ type: 'ready', id: m.id });
    } else if (m.type === 'prefill') {
      if (loading) await loading;
      const ms = model.prefill(m.ctx);
      postMessage({ type: 'prefilled', id: m.id, ms });
    } else if (m.type === 'complete') {
      if (loading) await loading;
      if (m.ctx) model.prefill(m.ctx);
      const r = model.complete(m.said, m.callsigns, 48, m.mode === 'trie' || m.mode === 'score' ? m.mode : model.callsignMode);
      postMessage({ type: 'completion', id: m.id, line: r.line, confidence: r.confidence, ms: r.ms, sayAgain: r.sayAgain, signals: r.signals });
    }
  } catch (err) {
    postMessage({ type: 'error', id: m.id, message: String(err && err.message ? err.message : err) });
  }
};
