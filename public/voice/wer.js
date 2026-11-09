// Word error for the voice test pages (/reports/voice-loopback.html, /reports/voice-stt-test.html): both sides as
// lower-case words with numbers digit by digit ("niner" = "nine" = 9, "fife" = 5, "two seven left" = "27L",
// "seven thousand" = "7000"), then a word alignment.
// ── scoring: words, numbers digit by digit ──
const DIG = { zero: '0', oh: '0', one: '1', two: '2', three: '3', tree: '3', four: '4', fower: '4', five: '5', fife: '5', six: '6', seven: '7', eight: '8', nine: '9', niner: '9' };
const TEEN = { ten: '10', eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18', nineteen: '19' };
const TENS = { twenty: '2', thirty: '3', forty: '4', fifty: '5', sixty: '6', seventy: '7', eighty: '8', ninety: '9' };
const SIDE = { l: 'left', r: 'right', c: 'center' };
export function words(s) {
  const raw = s.toLowerCase().replace(/(\d)\s*-\s*(\d)/g, '$1 $2').replace(/[-–]/g, ' ').replace(/(\d),(\d{3})/g, '$1$2')
    .replace(/[^a-z0-9.\s]/g, ' ').replace(/\.(?!\d)/g, ' ').split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i];
    let m;
    if ((m = t.match(/^(\d+)([lrc])$/))) { out.push(...m[1].split(''), SIDE[m[2]]); continue; }
    if ((m = t.match(/^(\d+)\.(\d+)$/))) { out.push(...m[1].split(''), 'point', ...m[2].split('')); continue; }
    if (/^\d+$/.test(t)) { out.push(...t.split('')); continue; }
    if (t === 'decimal' || t === 'point') { out.push('point'); continue; }
    if (t === 'thousand') { out.push('0', '0', '0'); continue; }
    if (t === 'hundred') { out.push('0', '0'); continue; }
    if (DIG[t]) { out.push(DIG[t]); continue; }
    if (TEEN[t]) { out.push(...TEEN[t].split('')); continue; }
    if (TENS[t]) { const n = raw[i + 1]; if (n && DIG[n] && DIG[n] !== '0') { out.push(TENS[t], DIG[n]); i++; } else out.push(TENS[t], '0'); continue; }
    if (t === 'fl') { out.push('flight', 'level'); continue; }
    out.push(t);
  }
  return out;
}
/** Word alignment: errors, and the heard words marked (substituted / inserted) plus the reference words missed. */
export function align(ref, hyp) {
  const n = ref.length, m = hyp.length, D = Array.from({ length: n + 1 }, (_, i) => { const r = new Array(m + 1).fill(0); r[0] = i; return r; });
  for (let j = 0; j <= m; j++) D[0][j] = j;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) D[i][j] = Math.min(D[i - 1][j] + 1, D[i][j - 1] + 1, D[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
  const ops = []; let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && D[i][j] === D[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1)) { ops.push({ w: hyp[j - 1], k: ref[i - 1] === hyp[j - 1] ? 'ok' : 'sub' }); i--; j--; }
    else if (j > 0 && D[i][j] === D[i][j - 1] + 1) { ops.push({ w: hyp[j - 1], k: 'ins' }); j--; }
    else { ops.push({ w: ref[i - 1], k: 'del' }); i--; }
  }
  return { errors: D[n][m], n, ops: ops.reverse() };
}

