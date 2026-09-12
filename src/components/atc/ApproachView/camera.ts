// ============================================================
//  Radar camera: world metres at the screen centre + pixels per NM. Smooth
//  zoom anchored at the cursor (180 ms ease-out), eased pans for presets and
//  centre-on (600 ms ease-in-out), drag inertia (0.92 / frame), follow lock.
//  All screen values are CSS px; the canvas applies the DPR transform.
// ============================================================
import type { XY } from '@/lib/sim/projection';
import { NM_TO_M } from '@/lib/sim/projection';

const ZOOM_MS = 180;
const PAN_MS = 600;
const MIN_PX_PER_NM = 2.5;
const MAX_PX_PER_NM = 220;

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export interface CameraView { x: number; y: number; zoom: number }

export class RadarCamera {
  x = 0;
  y = 0;
  pxPerNM = 12;
  width = 1;
  height = 1;
  /** Aircraft id the camera is locked to, null = free. */
  follow: number | null = null;

  private zoomFrom = 12;
  private zoomTo = 12;
  private zoomStart = -1;
  private anchor: { wx: number; wy: number; sx: number; sy: number } | null = null;

  private panFrom: XY = { x: 0, y: 0 };
  private panTo: XY = { x: 0, y: 0 };
  private panStart = -1;

  private vx = 0;
  private vy = 0;
  private lastMove = 0;

  get k(): number { return this.pxPerNM / NM_TO_M; }

  toScreen(p: XY): { x: number; y: number } {
    const k = this.k;
    return { x: this.width / 2 + (p.x - this.x) * k, y: this.height / 2 - (p.y - this.y) * k };
  }
  toWorld(sx: number, sy: number): XY {
    const k = this.k;
    return { x: this.x + (sx - this.width / 2) / k, y: this.y - (sy - this.height / 2) / k };
  }
  isAnimating(): boolean { return this.zoomStart >= 0 || this.panStart >= 0 || Math.hypot(this.vx, this.vy) > 0.5; }

  view(): CameraView { return { x: this.x, y: this.y, zoom: this.pxPerNM }; }

  /** Jump (no animation). */
  set(x: number, y: number, pxPerNM?: number): void {
    this.x = x; this.y = y;
    this.panStart = -1; this.zoomStart = -1; this.anchor = null; this.vx = this.vy = 0;
    if (pxPerNM != null) this.pxPerNM = clampZoom(pxPerNM);
    this.zoomTo = this.pxPerNM;
  }

  /** Fit a circle of `radiusM` around `centre` into the shorter screen edge (92 %). */
  fitRadius(centre: XY, radiusM: number, animate: boolean): void {
    const px = (Math.min(this.width, this.height) * 0.92) / (2 * radiusM / NM_TO_M);
    if (animate) { this.panTo_(centre); this.zoomTo_(px, null); }
    else this.set(centre.x, centre.y, px);
  }

  /** Eased pan to a world point (optionally with a zoom). */
  centerOn(p: XY, pxPerNM?: number, animate = true): void {
    this.follow = null;
    if (!animate) { this.set(p.x, p.y, pxPerNM); return; }
    this.panTo_(p);
    if (pxPerNM != null) this.zoomTo_(pxPerNM, null);
  }

  /** Multiplicative zoom anchored at a screen point (wheel) or the centre (buttons). */
  zoomBy(factor: number, sx?: number, sy?: number): void {
    const target = clampZoom(this.zoomTo * factor);
    if (sx == null || sy == null) { this.zoomTo_(target, null); return; }
    const w = this.toWorld(sx, sy);
    this.zoomTo_(target, { wx: w.x, wy: w.y, sx, sy });
  }

  /** Drag pan in CSS px (breaks follow). */
  panBy(dx: number, dy: number, now: number): void {
    const k = this.k;
    this.follow = null;
    this.panStart = -1;
    this.x -= dx / k; this.y += dy / k;
    const dt = Math.max(1, now - this.lastMove);
    // velocity in px/ms, smoothed
    this.vx = this.vx * 0.5 + (dx / dt) * 0.5;
    this.vy = this.vy * 0.5 + (dy / dt) * 0.5;
    this.lastMove = now;
  }
  private dragging = false;
  beginDrag(now: number): void { this.dragging = true; this.vx = this.vy = 0; this.lastMove = now; this.panStart = -1; }
  endDrag(now: number): void { this.dragging = false; if (now - this.lastMove > 80) this.vx = this.vy = 0; }
  stopInertia(): void { this.vx = this.vy = 0; }

  /** Advance animations. `now` in ms (performance.now()), `followPos` = position of the followed aircraft if any. */
  step(now: number, dtMs: number, followPos: XY | null): void {
    if (this.zoomStart >= 0) {
      const t = Math.min(1, (now - this.zoomStart) / ZOOM_MS);
      this.pxPerNM = this.zoomFrom + (this.zoomTo - this.zoomFrom) * easeOut(t);
      if (this.anchor) {
        const k = this.k;
        this.x = this.anchor.wx - (this.anchor.sx - this.width / 2) / k;
        this.y = this.anchor.wy + (this.anchor.sy - this.height / 2) / k;
      }
      if (t >= 1) { this.zoomStart = -1; this.anchor = null; this.pxPerNM = this.zoomTo; }
    }
    if (this.panStart >= 0) {
      const t = Math.min(1, (now - this.panStart) / PAN_MS);
      const e = easeInOut(t);
      this.x = this.panFrom.x + (this.panTo.x - this.panFrom.x) * e;
      this.y = this.panFrom.y + (this.panTo.y - this.panFrom.y) * e;
      if (t >= 1) this.panStart = -1;
    } else if (followPos && this.follow != null) {
      // soft lock: 1/6 per frame at 60 fps feels like a gimbal, not a snap
      const s = 1 - Math.pow(1 - 0.18, dtMs / 16.7);
      this.x += (followPos.x - this.x) * s;
      this.y += (followPos.y - this.y) * s;
    } else if (!this.dragging && Math.hypot(this.vx, this.vy) > 0.02) {
      const k = this.k;
      const decay = Math.pow(0.92, dtMs / 16.7);
      this.x -= (this.vx * dtMs) / k; this.y += (this.vy * dtMs) / k;
      this.vx *= decay; this.vy *= decay;
      if (Math.hypot(this.vx, this.vy) <= 0.02) this.vx = this.vy = 0;
    }
  }

  private zoomTo_(target: number, anchor: RadarCamera['anchor']): void {
    this.zoomFrom = this.pxPerNM; this.zoomTo = clampZoom(target);
    this.zoomStart = performance.now(); this.anchor = anchor;
  }
  private panTo_(p: XY): void {
    this.vx = this.vy = 0;
    this.panFrom = { x: this.x, y: this.y }; this.panTo = { x: p.x, y: p.y };
    this.panStart = performance.now();
  }
}

export const clampZoom = (px: number) => Math.max(MIN_PX_PER_NM, Math.min(MAX_PX_PER_NM, px));
