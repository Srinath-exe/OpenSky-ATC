const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage();
  await p.goto('http://127.0.0.1:3005/reports/voice-ai.html');
  const r = await p.evaluate(async () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return { sr: false, ua: navigator.userAgent };
    const proto = SR.prototype;
    const avail = typeof SR.available;
    return { sr: true, ua: navigator.userAgent, phrases: 'phrases' in proto, processLocally: 'processLocally' in proto, Phrase: typeof window.SpeechRecognitionPhrase, available: avail, install: typeof SR.install, startLen: proto.start.length, coi: self.crossOriginIsolated, gpu: !!navigator.gpu };
  });
  console.log(JSON.stringify(r)); await b.close();
})();
