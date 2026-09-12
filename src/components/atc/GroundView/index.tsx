'use client';
// ============================================================
//  GroundView — the GROUND and TOWER positions (00-MASTER-PLAN §2.4, UX 04
//  §2.2 / §4, design 01 §5 / A10 / A21).
//
//  MapLibre draws the pavement (buildOsmStyle: baked satellite darkened to spec
//  or the vector chart theme); an overlay canvas painted by render.ts in its
//  own RAF draws everything alive: runway status tints, tower corridors,
//  hold-short bars, stands, vehicles, aircraft silhouettes, data blocks,
//  selection ring + route preview, drag-to-heading geometry. A thin DOM layer
//  hosts what must be real elements: the toolbar (bottom-right), the layers /
//  presets popovers, the hover tooltip, the right-click quick menu, the
//  drag-vector confirm bubble and the off-screen edge arrow.
//
//  Every gesture ends in the store: select / hover, transmit('action-heading'),
//  updateSettings (theme, rings), dispatchVehicle / setRunwayStatus (context
//  menus), pushToast; the view registers itself as the 'ground' projector so
//  the test API's screenPos / centerOn / camera / setCamera work (05 §3.2) and
//  flips sim.mapReady on MapLibre 'load'.
//
//  Events the map emits for the shell (window CustomEvents, see bridge.ts):
//    atc:quick-menu        { QuickMenuAt }          right-click (also sim.quickMenuAt)
//    atc:select-vehicle    { id }                    vehicle icon clicked (also sim.selectedVehicleId)
//    atc:toggle-vehicles   { open }                  toolbar truck button outside a GameShell
//    atc:route-tap         { taxiway | runway }      map tap while the route builder is open
//    atc:map-tap           { x, y, stand?, runway? } empty-map click (engine XY) for "map point" pickers
// ============================================================
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { buildOsmStyle, readMapPalette } from '@/lib/osmMapStyle';
import type { MapPalette } from '@/lib/osmMapStyle';
import type { SimEngine } from '@/lib/sim/engine';
import type { CameraView } from '@/lib/sim/testApi';
import type { XY } from '@/lib/sim/projection';
import type { MenuOption } from '@/design';
import { Icon, usePrefersReducedMotion } from '@/design';
import { useShellOptional } from '@/game/shellContext';
import { requestOpenAction, EV_ROUTE_TAP, EV_MAP_TAP } from '@/game/CommandPanel/bus';
import { sim as store, ATC_AIRPORTS, useSim, useSimVersion } from '../simStore';
import { groundUi, useGroundUi, playerPosition, groundTheme, showRings, openQuickMenu, toggleVehiclesPanel, sim as gsim } from './bridge';
import type { GroundTheme, PlayerPosition, QuickMenuAt } from './bridge';
import { readCanvasPalette } from './colors';
import { buildGroundGeometry } from './geometry';
import type { GroundGeometry } from './geometry';
import { frameCam, bearingScreen } from './mercator';
import type { FrameCam } from './mercator';
import { GroundRenderer } from './render';
import type { DragState, FrameInput } from './render';
import { hitAircraft, hitVehicle, hitStand, hitRunway, screenToXY, taxiwayAt } from './interaction';
import { autoPresets, loadUserPresets, saveUserPreset, USER_SLOTS } from './presets';
import type { CameraPreset, UserPreset } from './presets';
import { aircraftTip, vehicleTip } from './tooltip';
import type { TipModel } from './tooltip';
import { Toolbar, LayersPopover, PresetsPopover, QuickMenu, HeadingBubble, HoverTooltip } from './chrome';
import styles from './GroundView.module.css';

// abort-rejection swallow: MapLibre aborts tile/image fetches on setStyle; Next's dev overlay treats
// the rejected promise as an error. Patched once per window.
if (typeof window !== 'undefined' && !(window as unknown as { __abortFetchPatched?: boolean }).__abortFetchPatched) {
  (window as unknown as { __abortFetchPatched?: boolean }).__abortFetchPatched = true;
  const orig = window.fetch.bind(window);
  window.fetch = (i: RequestInfo | URL, init?: RequestInit) => orig(i, init).catch((e: unknown) => { if ((e as { name?: string })?.name === 'AbortError') return new Promise<Response>(() => {}); throw e; });
}

const MIN_ZOOM = 11;
const MAX_ZOOM = 19;
const DRAG_PX = 12;
const HOVER_MS = 150;
const BUBBLE_TTL_MS = 6000;
const CAMERA_MS = 300;
const FIT_PADDING = 48;

type TipTarget = { kind: 'aircraft'; id: number } | { kind: 'vehicle'; id: string } | null;
interface Bubble { id: number; x: number; y: number; hdgTrue: number; dir: 'L' | 'R' | null; key: number }
interface Press { id: number; x: number; y: number }

const noop = () => {};

export interface GroundViewProps {
  /** Optional override; the store's `settings.groundTheme` is the source of truth. */
  theme?: GroundTheme;
}

/** Floating chrome over the map (strip bay left, command panel right), from the shell's CSS variables. */
function chromeInsets(el: HTMLElement | null): { left: number; right: number; top: number; bottom: number } {
  if (!el) return { left: 0, right: 0, top: 0, bottom: 0 };
  const r = el.getBoundingClientRect();
  const bay = document.querySelector<HTMLElement>('[data-testid="strip-bay"]');
  const panel = document.querySelector<HTMLElement>('[data-testid="detail-panel"]');
  const tools = el.querySelector<HTMLElement>('[data-testid="map-toolbar"]');
  const left = bay ? bay.getBoundingClientRect().right - r.left : 0;
  const right = Math.max(panel ? r.right - panel.getBoundingClientRect().left : 0, tools ? r.right - tools.getBoundingClientRect().left : 0);
  return { left: Math.max(0, Math.min(left, r.width / 2)), right: Math.max(0, Math.min(right, r.width / 2)), top: 0, bottom: 0 };
}

export default function GroundView({ theme: themeProp }: GroundViewProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const mapDiv = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const edgeRef = useRef<HTMLButtonElement>(null);
  const edgeIconRef = useRef<HTMLSpanElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const rendererRef = useRef<GroundRenderer | null>(null);
  const geomRef = useRef<GroundGeometry | null>(null);
  const camRef = useRef<FrameCam>({ cx: 0, cy: 0, ws: 1, w: 1, h: 1, zoom: 13, pxPerM: 1, centreLat: 0 });
  const dragRef = useRef<DragState | null>(null);
  const pressRef = useRef<Press | null>(null);
  const suppressClick = useRef(false);
  const readyRef = useRef(false);
  const themePropRef = useRef(themeProp);
  themePropRef.current = themeProp;
  const reducedMotion = usePrefersReducedMotion();
  const reducedRef = useRef(false);
  reducedRef.current = reducedMotion;
  const shell = useShellOptional();
  const shellRef = useRef(shell);
  shellRef.current = shell;

  // ── React-visible state (all low-frequency) ──
  const [tip, setTip] = useState<TipTarget>(null);
  const [menu, setMenu] = useState<QuickMenuAt | null>(null);
  const [bubble, setBubble] = useState<Bubble | null>(null);
  const [hostSize, setHostSize] = useState({ w: 1, h: 1 });
  const [userPresets, setUserPresets] = useState<Array<UserPreset | null>>(() => Array.from({ length: USER_SLOTS }, () => null));
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [geomVersion, setGeomVersion] = useState(0);
  const bubbleKey = useRef(0);

  const follow = useGroundUi(s => s.follow);
  const layers = useGroundUi(s => s.layers);
  const popover = useGroundUi(s => s.popover);
  const position = useSim(s => (s.position === 'approach' ? 'approach' : s.position) as PlayerPosition);
  const theme = useSim(s => (themeProp ?? (s.settings.groundTheme === 'chart' ? 'chart' : 'satellite')) as GroundTheme, [themeProp]);
  const rings = useSim(s => !!s.settings.showRings);
  const selectedId = useSim(s => s.selectedId);
  const paused = useSim(s => s.paused);
  const icao = useSim(s => s.icao);
  const vehiclesOpen = shell ? !!shell.open.vehicles : !!gsim.vehiclesPanelOpen;

  // ══════════════════════════════════════════════════════════════════════════
  //  Map lifecycle + RAF loop (mounted once)
  // ══════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    const host = mapDiv.current, cv = canvasRef.current;
    if (!host || !cv || mapRef.current) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;

    const icao0 = (store.icao || 'EGLL').toUpperCase();
    const start = ATC_AIRPORTS[icao0] ?? ATC_AIRPORTS.EGLL;
    const engine0 = store.engine;
    const centre0: [number, number] = engine0 ? [engine0.air.center.lng, engine0.air.center.lat] : start.center;
    let palette: MapPalette = readMapPalette();
    let styledTheme: GroundTheme = themePropRef.current ?? groundTheme();
    let styledIcao = icao0;
    const m = new maplibregl.Map({
      container: host,
      style: buildOsmStyle(icao0, styledTheme, palette, centre0[1]),
      center: centre0, zoom: start.groundZoom, minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM,
      attributionControl: false, dragRotate: false, pitchWithRotate: false, touchPitch: false, fadeDuration: 0,
      renderWorldCopies: false,
    });
    m.touchZoomRotate.disableRotation();
    m.keyboard.disable();
    m.on('error', noop);
    mapRef.current = m;

    const renderer = new GroundRenderer(readCanvasPalette());
    rendererRef.current = renderer;
    let fontsReady = false;
    const fontsPromise = typeof document !== 'undefined' && document.fonts ? document.fonts.ready : Promise.resolve();
    fontsPromise.then(() => { fontsReady = true; renderer.setPalette(readCanvasPalette(true)); }).catch(() => { fontsReady = true; });

    let lastEngine: SimEngine | null = null;
    let firstFit = true;
    let raf = 0;
    let hoverTimer = 0;
    let hoverKey = '';
    let lastFollowKey = '';

    // ── projector (test API + panels) ──
    const project = (xy: XY): { x: number; y: number } | null => {
      const e = store.engine; if (!e || !readyRef.current) return null;
      const ll = e.proj.toLngLat(xy.x, xy.y);
      const p = m.project([ll.lng, ll.lat]);
      return { x: p.x, y: p.y };
    };
    const centerOn = (xy: XY): void => {
      const e = store.engine; if (!e) return;
      const ll = e.proj.toLngLat(xy.x, xy.y);
      m.jumpTo({ center: [ll.lng, ll.lat] });
    };
    const camera = (): CameraView => { const c = m.getCenter(); return { lng: c.lng, lat: c.lat, zoom: m.getZoom() }; };
    const setCamera = (cam: CameraView): void => {
      if ('lng' in cam) { m.jumpTo({ center: [cam.lng, cam.lat], zoom: cam.zoom }); return; }
      const e = store.engine; if (!e) return;
      const ll = e.proj.toLngLat(cam.x, cam.y);
      m.jumpTo({ center: [ll.lng, ll.lat], zoom: cam.zoom });
    };
    const size = () => ({ w: host.clientWidth, h: host.clientHeight });
    let unregister: (() => void) | null = null;
    m.on('load', () => {
      readyRef.current = true;
      unregister = store.registerProjector('ground', project, centerOn, camera, { setCamera, size });
      store.setMapReady(true);
    });

    const camByPos: Partial<Record<PlayerPosition, { center: [number, number]; zoom: number }>> = {};

    // ── geometry / style sync ──
    const syncAirport = () => {
      const e = store.engine;
      if (e === lastEngine) return;
      lastEngine = e;
      dragRef.current = null; pressRef.current = null;
      if (!e) { geomRef.current = null; return; }
      const geom = buildGroundGeometry(e);
      geomRef.current = geom;
      // the store drops mapReady on every load(); re-assert once the (possibly new) style is in
      const reassert = () => { if (readyRef.current) store.setMapReady(true); };
      if (geom.icao !== styledIcao) {
        styledIcao = geom.icao;
        m.setStyle(buildOsmStyle(styledIcao, styledTheme, palette, geom.centre.lat));   // audit B16: rebuild, never only setData
      }
      reassert();                                                    // the map itself is loaded; the projector needs only the engine
      for (const k of Object.keys(camByPos) as PlayerPosition[]) delete camByPos[k];
      m.fitBounds(geom.bounds, { padding: FIT_PADDING, duration: firstFit || reducedRef.current ? 0 : 600 });
      firstFit = false;
      setUserPresets(loadUserPresets(geom.icao, playerPosition()));
      setGeomVersion(v => v + 1);
      renderer.setPalette(readCanvasPalette(true));
    };
    const syncTheme = () => {
      const t = themePropRef.current ?? groundTheme();
      if (t === styledTheme) return;
      styledTheme = t;
      palette = readMapPalette();
      m.setStyle(buildOsmStyle(styledIcao, styledTheme, palette, geomRef.current?.centre.lat));
    };

    // ── sizing ──
    const syncSize = () => {
      const mc = m.getCanvas();
      const w = host.clientWidth, h = host.clientHeight;
      if (cv.width !== mc.width || cv.height !== mc.height) { cv.width = mc.width; cv.height = mc.height; }
      if (cv.style.width !== `${w}px`) { cv.style.width = `${w}px`; cv.style.height = `${h}px`; }
      return { w, h, dpr: w > 0 ? mc.width / w : 1 };
    };
    const ro = new ResizeObserver(() => { m.resize(); setHostSize(size()); });
    ro.observe(host);
    setHostSize(size());

    // ── frame ──
    const input: FrameInput = {
      cam: camRef.current, now: 0, position: 'ground', theme: styledTheme, layers: groundUi.state.layers, showRings: false,
      selectedId: null, hoveredId: null, selectedVehicleId: null, hoveredVehicleId: null, drag: null, version: 0, reducedMotion: false,
    };
    const positionTip = () => {
      const el = tooltipRef.current; if (!el) return;
      const t = tipRef.current; const e = store.engine; const cam = camRef.current;
      if (!t || !e) return;
      let x = 0, y = 0, r = 12;
      if (t.kind === 'aircraft') { const h = renderer.acHits.find(q => q.id === t.id); if (!h) return; x = h.x; y = h.y; r = h.r; }
      else { const h = renderer.vehHits.find(q => q.id === t.id); if (!h) return; x = h.x; y = h.y; r = h.r; }
      const w = el.offsetWidth || 200, hh = el.offsetHeight || 80;
      let tx = x + r + 12, ty = y - hh / 2;
      if (tx + w > cam.w - 8) tx = x - r - 12 - w;
      ty = Math.max(8, Math.min(cam.h - hh - 8, ty));
      el.style.transform = `translate(${Math.round(tx)}px, ${Math.round(ty)}px)`;
    };
    const positionEdge = () => {
      const el = edgeRef.current; if (!el) return;
      const edge = renderer.edge;
      if (!edge) { if (el.dataset.open !== 'false') el.dataset.open = 'false'; return; }
      el.dataset.open = 'true';
      el.style.transform = `translate(${Math.round(edge.x)}px, ${Math.round(edge.y)}px)`;
      el.setAttribute('aria-label', `Pan to ${edge.callsign}`);
      if (edgeIconRef.current) edgeIconRef.current.style.transform = `rotate(${Math.round(edge.angle)}deg)`;
    };
    // UX §2.2: switching positions animates to that position's last camera (overview the first time).
    let lastPos: PlayerPosition = playerPosition();
    const syncPosition = () => {
      const pos = playerPosition();
      if (pos === lastPos) return;
      const c = m.getCenter();
      camByPos[lastPos] = { center: [c.lng, c.lat], zoom: m.getZoom() };
      lastPos = pos;
      const dur = reducedRef.current ? 0 : CAMERA_MS;
      const saved = camByPos[pos];
      if (saved) m.easeTo({ center: saved.center, zoom: saved.zoom, duration: dur });
      else if (geomRef.current) m.fitBounds(geomRef.current.bounds, { padding: FIT_PADDING, duration: dur });
      setUserPresets(loadUserPresets(styledIcao, pos));
    };
    const syncSubjects = (e: SimEngine) => {
      const t = tipRef.current;
      if (t && (t.kind === 'aircraft' ? !e.byId(t.id) : !e.fleet.byId(t.id))) setTipSafe(null);
      const mn = menuRef.current;
      if (mn && mn.kind === 'aircraft' && typeof mn.id === 'number' && !e.byId(mn.id)) setMenuSafe(null);
      const b = bubbleRef.current;
      if (b && !e.byId(b.id)) setBubbleSafe(null);
    };
    const perf = { drawMs: 0, frames: 0 };
    if (process.env.NODE_ENV !== 'production') (window as unknown as { __atcGroundPerf?: typeof perf }).__atcGroundPerf = perf;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      syncAirport();
      syncTheme();
      syncPosition();
      const { w, h, dpr } = syncSize();
      const e = store.engine, geom = geomRef.current;
      if (!e || !geom || !fontsReady || w === 0 || h === 0) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height); return; }
      // follow
      if (groundUi.state.follow && store.selectedId != null) {
        const a = e.byId(store.selectedId);
        if (a) {
          const ll = e.proj.toLngLat(a.pos.x, a.pos.y);
          const key = `${ll.lng.toFixed(7)},${ll.lat.toFixed(7)}`;
          if (key !== lastFollowKey) { lastFollowKey = key; m.jumpTo({ center: [ll.lng, ll.lat] }); }
        } else groundUi.setFollow(false);
      }
      const c = m.getCenter();
      frameCam(c.lng, c.lat, m.getZoom(), w, h, camRef.current);
      input.now = now; input.position = playerPosition(); input.theme = styledTheme; input.layers = groundUi.state.layers; input.showRings = showRings();
      input.insets = chromeInsets(rootRef.current);
      input.selectedId = store.selectedId; input.hoveredId = store.hoveredId;
      input.selectedVehicleId = groundUi.state.selectedVehicleId; input.hoveredVehicleId = groundUi.state.hoveredVehicleId;
      input.drag = dragRef.current; input.version = store.version; input.reducedMotion = reducedRef.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const t0 = performance.now();
      renderer.draw(ctx, e, geom, input);
      perf.drawMs = perf.drawMs * 0.9 + (performance.now() - t0) * 0.1; perf.frames++;
      if ((perf.frames & 15) === 0) syncSubjects(e);
      positionTip();
      positionEdge();
    };
    raf = requestAnimationFrame(tick);

    // ── hover ──
    const setHover = (acId: number | null, vehId: string | null) => {
      const key = acId != null ? `a${acId}` : vehId ? `v${vehId}` : '';
      store.hover(acId);
      if (groundUi.state.hoveredVehicleId !== vehId) groundUi.patch({ hoveredVehicleId: vehId });
      if (key === hoverKey) return;
      hoverKey = key;
      if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = 0; }
      if (!key) { setTipSafe(null); return; }
      hoverTimer = window.setTimeout(() => { hoverTimer = 0; setTipSafe(acId != null ? { kind: 'aircraft', id: acId } : { kind: 'vehicle', id: vehId! }); }, HOVER_MS);
    };
    m.on('mousemove', ev => {
      if (pressRef.current) return;
      const a = hitAircraft(renderer.acHits, ev.point.x, ev.point.y);
      const v = a ? null : hitVehicle(renderer.vehHits, ev.point.x, ev.point.y);
      m.getCanvas().style.cursor = a || v ? 'pointer' : '';
      setHover(a ? a.id : null, v ? v.id : null);
    });
    m.on('mouseout', () => { m.getCanvas().style.cursor = ''; setHover(null, null); });

    // ── click / context ──
    m.on('click', ev => {
      if (suppressClick.current) { suppressClick.current = false; return; }
      closeFloating();
      const e = store.engine; const geom = geomRef.current;
      const p = ev.point;
      const a = hitAircraft(renderer.acHits, p.x, p.y);
      if (a) { store.select(a.id); groundUi.selectVehicle(null); return; }
      const v = hitVehicle(renderer.vehHits, p.x, p.y);
      if (v) { groundUi.selectVehicle(v.id); store.select(null); return; }
      if (!e || !geom) { store.select(null); return; }
      const cam = camRef.current;
      const picking = document.body.dataset.routeBuild === '1' || document.body.dataset.mapPick === '1';
      const rw = hitRunway(geom, cam, p.x, p.y);
      const st = rw ? null : hitStand(geom, cam, p.x, p.y);
      const xy = screenToXY(e, cam, p.x, p.y);
      if (picking) {
        if (rw) { window.dispatchEvent(new CustomEvent(EV_ROUTE_TAP, { detail: { runway: rw.end.name } })); return; }
        const tw = taxiwayAt(e, xy);
        if (tw) { window.dispatchEvent(new CustomEvent(EV_ROUTE_TAP, { detail: { taxiway: tw.taxiway, nodeId: tw.nodeId } })); }
        window.dispatchEvent(new CustomEvent(EV_MAP_TAP, { detail: { x: xy.x, y: xy.y, stand: st?.ref } }));
        return;                                                     // never deselect while a picker is listening
      }
      window.dispatchEvent(new CustomEvent(EV_MAP_TAP, { detail: { x: xy.x, y: xy.y, stand: st?.ref, runway: rw?.end.name } }));
      store.select(null);
      groundUi.selectVehicle(null);
    });
    m.on('contextmenu', ev => {
      ev.preventDefault();
      closeFloating();
      const geom = geomRef.current; const e = store.engine;
      const p = ev.point; const oe = ev.originalEvent;
      const base = { x: p.x, y: p.y, clientX: oe.clientX, clientY: oe.clientY, at: performance.now() };
      const a = hitAircraft(renderer.acHits, p.x, p.y);
      if (a) { open({ ...base, kind: 'aircraft', id: a.id }); return; }
      const v = hitVehicle(renderer.vehHits, p.x, p.y);
      if (v) { open({ ...base, kind: 'vehicle', id: v.id }); return; }
      if (geom && e) {
        const cam = camRef.current;
        const st = hitStand(geom, cam, p.x, p.y);
        if (st) { open({ ...base, kind: 'stand', id: st.ref }); return; }
        const rw = hitRunway(geom, cam, p.x, p.y);
        if (rw) { open({ ...base, kind: 'runway', id: rw.end.name }); return; }
      }
      open({ ...base, kind: 'map', id: null });
    });
    const open = (at: QuickMenuAt) => { openQuickMenu(at); setMenu(at); };

    // ── manual pan breaks follow; wheel / drag close floating chrome ──
    m.on('dragstart', () => {
      closeFloating();
      if (groundUi.state.follow) { groundUi.setFollow(false); store.pushToast({ kind: 'info', text: 'Follow off', duration: 2000 }); }
    });
    m.on('wheel', () => { setMenuSafe(null); groundUi.closePopover(); });
    m.on('zoomstart', () => setActivePresetSafe(null));
    m.on('dragstart', () => setActivePresetSafe(null));

    // ── drag-to-heading (pointer capture on the host so MapLibre's pan never starts) ──
    const local = (e: PointerEvent) => { const r = host.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || !fontsReady) return;
      const p = local(e);
      const h = hitAircraft(renderer.acHits, p.x, p.y);
      if (!h || !h.airborne) return;
      pressRef.current = { id: h.id, x: p.x, y: p.y };
      m.dragPan.disable();
    };
    const onMove = (e: PointerEvent) => {
      const press = pressRef.current; if (!press) return;
      const p = local(e);
      const h = renderer.acHits.find(q => q.id === press.id);
      if (!h) { cancelPress(); return; }
      const hdgTrue = bearingScreen(h.x, h.y, p.x, p.y);
      let d = dragRef.current;
      if (!d) {
        if (Math.hypot(p.x - press.x, p.y - press.y) < DRAG_PX) return;
        d = dragRef.current = { id: press.id, x: p.x, y: p.y, hdgTrue, dir: null, active: true };
        m.getCanvas().style.cursor = 'crosshair';
        closeFloating();
        setHover(null, null);
      }
      d.x = p.x; d.y = p.y; d.hdgTrue = hdgTrue;
    };
    const onUp = (e: PointerEvent) => {
      const press = pressRef.current; if (!press) return;
      const d = dragRef.current;
      pressRef.current = null; dragRef.current = null;
      m.dragPan.enable();
      m.getCanvas().style.cursor = '';
      if (!d) return;
      armSuppress();
      const p = local(e);
      const hdg = Math.round(d.hdgTrue / 5) * 5 % 360;
      if (store.settings.instantVectors) { sendHeading(d.id, hdg, d.dir); return; }
      setBubbleSafe({ id: d.id, x: p.x, y: p.y, hdgTrue: hdg, dir: d.dir, key: ++bubbleKey.current });
    };
    const cancelPress = () => { pressRef.current = null; dragRef.current = null; m.dragPan.enable(); m.getCanvas().style.cursor = ''; };
    // MapLibre drops its own 'click' when the pointer travelled > 3 px, so the flag must self-clear
    // right after the native click (if any) has been dispatched.
    const armSuppress = () => { suppressClick.current = true; window.setTimeout(() => { suppressClick.current = false; }, 0); };
    const onKey = (e: KeyboardEvent) => {
      const d = dragRef.current; if (!d) return;
      if (e.key === 'l' || e.key === 'L') { d.dir = d.dir === 'L' ? null : 'L'; e.preventDefault(); }
      else if (e.key === 'r' || e.key === 'R') { d.dir = d.dir === 'R' ? null : 'R'; e.preventDefault(); }
      else if (e.key === 'Escape') { cancelPress(); armSuppress(); e.preventDefault(); e.stopPropagation(); }
    };
    host.addEventListener('pointerdown', onDown, { capture: true });
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('keydown', onKey, true);

    return () => {
      cancelAnimationFrame(raf);
      if (hoverTimer) clearTimeout(hoverTimer);
      ro.disconnect();
      host.removeEventListener('pointerdown', onDown, { capture: true });
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('keydown', onKey, true);
      unregister?.();
      readyRef.current = false;
      store.setMapReady(false);
      store.hover(null);
      mapRef.current = null; rendererRef.current = null; geomRef.current = null;
      m.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── setState wrappers safe to call from the imperative loop ──
  const tipRef = useRef<TipTarget>(null);
  const setTipSafe = useCallback((t: TipTarget) => { tipRef.current = t; setTip(t); }, []);
  const setMenuSafe = useCallback((at: QuickMenuAt | null) => { setMenu(at); if (!at) gsim.quickMenuAt = null; }, []);
  const setBubbleSafe = useCallback((b: Bubble | null) => setBubble(b), []);
  const setActivePresetSafe = useCallback((id: string | null) => setActivePreset(id), []);
  const closeFloating = useCallback(() => { setMenuSafe(null); setBubbleSafe(null); groundUi.closePopover(); }, [setMenuSafe, setBubbleSafe]);

  // ── heading transmit ──
  const sendHeading = useCallback((id: number, hdgTrue: number, dir: 'L' | 'R' | null) => {
    const a = store.byId(id); if (!a) return;
    store.transmit('action-heading', { heading: ((hdgTrue % 360) + 360) % 360 || 360, dir }, a);
    setBubble(null);
  }, []);

  // ── bubble auto-dismiss ──
  useEffect(() => {
    if (!bubble) return;
    const t = window.setTimeout(() => setBubble(b => (b && b.key === bubble.key ? null : b)), BUBBLE_TTL_MS);
    return () => clearTimeout(t);
  }, [bubble]);

  // ── the RAF loop clears the menu / bubble when their subject leaves the sim (see tick) ──
  const menuRef = useRef<QuickMenuAt | null>(null);
  menuRef.current = menu;
  const bubbleRef = useRef<Bubble | null>(null);
  bubbleRef.current = bubble;

  // ── presets ──
  const auto = useMemo<CameraPreset[]>(() => {
    const e = store.engine, g = geomRef.current;
    return e && g ? autoPresets(e, g, position) : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [position, geomVersion, icao]);
  useEffect(() => { if (icao) setUserPresets(loadUserPresets(icao, position)); }, [icao, position]);

  const flyPreset = useCallback((p: CameraPreset) => {
    const m = mapRef.current; if (!m) return;
    const dur = reducedRef.current ? 0 : CAMERA_MS;
    if (p.bounds) m.fitBounds(p.bounds, { padding: FIT_PADDING, duration: dur });
    else if (p.center) m.easeTo({ center: p.center, zoom: p.zoom ?? m.getZoom(), duration: dur });
    setActivePreset(p.id);
    if (groundUi.state.follow) groundUi.setFollow(false);
  }, []);
  const recallUser = useCallback((slot: number) => {
    const u = userPresets[slot]; const m = mapRef.current; if (!u || !m) return;
    m.easeTo({ center: u.center, zoom: u.zoom, duration: reducedRef.current ? 0 : CAMERA_MS });
    setActivePreset(`user-${slot + 1}`);
    if (groundUi.state.follow) groundUi.setFollow(false);
  }, [userPresets]);
  const saveUser = useCallback((slot: number) => {
    const m = mapRef.current; if (!m || !icao) return;
    const c = m.getCenter();
    setUserPresets(saveUserPreset(icao, position, slot, { center: [c.lng, c.lat], zoom: m.getZoom() }));
    store.pushToast({ kind: 'success', text: `Camera saved to slot ${slot + 1}`, detail: `Shift+${slot + 1} recalls it`, duration: 2500 });
  }, [icao, position]);

  // ── toolbar actions ──
  const zoom = useCallback((dir: 1 | -1) => {
    const m = mapRef.current; if (!m) return;
    const dur = reducedRef.current ? 0 : 180;
    if (dir > 0) m.zoomIn({ duration: dur }); else m.zoomOut({ duration: dur });
  }, []);
  const toggleFollow = useCallback(() => {
    const on = !groundUi.state.follow;
    if (on && store.selectedId == null) { store.pushToast({ kind: 'info', text: 'Select an aircraft to follow', duration: 2500 }); return; }
    groundUi.setFollow(on);
    if (on) store.pushToast({ kind: 'info', text: 'Following selected aircraft', detail: 'Drag the map to stop', duration: 2000 });
  }, []);
  const toggleRings = useCallback(() => store.updateSettings({ showRings: !store.settings.showRings }), []);
  const setTheme = useCallback((t: GroundTheme) => store.updateSettings({ groundTheme: t }), []);
  const toggleTheme = useCallback(() => setTheme(store.settings.groundTheme === 'chart' ? 'satellite' : 'chart'), [setTheme]);
  const toggleVehicles = useCallback(() => {
    const sh = shellRef.current;
    if (sh) { sh.toggle('vehicles'); return; }
    toggleVehiclesPanel();
    forceRender(v => v + 1);
  }, []);
  const [, forceRender] = useState(0);

  // ── keyboard: +/- zoom, Shift+n presets, Ctrl+Shift+n save, F follow (map focused), Esc closes floating chrome ──
  useEffect(() => {
    const editable = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      if (!el || typeof el.closest !== 'function') return false;
      if (el.isContentEditable) return true;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!el.closest('[data-hotkeys="off"],[role="slider"],[role="listbox"],[data-picker]');
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || editable(e.target)) return;
      const mapFocused = !!rootRef.current && (rootRef.current === document.activeElement || rootRef.current.contains(document.activeElement));
      if (e.key === 'Escape') {
        if (menu || bubble || groundUi.state.popover) { e.preventDefault(); closeFloating(); }
        return;
      }
      const digit = /^Digit([1-6])$/.exec(e.code);   // e.code: on a US layout Shift+1 reports key "!"
      if (digit && e.shiftKey) {
        const slot = Number(digit[1]) - 1;
        if (e.ctrlKey || e.metaKey) saveUser(slot); else recallUser(slot);
        e.preventDefault(); return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === '+' || e.key === '=') { zoom(1); e.preventDefault(); return; }
      if (e.key === '-' || e.key === '_') { zoom(-1); e.preventDefault(); return; }
      if ((e.key === 'f' || e.key === 'F') && mapFocused) { toggleFollow(); e.preventDefault(); return; }
      if (mapFocused && (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        const m = mapRef.current; if (!m) return;
        const dx = e.key === 'ArrowLeft' ? -0.1 : e.key === 'ArrowRight' ? 0.1 : 0;
        const dy = e.key === 'ArrowUp' ? -0.1 : e.key === 'ArrowDown' ? 0.1 : 0;
        m.panBy([dx * hostSize.w, dy * hostSize.h], { duration: reducedRef.current ? 0 : 180 });
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu, bubble, closeFloating, saveUser, recallUser, zoom, toggleFollow, hostSize]);

  // ── quick-menu model (built once per open; the rows are the tree's answer at that moment) ──
  const menuModel = useMemo(() => (menu ? buildMenu(menu, position) : null), [menu, position]);
  const onMenuSelect = useCallback((value: string) => {
    if (!menu) return;
    const m = mapRef.current;
    runMenuAction(menu, value, {
      centreHere: () => { if (m && store.engine) { const ll = m.unproject([menu.x, menu.y]); m.easeTo({ center: [ll.lng, ll.lat], duration: reducedRef.current ? 0 : CAMERA_MS }); } },
      savePreset: () => { const free = userPresets.findIndex(u => !u); saveUser(free >= 0 ? free : 0); },
      toggleTheme, toggleRings,
      follow: () => { store.select(typeof menu.id === 'number' ? menu.id : store.selectedId); groundUi.setFollow(true); },
    });
    setMenuSafe(null);
  }, [menu, userPresets, saveUser, toggleTheme, toggleRings, setMenuSafe]);

  const magVar = store.engine?.magVar ?? 0;

  return (
    <div ref={rootRef} className={styles.root} data-testid="ground-view" data-theme={theme} data-paused={paused ? 'true' : 'false'} data-position={position} data-map-floating={menu || bubble || popover ? '1' : undefined} tabIndex={0} aria-label="Airport map" onContextMenu={e => e.preventDefault()}>
      <div ref={mapDiv} className={styles.map} data-testid="ground-map" data-ready={readyRef.current ? 'true' : 'false'} />
      <canvas ref={canvasRef} className={styles.overlay} data-testid="ground-overlay" aria-hidden="true" />
      {theme === 'satellite' ? <div className={styles.veil} aria-hidden="true" /> : null}

      <LiveTooltip ref={tooltipRef} tip={tip} position={position} />

      <button ref={edgeRef} type="button" className={styles.edgeArrow} data-open="false" data-testid="map-edge-arrow" aria-label="Pan to selected aircraft" onClick={() => { if (store.selectedId != null) store.centerOn(store.selectedId); }}>
        <span ref={edgeIconRef} className={styles.edgeIcon} aria-hidden="true"><Icon name="arrow-right" size={14} /></span>
      </button>

      {menu && menuModel ? (
        <QuickMenu at={menu} title={menuModel.title} options={menuModel.options} host={hostSize} onSelect={onMenuSelect} onClose={() => setMenuSafe(null)} />
      ) : null}

      {bubble ? (
        <HeadingBubble
          x={bubble.x} y={bubble.y} hdgMag={bubble.hdgTrue - magVar} dir={bubble.dir} host={hostSize}
          onDir={d => setBubble(b => (b ? { ...b, dir: d } : b))}
          onSend={() => sendHeading(bubble.id, bubble.hdgTrue, bubble.dir)}
          onCancel={() => setBubble(null)}
        />
      ) : null}

      {popover === 'layers' ? (
        <LayersPopover position={position} theme={theme} layers={layers} onLayer={(k, v) => groundUi.setLayer(k, v)} onTheme={setTheme} onClose={() => groundUi.closePopover()} />
      ) : null}
      {popover === 'presets' ? (
        <PresetsPopover auto={auto} user={userPresets} activeId={activePreset} onRecall={flyPreset} onRecallUser={recallUser} onSaveUser={saveUser} onClose={() => groundUi.closePopover()} />
      ) : null}

      <Toolbar
        position={position} theme={theme} follow={follow} hasSelection={selectedId != null} rings={rings} popover={popover} vehiclesOpen={vehiclesOpen}
        onZoom={zoom} onFollow={toggleFollow} onRings={toggleRings} onTheme={toggleTheme}
        onPopover={p => { setMenuSafe(null); groundUi.togglePopover(p); }} onVehicles={toggleVehicles}
      />
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
//  Tooltip that follows the store while open (subscribes only when mounted)
// ──────────────────────────────────────────────────────────────────────────────
const LiveTooltip = React.forwardRef<HTMLDivElement, { tip: TipTarget; position: PlayerPosition }>(function LiveTooltip({ tip, position }, ref) {
  return tip ? <LiveTooltipInner ref={ref} tip={tip} position={position} /> : <HoverTooltip ref={ref} model={null} />;
});
const LiveTooltipInner = React.forwardRef<HTMLDivElement, { tip: NonNullable<TipTarget>; position: PlayerPosition }>(function LiveTooltipInner({ tip, position }, ref) {
  const version = useSimVersion();
  const model = useMemo<TipModel | null>(() => {
    const e = store.engine; if (!e) return null;
    if (tip.kind === 'aircraft') { const a = e.byId(tip.id); return a ? aircraftTip(e, a, position) : null; }
    const v = e.fleet.byId(tip.id); return v ? vehicleTip(e, v) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tip, position, version]);
  return <HoverTooltip ref={ref} model={model} />;
});

// ──────────────────────────────────────────────────────────────────────────────
//  Quick-menu content (UX 04 §4 right-click rows; §6 quick dispatch)
// ──────────────────────────────────────────────────────────────────────────────
const MENU_MAX_ACTIONS = 6;

function buildMenu(at: QuickMenuAt, position: PlayerPosition): { title: string; options: MenuOption[] } | null {
  const e = store.engine; if (!e) return null;
  switch (at.kind) {
    case 'aircraft': {
      const a = typeof at.id === 'number' ? e.byId(at.id) : undefined; if (!a) return null;
      const rows = store.actionsFor(a).filter(r => r.state === 'enabled').sort((x, y) => (y.primary ? 1 : 0) - (x.primary ? 1 : 0) || x.order - y.order).slice(0, MENU_MAX_ACTIONS);
      const options: MenuOption[] = rows.map(r => ({ value: r.id, label: r.label, right: r.hotkey ? <span className="tabular">{r.hotkey}</span> : undefined, testId: `ctx-aircraft-${r.id.replace(/^action-|^emerg-/, '')}` }));
      options.push({ value: 'more', label: 'More…', divider: options.length > 0, testId: 'ctx-aircraft-more' });
      options.push({ value: 'follow', label: 'Follow on map', testId: 'ctx-aircraft-follow' });
      return { title: a.callsign, options };
    }
    case 'vehicle': {
      const v = typeof at.id === 'string' ? e.fleet.byId(at.id) : undefined; if (!v) return null;
      const options: MenuOption[] = [];
      if (v.state !== 'standby') options.push({ value: 'recall', label: 'Recall to station', testId: 'ctx-vehicle-recall' });
      if (v.holdShortRunway) options.push({ value: 'cross', label: `Cross runway ${v.holdShortRunway}`, testId: 'ctx-vehicle-cross' });
      options.push({ value: 'select', label: 'Select vehicle', testId: 'ctx-vehicle-select' });
      return { title: v.callsign, options };
    }
    case 'runway': {
      const name = String(at.id);
      const rs = e.runwayState(name);
      const options: MenuOption[] = [
        { value: 'inspect', label: 'Inspect runway', description: 'ops vehicle', disabled: rs?.status === 'inspection', testId: 'ctx-runway-inspect' },
        { value: 'arff', label: 'Send ARFF', description: 'full response', testId: 'ctx-runway-arff' },
      ];
      if (rs?.status === 'open') options.push({ value: 'close', label: 'Close runway', divider: true, testId: 'ctx-runway-close' });
      else options.push({ value: 'open', label: 'Reopen runway', divider: true, testId: 'ctx-runway-open' });
      return { title: `Runway ${name}`, options };
    }
    case 'stand': {
      const ref = String(at.id);
      const occ = e.standOccupant(ref);
      return {
        title: `Stand ${ref}`,
        options: [
          { value: 'ambulance', label: 'Ambulance to stand', description: occ ?? undefined, testId: 'ctx-stand-ambulance' },
          { value: 'followme', label: 'Follow-me from stand', testId: 'ctx-stand-followme' },
        ],
      };
    }
    default: {
      const options: MenuOption[] = [
        { value: 'centre', label: 'Centre here', testId: 'ctx-map-centre' },
        { value: 'save-preset', label: 'Save camera preset', testId: 'ctx-map-save-preset' },
        { value: 'theme', label: store.settings.groundTheme === 'chart' ? 'Satellite theme' : 'Chart theme', divider: true, testId: 'ctx-map-theme' },
        { value: 'rings', label: store.settings.showRings ? 'Hide range rings' : 'Show range rings', testId: 'ctx-map-rings' },
      ];
      if (position !== 'approach') options.push({ value: 'layers', label: 'Layers…', testId: 'ctx-map-layers' });
      return { title: 'Map', options };
    }
  }
}

function runMenuAction(at: QuickMenuAt, value: string, h: { centreHere: () => void; savePreset: () => void; toggleTheme: () => void; toggleRings: () => void; follow: () => void }): void {
  const e = store.engine; if (!e) return;
  switch (at.kind) {
    case 'aircraft': {
      if (typeof at.id !== 'number') return;
      if (value === 'more') { store.select(at.id); requestOpenAction({ aircraftId: at.id, actionId: null }); return; }
      if (value === 'follow') { h.follow(); return; }
      store.select(at.id);
      requestOpenAction({ aircraftId: at.id, actionId: value as Parameters<typeof requestOpenAction>[0]['actionId'] });
      return;
    }
    case 'vehicle': {
      const id = String(at.id);
      if (value === 'recall') store.recallVehicle(id);
      else if (value === 'cross') { const v = e.fleet.byId(id); if (v?.holdShortRunway) e.vehicleOp(id, 'cross', v.holdShortRunway); store.flush(); }
      else groundUi.selectVehicle(id);
      return;
    }
    case 'runway': {
      const name = String(at.id);
      if (value === 'inspect') { store.setRunwayStatus(name, 'inspection', 'controller'); store.dispatchVehicle('ops', { kind: 'runway', runway: name }); }
      else if (value === 'arff') store.dispatchVehicle('arff', { kind: 'runway', runway: name });
      else if (value === 'close') store.setRunwayStatus(name, 'closed', 'controller');
      else if (value === 'open') store.setRunwayStatus(name, 'open', 'controller');
      return;
    }
    case 'stand': {
      const ref = String(at.id);
      if (value === 'ambulance') store.dispatchVehicle('ambulance', { kind: 'stand', ref });
      else if (value === 'followme') store.dispatchVehicle('followme', { kind: 'stand', ref });
      return;
    }
    default: {
      if (value === 'centre') h.centreHere();
      else if (value === 'save-preset') h.savePreset();
      else if (value === 'theme') h.toggleTheme();
      else if (value === 'rings') h.toggleRings();
      else if (value === 'layers') groundUi.togglePopover('layers');
    }
  }
}

