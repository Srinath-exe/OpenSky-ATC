/*
  Radar (APPROACH scope) page object — the DOM chrome of src/components/atc/ApproachView/index.tsx plus the
  pointer gestures the canvas understands (05 §3.2 hit-testing, UX 04 §4 drag-to-heading / measure / pan).

  Test ids used (the CODE wins over 05 §3.1):
    radar-view[data-cursor] · radar-canvas · radar-toolbar · radar-tool-range-{30|15|10|final} (aria-pressed) ·
    radar-tool-zoom-in / -zoom-out · radar-tool-follow[data-state] · radar-tool-rings[data-state] ·
    radar-tool-measure[data-state] · radar-tool-centre · radar-chip · radar-chip-atis · radar-chip-wind[data-value] ·
    radar-chip-rwy · radar-chip-range[data-value] · map-hdg-readout[data-snap] · map-{hdg|dct|ils|alt}-bubble[data-kind]
    (+ -dial / -left / -right / -up / -down / -send / -cancel) · map-measure-{i} · map-measure-live · map-edge-arrow · map-tooltip

  Geometry: `sim.screenPos(cs)` is CSS px inside `radar-canvas`; `page.mouse` wants viewport px, so every gesture
  adds the canvas bounding box (`abs()`). The camera is `{x, y, zoom}` with zoom = px per NM (RadarCamera.view()).
*/
import { expect, type Page } from '@playwright/test';
import { SimApi } from '../fixtures/simApi';
import type { GamePage } from './GamePage';

export type RangePreset = '30' | '15' | '10' | 'final';
export interface RadarCam { x: number; y: number; zoom: number }
export interface Pt { x: number; y: number }

const NM_M = 1852;

export class RadarPage {
  readonly sim: SimApi;
  constructor(readonly page: Page, readonly game: GamePage) { this.sim = new SimApi(page); }

  // ── locators ─────────────────────────────────────────────────────────────
  view = () => this.page.getByTestId('radar-view');
  canvas = () => this.page.getByTestId('radar-canvas');
  toolbar = () => this.page.getByTestId('radar-toolbar');
  rangeBtn = (p: RangePreset) => this.page.getByTestId(`radar-tool-range-${p}`);
  zoomInBtn = () => this.page.getByTestId('radar-tool-zoom-in');
  zoomOutBtn = () => this.page.getByTestId('radar-tool-zoom-out');
  followBtn = () => this.page.getByTestId('radar-tool-follow');
  ringsBtn = () => this.page.getByTestId('radar-tool-rings');
  measureBtn = () => this.page.getByTestId('radar-tool-measure');
  centreBtn = () => this.page.getByTestId('radar-tool-centre');
  chip = () => this.page.getByTestId('radar-chip');
  chipRange = () => this.page.getByTestId('radar-chip-range');
  chipRwy = () => this.page.getByTestId('radar-chip-rwy');
  chipWind = () => this.page.getByTestId('radar-chip-wind');
  chipAtis = () => this.page.getByTestId('radar-chip-atis');
  hdgReadout = () => this.page.getByTestId('map-hdg-readout');
  /** Draft bubble root for a kind (`map-hdg-bubble`, `map-dct-bubble`, `map-ils-bubble`, `map-alt-bubble`). */
  bubble = (kind: 'hdg' | 'dct' | 'ils' | 'alt' = 'hdg') => this.page.getByTestId(`map-${kind}-bubble`);
  bubblePart = (part: 'dial-svg' | 'left' | 'right' | 'up' | 'down' | 'send' | 'cancel', kind: 'hdg' | 'dct' | 'ils' | 'alt' = 'hdg') => this.page.getByTestId(`map-${kind}-bubble-${part}`);
  /** Any open draft bubble. */
  anyBubble = () => this.page.locator('[data-testid$="-bubble"][data-kind]');
  measurePill = (i: number) => this.page.getByTestId(`map-measure-${i}`);
  measurePills = () => this.page.locator('[data-testid^="map-measure-"]:not([data-testid="map-measure-live"])');
  measureLive = () => this.page.getByTestId('map-measure-live');
  edgeArrow = () => this.page.getByTestId('map-edge-arrow');
  tooltip = () => this.page.getByTestId('map-tooltip');

  // ── lifecycle ────────────────────────────────────────────────────────────
  /**
   * The ApproachView is a `next/dynamic` chunk that mounts after `__atcTest.ready()`; the radar projector
   * (screenPos / camera / centerOn) exists only once it has mounted and fitted the scene. Wait for both.
   */
  async waitReady(): Promise<void> {
    await expect(this.canvas()).toBeVisible();
    await expect.poll(async () => { const c = await this.sim.camera(); return 'zoom' in c && !('lng' in c) && c.zoom !== 1 ? c.zoom : 0; }, { message: 'radar projector not registered' }).toBeGreaterThan(1);
    await expect(this.chipRange()).toHaveAttribute('data-value', /\d+/);
  }

  // ── geometry ─────────────────────────────────────────────────────────────
  async camera(): Promise<RadarCam> {
    const c = await this.sim.camera();
    if (!('zoom' in c) || 'lng' in c) throw new Error(`radar camera expected, got ${JSON.stringify(c)}`);
    return c as RadarCam;
  }
  /** World metres per CSS px at the current zoom (1 / k). */
  async metresPerPx(): Promise<number> { return NM_M / (await this.camera()).zoom; }
  async box(): Promise<{ x: number; y: number; width: number; height: number }> {
    const b = await this.canvas().boundingBox();
    expect(b, 'radar-canvas has no bounding box').not.toBeNull();
    return b!;
  }
  /** Canvas-relative CSS px -> viewport px for page.mouse. */
  async abs(p: Pt): Promise<Pt> { const b = await this.box(); return { x: b.x + p.x, y: b.y + p.y }; }
  /** Screen position of an aircraft (centres the scope on it first when it is off-view). */
  async posOf(cs: string): Promise<Pt> {
    const b = await this.box();
    let p = await this.sim.screenPos(cs);
    const inside = (q: Pt | null) => !!q && q.x >= 0 && q.y >= 0 && q.x <= b.width && q.y <= b.height;
    if (!inside(p)) { await this.sim.centerOn(cs); p = await this.sim.screenPos(cs); }
    expect(p, `${cs} has no radar screen position`).not.toBeNull();
    return p!;
  }
  /** Screen position of a radar fix / beacon by id. */
  async fixPos(id: string): Promise<Pt> {
    const p = await this.page.evaluate((fix) => {
      const s = (window as unknown as { __atcSim?: { engine?: { beacons: Array<{ id: string; x: number; y: number }> }; screenProject(xy: { x: number; y: number }): Pt | null } }).__atcSim;
      const b = s?.engine?.beacons.find((x) => x.id === fix);
      return b && s ? s.screenProject({ x: b.x, y: b.y }) : null;
    }, id);
    expect(p, `fix ${id} has no screen position`).not.toBeNull();
    return p!;
  }
  /** Engine distance from an aircraft to a runway threshold in NM (SimEngine.distToThresholdNM). */
  async distToThresholdNM(cs: string, runway: string): Promise<number | null> {
    return this.page.evaluate(([c, r]) => {
      const s = (window as unknown as { __atcSim?: { engine?: { find(cs: string): unknown; distToThresholdNM(a: unknown, rw: string): number | null } } }).__atcSim;
      const a = s?.engine?.find(c);
      return a && s?.engine ? s.engine.distToThresholdNM(a, r) : null;
    }, [cs, runway] as const);
  }
  /** Distance between two aircraft in NM (engine positions). */
  async distBetweenNM(a: string, b: string): Promise<number> {
    const [va, vb] = await Promise.all([this.sim.aircraftOrFail(a), this.sim.aircraftOrFail(b)]);
    return Math.hypot(va.pos.x - vb.pos.x, va.pos.y - vb.pos.y) / NM_M;
  }

  // ── gestures ─────────────────────────────────────────────────────────────
  /** Hover the pointer over an aircraft symbol (tooltip after 150 ms wall-clock). */
  async hoverAircraft(cs: string): Promise<void> {
    const p = await this.abs(await this.posOf(cs));
    await this.page.mouse.move(p.x, p.y);
  }
  /** Left-click the aircraft symbol (selects). */
  async clickAircraft(cs: string): Promise<void> {
    const p = await this.posOf(cs);
    await this.canvas().click({ position: p });
  }
  /** Left-click an empty spot (deselects; starts + ends an empty pan). */
  async clickEmpty(): Promise<void> {
    const p = await this.sim.emptySpot();
    await this.canvas().click({ position: p });
  }
  /**
   * Press on the aircraft and drag the pointer by (dx, dy) CSS px WITHOUT releasing (the live `map-hdg-readout`
   * is shown while the button is down). Follow with `release()` / `page.keyboard.press('Escape')`.
   */
  async beginDrag(cs: string, dx: number, dy: number, steps = 6): Promise<Pt> {
    const p = await this.posOf(cs);
    const a = await this.abs(p);
    await this.page.mouse.move(a.x, a.y);
    await this.page.mouse.down();
    await this.page.mouse.move(a.x + dx / 2, a.y + dy / 2, { steps: Math.max(1, Math.floor(steps / 2)) });
    await this.page.mouse.move(a.x + dx, a.y + dy, { steps: Math.max(1, Math.ceil(steps / 2)) });
    await expect(this.hdgReadout()).toBeVisible();
    return p;
  }
  async release(): Promise<void> { await this.page.mouse.up(); }
  /** Full drag-to-heading gesture: press on `cs`, drag by (dx, dy), release; waits for the heading bubble. */
  async dragToHeading(cs: string, dx: number, dy: number): Promise<void> {
    await this.beginDrag(cs, dx, dy);
    await this.release();
    await expect(this.bubble('hdg')).toBeVisible();
  }
  /** Drag the aircraft symbol onto a fix and release -> `map-dct-bubble`. */
  async dragToFix(cs: string, fix: string): Promise<void> {
    const p = await this.posOf(cs);
    const f = await this.fixPos(fix);
    await this.beginDrag(cs, f.x - p.x, f.y - p.y, 8);
    await expect(this.hdgReadout()).toHaveAttribute('data-snap', '1');
    await this.release();
    await expect(this.bubble('dct')).toBeVisible();
  }
  /** Expected magnetic heading (0-359, 360 for north) for a screen drag vector (screen y grows downwards). */
  static headingForDrag(dx: number, dy: number, magVar = 0): number {
    const t = (Math.atan2(dx, -dy) * 180) / Math.PI;
    const m = Math.round((((t - magVar) % 360) + 360) % 360);
    return m === 0 ? 360 : m;
  }
  /** Mouse-wheel over an empty spot (negative deltaY zooms in). */
  async wheel(deltaY: number, at?: Pt): Promise<void> {
    const p = await this.abs(at ?? (await this.sim.emptySpot()));
    await this.page.mouse.move(p.x, p.y);
    await this.page.mouse.wheel(0, deltaY);
  }
  /**
   * Drag-pan the scope by (dx, dy) CSS px from an empty spot. The pointer rests ~150 ms wall-clock before the
   * release so RadarCamera.endDrag() drops the inertia (a flick keeps gliding after mouse-up).
   */
  async pan(dx: number, dy: number): Promise<void> {
    const p = await this.abs(await this.sim.emptySpot());
    await this.page.mouse.move(p.x, p.y);
    await this.page.mouse.down();
    await this.page.mouse.move(p.x + dx / 2, p.y + dy / 2, { steps: 5 });
    await this.page.mouse.move(p.x + dx, p.y + dy, { steps: 5 });
    await this.page.waitForTimeout(150);
    await this.page.mouse.up();
  }
  /** Poll until the camera stops moving (zoom / pan easing is wall-clock). */
  async settle(): Promise<RadarCam> {
    let last = await this.camera();
    await expect.poll(async () => {
      const c = await this.camera();
      const still = Math.abs(c.x - last.x) < 0.5 && Math.abs(c.y - last.y) < 0.5 && Math.abs(c.zoom - last.zoom) < 1e-3;
      last = c;
      return still;
    }, { message: 'radar camera did not settle' }).toBe(true);
    return last;
  }
  /** Click a range preset and wait for it to be the pressed one and the camera to settle. */
  async setRange(p: RangePreset): Promise<RadarCam> {
    await this.rangeBtn(p).click();
    await expect(this.rangeBtn(p)).toHaveAttribute('aria-pressed', 'true');
    return this.settle();
  }
  /** Arm the click-click measure tool (or disarm when on). */
  async setMeasureTool(on: boolean): Promise<void> {
    if ((await this.measureBtn().getAttribute('data-state')) !== (on ? 'on' : 'off')) await this.measureBtn().click();
    await expect(this.measureBtn()).toHaveAttribute('data-state', on ? 'on' : 'off');
  }
  /** Click-click measure between two canvas points with the tool armed; returns the readout text of the new pill. */
  async measure(a: Pt, b: Pt): Promise<string> {
    await this.setMeasureTool(true);
    const n = await this.measurePills().count();
    await this.canvas().click({ position: a });
    await this.canvas().click({ position: b });
    await expect(this.measurePill(n)).toBeVisible();
    await expect(this.measurePill(n)).toHaveText(/nm/);
    return (await this.measurePill(n).textContent()) ?? '';
  }
  /** Which preset is pressed (null when none). */
  async pressedRange(): Promise<RangePreset | null> {
    for (const p of ['30', '15', '10', 'final'] as RangePreset[]) if ((await this.rangeBtn(p).getAttribute('aria-pressed')) === 'true') return p;
    return null;
  }
  /** `radar-chip-range` data-value (visible half-height in NM). */
  async rangeNM(): Promise<number> { return Number(await this.chipRange().getAttribute('data-value')); }
}
