// ============================================================
//  Shared simulation store — the single source of truth behind BOTH the Ground
//  map and the Approach radar. Owns one SimEngine, the OSM ground graph, the
//  parsed Endless-ATC airspace, one shared LocalProjection, and runs ONE sim
//  loop (RAF) continuously regardless of which view is mounted.
// ============================================================
import { SimEngine } from '@/lib/sim/engine';
import { buildOsmAirport, OsmAirport } from '@/lib/osmAirport';
import { EAirport, loadEndlessAirport, coordToXY } from '@/lib/airspace/eairport';
import { parseCommand } from '@/lib/sim/commands';
import type { WeightClass } from '@/lib/sim/aircraftDB';
import { XY, advance, headingTo } from '@/lib/sim/projection';
import type { ILSRunway } from '@/lib/sim/ils';

const NM = 1852, DEG = Math.PI / 180;

export const ATC_AIRPORTS: Record<string, { center: [number, number]; groundZoom: number; name: string; city: string }> = {
  EGLL: { center: [-0.4543, 51.4700], groundZoom: 13.4, name: 'Heathrow', city: 'London' },
  KLAX: { center: [-118.4081, 33.9416], groundZoom: 13.5, name: 'Los Angeles Intl', city: 'Los Angeles' },
  KJFK: { center: [-73.7781, 40.6413], groundZoom: 13.3, name: 'John F. Kennedy', city: 'New York' },
  KSFO: { center: [-122.3790, 37.6213], groundZoom: 13.5, name: 'San Francisco Intl', city: 'San Francisco' },
  KBOS: { center: [-71.0096, 42.3656], groundZoom: 13.5, name: 'Logan Intl', city: 'Boston' },
  VIDP: { center: [77.1000, 28.5562], groundZoom: 13.1, name: 'Indira Gandhi', city: 'Delhi' },
};

export interface RadarBeacon { id: string; x: number; y: number; pron?: string; holdHeading?: number; }
export interface RadarRunway { id: string; name: string; thr: XY; course: number; locCourse: number; gsDeg: number; lengthM: number; }
export interface RadarEntry { x: number; y: number; heading: number; beacon?: string; altFt: number; weight: number; }
export interface RadarArea { shape: 'circle' | 'polygon'; altFt: number; name?: string; radiusM?: number; center?: XY; points: XY[]; }
export interface RadarScene {
  centerXY: XY; radiusM: number;
  beacons: RadarBeacon[]; runways: RadarRunway[]; entries: RadarEntry[]; areas: RadarArea[];
}

export interface RadioLine { who: 'ATC' | 'PILOT' | 'SYS'; text: string; key: number; }

const LS_SCORE_KEY = 'skycontrol_high_score';
const LS_TTS_KEY = 'skycontrol_tts';
// Shared localStorage keys so the settings page and the sim store agree on names.
export const LS_KEYS = {
  score: LS_SCORE_KEY, tts: LS_TTS_KEY,
  groundTheme: 'skycontrol_ground_theme',
  autoTower: 'skycontrol_autotower',
};

function speak(text: string) {
  if (typeof window === 'undefined') return;
  if (!window.speechSynthesis) return;
  const u = new SpeechSynthesisUtterance(text.toLowerCase());
  u.rate = 1.05; u.pitch = 0.88; u.volume = 0.85;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
}

class SimStore {
  engine: SimEngine | null = null;
  osm: OsmAirport | null = null;
  airspace: EAirport | null = null;
  radar: RadarScene | null = null;
  icao = '';
  loading = false;
  rate = 1;
  paused = false;
  selectedId: number | null = null;
  radio: RadioLine[] = [];
  highScore = 0;
  tts = false; // text-to-speech readbacks

  private raf = 0;
  private last = 0;
  private nextSpawn = 0;
  private lineKey = 0;
  private emitTick = 0;
  private listeners = new Set<() => void>();

  constructor() {
    if (typeof window !== 'undefined') {
      this.highScore = parseInt(localStorage.getItem(LS_SCORE_KEY) ?? '0', 10);
      this.tts = localStorage.getItem(LS_TTS_KEY) === '1';
    }
  }

  toggleTTS() {
    this.tts = !this.tts;
    if (typeof window !== 'undefined') localStorage.setItem(LS_TTS_KEY, this.tts ? '1' : '0');
    this.emit();
  }

  subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private emit() { for (const l of this.listeners) l(); }

  pushRadio(who: RadioLine['who'], text: string) {
    if (!text) return;
    this.radio = [...this.radio.slice(-60), { who, text, key: ++this.lineKey }];
    if (who === 'PILOT' && this.tts) speak(text);
    this.emit();
  }

  select(id: number | null) {
    this.selectedId = id;
    // Dismiss the attention flag when player selects the aircraft
    if (id != null && this.engine) {
      const a = this.engine.byId(id);
      if (a) { a.attention = false; a.underControl = true; }
    }
    this.emit();
  }
  setRate(r: number) { this.rate = r; this.emit(); }
  togglePause() { this.paused = !this.paused; this.emit(); }

  async load(icao: string, activeRunwayEnds?: string[], runwayWeightAllow?: Record<string, WeightClass[]>) {
    this.loading = true; this.icao = icao; this.radio = []; this.selectedId = null; this.emit();
    let fc: any, airspace: EAirport | null = null;
    try {
      [fc, airspace] = await Promise.all([
        fetch(`/maps/osm/${icao}.geojson`).then(r => r.json()),
        loadEndlessAirport(icao).catch(() => null),
      ]);
    } catch { this.loading = false; this.emit(); return; }
    if (this.icao !== icao) return;

    const osm = buildOsmAirport(icao, fc);
    this.osm = osm;
    this.airspace = airspace;
    this.engine = new SimEngine(osm);
    this.engine.setActiveRunwayEnds(activeRunwayEnds ?? null);
    this.engine.setRunwayWeightAllow(runwayWeightAllow ?? null);
    if (typeof window !== 'undefined') this.engine.autoTower = localStorage.getItem(LS_KEYS.autoTower) !== '0';
    this.radar = airspace ? this.buildRadar(airspace) : null;

    // Pass airspace config to the engine (ILS data + beacons)
    if (airspace && this.radar) {
      const ilsRunways: ILSRunway[] = this.radar.runways.map(r => ({
        name: r.name,
        thrXY: r.thr,
        rwdHdg: r.course,
        locCourse: r.locCourse,
        gsDeg: r.gsDeg,
        thrElevFt: 0,
      }));
      this.engine.setAirspaceConfig({
        radiusM: this.radar.radiusM,
        ilsRunways,
        beacons: this.radar.beacons.map(b => ({ id: b.id, x: b.x, y: b.y })),
      });
    }

    this.nextSpawn = 0;
    for (let i = 0; i < 4; i++) this.engine.spawnDeparture();
    // Spawn a couple of arrivals at entry points if we have airspace data
    if (this.radar?.entries.length) {
      for (let i = 0; i < 3; i++) this._spawnArrivalAtEntry();
    } else {
      for (let i = 0; i < 3; i++) this.engine.spawnArrival();
    }
    this.pushRadio('SYS', `${ATC_AIRPORTS[icao]?.name ?? icao} — ${osm.gates.length} stands, ${osm.runways.length} runways${airspace ? `, ${airspace.airspace.radiusNM} NM TMA` : ''} online`);
    this.loading = false; this.emit();
    this.start();
  }

  // Spawn arrival at a boundary entry point (weighted random).
  private _spawnArrivalAtEntry(): void {
    const e = this.engine; const r = this.radar;
    if (!e || !r?.entries.length) { e?.spawnArrival(); return; }
    // Weighted pick (weight = traffic share for that entry)
    const total = r.entries.reduce((s, ep) => s + ep.weight, 0);
    let pick = Math.random() * total;
    let ep = r.entries[0];
    for (const entry of r.entries) { pick -= entry.weight; if (pick <= 0) { ep = entry; break; } }
    e.spawnArrivalAtEntry({ x: ep.x, y: ep.y }, ep.heading, ep.altFt, ep.beacon);
  }

  // Project the parsed airspace into the engine's shared XY space
  private buildRadar(ap: EAirport): RadarScene {
    const proj = this.engine!.proj;
    const centerXY = coordToXY({ kind: 'll', lat: ap.airspace.center.lat, lng: ap.airspace.center.lng }, proj);
    const radiusM = ap.airspace.radiusNM * NM;
    const beacons: RadarBeacon[] = ap.airspace.beacons.map(b => { const p = coordToXY(b.coord, proj); return { id: b.id, x: p.x, y: p.y, pron: b.pron, holdHeading: b.holdHeading }; });
    const runways: RadarRunway[] = ap.runways.map(r => {
      const thr = coordToXY(r.coord, proj);
      return { id: r.id, name: r.name, thr, course: r.trueHeading, locCourse: r.localizerCourse, gsDeg: r.glideslopeDeg, lengthM: r.lengthFt * 0.3048 };
    });
    const entries: RadarEntry[] = ap.entryPoints.map(e => {
      const pos = advance(centerXY, (e.heading + 180) % 360, radiusM);
      return { x: pos.x, y: pos.y, heading: e.heading, beacon: e.beacon, altFt: e.altitudeFt, weight: e.weight };
    });
    const areas: RadarArea[] = ap.areas.map(a => ({
      shape: a.shape, altFt: a.altitudeFt, name: a.name,
      radiusM: a.radiusNM ? a.radiusNM * NM : undefined,
      center: a.center ? coordToXY(a.center, proj) : undefined,
      points: a.points.map(p => coordToXY(p, proj)),
    }));
    return { centerXY, radiusM, beacons, runways, entries, areas };
  }

  command(text: string) {
    const e = this.engine; if (!e || !text.trim()) return;
    this.pushRadio('ATC', text.toUpperCase());
    const r = parseCommand(e, text);
    this.pushRadio(r.ok ? 'PILOT' : 'SYS', r.reply);
  }

  spawnDeparture() { this.engine?.spawnDeparture(); }
  spawnArrival() {
    if (this.radar?.entries.length) this._spawnArrivalAtEntry();
    else this.engine?.spawnArrival();
  }
  clearTraffic() { this.engine?.clear(); this.selectedId = null; this.emit(); }

  private start() {
    if (this.raf) return;
    this.last = performance.now();
    const tick = (now: number) => {
      this.raf = requestAnimationFrame(tick);
      const e = this.engine; if (!e) return;
      const dt = Math.min((now - this.last) / 1000, 0.1); this.last = now;
      if (this.paused) return;
      const events = e.update(dt * this.rate);
      for (const ev of events) {
        if (['spawn', 'ground_conflict', 'separation_loss', 'diversion', 'info'].includes(ev.type)) this.pushRadio('SYS', ev.message);
        else if (['airborne', 'touchdown', 'arrived', 'departed', 'go_around'].includes(ev.type)) this.pushRadio('PILOT', ev.message);
      }
      // Auto-spawn to keep field alive
      const cap = Math.min(14, Math.ceil(e.skill) + 2);
      if (e.time >= this.nextSpawn && e.aircraft.length < cap) {
        if (Math.random() < 0.55) e.spawnDeparture(); else this._spawnArrivalAtEntry();
        this.nextSpawn = e.time + 5 + Math.random() * 8;
      }
      // Persist high score
      if (e.score > this.highScore) {
        this.highScore = e.score;
        if (typeof window !== 'undefined') localStorage.setItem(LS_SCORE_KEY, String(this.highScore));
      }
      // Clear selection if aircraft gone
      if (this.selectedId != null && !e.byId(this.selectedId)) { this.selectedId = null; this.emit(); }
      // Periodic emit so sidebar ALT/SPD/HDG metrics stay live (~10/sec at 60fps)
      if (++this.emitTick % 6 === 0) this.emit();
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop() { cancelAnimationFrame(this.raf); this.raf = 0; }
}

// browser-only singleton (HMR-safe)
export const sim: SimStore = (typeof window !== 'undefined' && (window as any).__atcSim)
  || ((typeof window !== 'undefined') ? ((window as any).__atcSim = new SimStore()) : new SimStore());

// glideslope intercept distance (NM from threshold) for an altitude on a gs°
export function gsInterceptNM(altFt: number, gsDeg: number, thrElevFt = 0): number {
  return (altFt - thrElevFt) / (Math.tan(gsDeg * DEG) * 6076);
}
export { headingTo, advance, NM };
