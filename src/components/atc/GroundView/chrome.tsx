'use client';
// ============================================================
//  DOM chrome over the ground map: toolbar (4.16 / UX §2.1), layers + presets
//  popovers, right-click quick menu, drag-to-heading confirm bubble, hover
//  tooltip. Everything is built from design primitives + the CSS module;
//  no colour literals. Every interactive element carries a data-testid.
// ============================================================
import React, { useEffect, useRef } from 'react';
import { IconButton, Icon, Tooltip, Kbd, Menu, Toggle, Button, cx } from '@/design';
import type { MenuOption } from '@/design';
import styles from './GroundView.module.css';
import type { GroundLayers, GroundTheme, PlayerPosition, QuickMenuAt } from './bridge';
import type { CameraPreset, UserPreset } from './presets';
import type { TipModel } from './tooltip';

// ──────────────────────────────────────────────────────────────────────────────
//  Toolbar
// ──────────────────────────────────────────────────────────────────────────────
export interface ToolbarProps {
  position: PlayerPosition;
  theme: GroundTheme;
  follow: boolean;
  hasSelection: boolean;
  rings: boolean;
  popover: 'layers' | 'presets' | null;
  vehiclesOpen: boolean;
  onZoom: (dir: 1 | -1) => void;
  onFollow: () => void;
  onRings: () => void;
  onTheme: () => void;
  onPopover: (p: 'layers' | 'presets') => void;
  onVehicles: () => void;
}

export function Toolbar(p: ToolbarProps) {
  return (
    <div className={styles.toolbar} data-testid="map-toolbar" role="toolbar" aria-label="Map tools">
      <div className={styles.toolbarGroup}>
        <Tip label="Zoom in" kbd={['+']}><IconButton size={44} variant="map" label="Zoom in" icon={<Icon name="plus" />} onClick={() => p.onZoom(1)} testId="map-tool-zoom-in" /></Tip>
        <Tip label="Zoom out" kbd={['-']}><IconButton size={44} variant="map" label="Zoom out" icon={<Icon name="minus" />} onClick={() => p.onZoom(-1)} testId="map-tool-zoom-out" /></Tip>
      </div>
      <div className={styles.toolbarGap} />
      <div className={styles.toolbarGroup}>
        <Tip label={p.follow ? 'Follow off' : 'Follow selected'} kbd={['F']}>
          <IconButton size={44} variant="map" label={p.follow ? 'Follow off' : 'Follow selected aircraft'} icon={<Icon name="locate-fixed" />} active={p.follow} accentIcon={p.follow} disabled={!p.hasSelection && !p.follow} onClick={p.onFollow} testId="map-tool-follow" data-state={p.follow ? 'on' : 'off'} />
        </Tip>
        <Tip label={p.position === 'tower' ? 'Range rings (1 / 2 / 4 NM)' : 'Range rings (250 / 500 m)'}>
          <IconButton size={44} variant="map" label="Range rings" icon={<Icon name="circle" />} active={p.rings} onClick={p.onRings} testId="map-tool-rings" data-state={p.rings ? 'on' : 'off'} />
        </Tip>
        <Tip label={p.theme === 'satellite' ? 'Chart theme' : 'Satellite theme'}>
          <IconButton size={44} variant="map" label={p.theme === 'satellite' ? 'Switch to chart' : 'Switch to satellite'} icon={<Icon name="map" />} active={p.theme === 'chart'} onClick={p.onTheme} testId="map-tool-theme" data-state={p.theme} />
        </Tip>
        <Tip label="Layers"><IconButton size={44} variant="map" label="Layers" icon={<Icon name="layers" />} active={p.popover === 'layers'} onClick={() => p.onPopover('layers')} testId="map-tool-layers" aria-haspopup="dialog" aria-expanded={p.popover === 'layers'} /></Tip>
        <Tip label="Camera presets" kbd={['Shift', '1-6']}><IconButton size={44} variant="map" label="Camera presets" icon={<Icon name="compass" />} active={p.popover === 'presets'} onClick={() => p.onPopover('presets')} testId="map-tool-presets" aria-haspopup="dialog" aria-expanded={p.popover === 'presets'} /></Tip>
      </div>
      {p.position !== 'approach' ? (
        <>
          <div className={styles.toolbarGap} />
          <Tip label="Vehicles panel" kbd={['F10']}>
            <IconButton size={44} variant="map" label="Vehicles panel" icon={<Icon name="siren" />} active={p.vehiclesOpen} onClick={p.onVehicles} testId="map-tool-vehicles" data-state={p.vehiclesOpen ? 'on' : 'off'} />
          </Tip>
        </>
      ) : null}
    </div>
  );
}

function Tip({ label, kbd, children }: { label: string; kbd?: string[]; children: React.ReactElement }) {
  return <Tooltip content={label} kbd={kbd} placement="left">{children}</Tooltip>;
}

// ──────────────────────────────────────────────────────────────────────────────
//  Layers popover
// ──────────────────────────────────────────────────────────────────────────────
const LAYER_ROWS: Array<{ k: keyof GroundLayers; label: string; testId: string; positions?: PlayerPosition[] }> = [
  { k: 'taxiwayLabels', label: 'Taxiway labels', testId: 'layer-labels-taxiway' },
  { k: 'standLabels', label: 'Stand numbers', testId: 'layer-labels-stand' },
  { k: 'holdBars', label: 'Hold-short bars', testId: 'layer-holdbars' },
  { k: 'vehicles', label: 'Vehicles at station', testId: 'layer-vehicles' },
  { k: 'trails', label: 'Trails', testId: 'layer-trails' },
  { k: 'corridor', label: 'Final corridors', testId: 'layer-corridor', positions: ['tower'] },
];

export interface LayersPopoverProps {
  position: PlayerPosition;
  theme: GroundTheme;
  layers: GroundLayers;
  onLayer: (k: keyof GroundLayers, v: boolean) => void;
  onTheme: (t: GroundTheme) => void;
  onClose: () => void;
}

export function LayersPopover(p: LayersPopoverProps) {
  return (
    <div className={cx('glass', 'glass-strong', styles.popover)} role="dialog" aria-label="Map layers" data-testid="map-layers-popover" onPointerDown={e => e.stopPropagation()}>
      <div className={styles.popTitle}><span>Base map</span><IconButton size={32} variant="ghost" label="Close" icon={<Icon name="x" />} onClick={p.onClose} testId="map-layers-close" /></div>
      <button type="button" className={styles.presetBtn} aria-pressed={p.theme === 'satellite'} onClick={() => p.onTheme('satellite')} data-testid="layer-satellite">Satellite{p.theme === 'satellite' ? <Icon name="check" size={16} /> : null}</button>
      <button type="button" className={styles.presetBtn} aria-pressed={p.theme === 'chart'} onClick={() => p.onTheme('chart')} data-testid="layer-chart">Chart{p.theme === 'chart' ? <Icon name="check" size={16} /> : null}</button>
      <div className={styles.popSection}>
        <div className={styles.popTitle}><span>Overlays</span></div>
        {LAYER_ROWS.filter(r => !r.positions || r.positions.includes(p.position)).map(r => (
          <div key={r.k} className={styles.popRow}>
            <Toggle checked={p.layers[r.k]} onChange={v => p.onLayer(r.k, v)} label={r.label} labelPosition="left" testId={r.testId} />
          </div>
        ))}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
//  Presets popover
// ──────────────────────────────────────────────────────────────────────────────
export interface PresetsPopoverProps {
  auto: CameraPreset[];
  user: Array<UserPreset | null>;
  activeId: string | null;
  onRecall: (preset: CameraPreset) => void;
  onRecallUser: (slot: number) => void;
  onSaveUser: (slot: number) => void;
  onClose: () => void;
}

export function PresetsPopover(p: PresetsPopoverProps) {
  return (
    <div className={cx('glass', 'glass-strong', styles.popover)} role="dialog" aria-label="Camera presets" data-testid="map-presets-popover" onPointerDown={e => e.stopPropagation()}>
      <div className={styles.popTitle}><span>Camera</span><IconButton size={32} variant="ghost" label="Close" icon={<Icon name="x" />} onClick={p.onClose} testId="map-presets-close" /></div>
      {p.auto.map(a => (
        <button key={a.id} type="button" className={styles.presetBtn} aria-pressed={p.activeId === a.id} onClick={() => p.onRecall(a)} data-testid={`preset-auto-${a.id}`}>
          <span>{a.label}</span>
          {a.bounds ? <span className={styles.presetHint}>fit</span> : <span className={styles.presetHint}>z{a.zoom?.toFixed(0)}</span>}
        </button>
      ))}
      <div className={styles.popSection}>
        <div className={styles.popTitle}><span>Slots</span><Kbd plain keys={['Shift', 'n']} /></div>
        <div className={styles.slots}>
          {p.user.map((u, i) => (
            <div key={i} className={styles.slot}>
              <button type="button" className={styles.slotBtn} data-filled={u ? 'true' : 'false'} disabled={!u} onClick={() => p.onRecallUser(i)} data-testid={`preset-user-${i + 1}`} title={u ? `Recall slot ${i + 1} (Shift+${i + 1})` : `Slot ${i + 1} empty`}>{i + 1}</button>
              <button type="button" className={styles.slotSave} onClick={() => p.onSaveUser(i)} data-testid={`preset-save-${i + 1}`} title={`Save current camera to slot ${i + 1} (Ctrl+Shift+${i + 1})`}>save</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
//  Quick menu (right-click)
// ──────────────────────────────────────────────────────────────────────────────
export interface QuickMenuProps {
  at: QuickMenuAt;
  title: string;
  options: MenuOption[];
  /** Host size (to keep the menu inside the map). */
  host: { w: number; h: number };
  onSelect: (value: string) => void;
  onClose: () => void;
}

export function QuickMenu({ at, title, options, host, onSelect, onClose }: QuickMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = React.useState(-1);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActive(i => { const n = options.length; if (!n) return -1; return e.key === 'ArrowDown' ? (i + 1) % n : (i - 1 + n) % n; });
        return;
      }
      if (e.key === 'Enter' && active >= 0 && options[active] && !options[active].disabled) { e.preventDefault(); onSelect(options[active].value); }
    };
    const onDown = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('pointerdown', onDown, true); };
  }, [options, active, onSelect, onClose]);
  // keep inside the map: flip left / up near the edges
  const W = 240, H = 44 + options.length * 36 + 12;
  const left = at.x + W + 8 > host.w ? Math.max(4, at.x - W) : at.x;
  const top = at.y + H + 8 > host.h ? Math.max(4, at.y - H) : at.y;
  return (
    <div ref={ref} className={styles.menuHost} style={{ left, top }} data-testid={`map-context-${at.kind}`} onContextMenu={e => e.preventDefault()}>
      <Menu options={options} activeIndex={active} onActiveChange={setActive} onSelect={v => onSelect(v)} placement="static" testId="map-context-menu" />
      <span className="sr-only">{title}</span>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
//  Drag-to-heading confirm bubble
// ──────────────────────────────────────────────────────────────────────────────
export interface HeadingBubbleProps {
  x: number; y: number;
  /** Magnetic heading (display). */
  hdgMag: number;
  dir: 'L' | 'R' | null;
  host: { w: number; h: number };
  onDir: (d: 'L' | 'R' | null) => void;
  onSend: () => void;
  onCancel: () => void;
}

export function HeadingBubble({ x, y, hdgMag, dir, host, onDir, onSend, onCancel }: HeadingBubbleProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); onSend(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); }
      else if (e.key === 'l' || e.key === 'L') { e.preventDefault(); onDir(dir === 'L' ? null : 'L'); }
      else if (e.key === 'r' || e.key === 'R') { e.preventDefault(); onDir(dir === 'R' ? null : 'R'); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [dir, onDir, onSend, onCancel]);
  const W = 300;
  const left = Math.min(Math.max(8, x + 14), host.w - W - 8);
  const top = Math.min(Math.max(8, y - 20), host.h - 56);
  const hdg = String(((Math.round(hdgMag) % 360) + 360) % 360 || 360).padStart(3, '0');
  return (
    <div className={cx('glass', 'glass-strong', styles.bubble)} style={{ left, top }} data-testid="map-hdg-bubble" role="dialog" aria-label={`Fly heading ${hdg}`} onPointerDown={e => e.stopPropagation()}>
      <span className={styles.bubbleText}>{dir ? `Turn ${dir === 'L' ? 'left' : 'right'} heading ` : 'Fly heading '}<b>{hdg}</b></span>
      <button type="button" className={styles.bubbleDir} aria-pressed={dir === 'L'} onClick={() => onDir(dir === 'L' ? null : 'L')} data-testid="map-hdg-bubble-left" title="Turn left (L)">L</button>
      <button type="button" className={styles.bubbleDir} aria-pressed={dir === 'R'} onClick={() => onDir(dir === 'R' ? null : 'R')} data-testid="map-hdg-bubble-right" title="Turn right (R)">R</button>
      <Button variant="accent" size="sm" onClick={onSend} testId="map-hdg-bubble-send" iconRight={<Icon name="corner-down-left" size={14} />}>Send</Button>
      <IconButton size={32} variant="ghost" label="Cancel" icon={<Icon name="x" />} onClick={onCancel} testId="map-hdg-bubble-cancel" />
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
//  Hover tooltip — positioned by the RAF loop through the forwarded ref.
// ──────────────────────────────────────────────────────────────────────────────
export const HoverTooltip = React.forwardRef<HTMLDivElement, { model: TipModel | null }>(function HoverTooltip({ model }, ref) {
  return (
    <div ref={ref} className={cx('glass', 'glass-strong', styles.tooltip)} data-open={model ? 'true' : 'false'} data-testid="map-tooltip" role="tooltip" aria-hidden={!model}>
      {model ? (
        <>
          <div className={styles.tipHead}>
            <span className={styles.tipTitle}>{model.title}</span>
            <span className={styles.tipStage} data-tone={model.stageTone}>{model.stage}</span>
          </div>
          <div className={styles.tipSub}>{model.subtitle}</div>
          {model.rows.length ? (
            <div className={styles.tipRows}>
              {model.rows.map((r, i) => (
                <React.Fragment key={i}>
                  <span className={styles.tipLabel}>{r.label}</span>
                  <span className={styles.tipValue} data-tone={r.tone}>{r.value}</span>
                </React.Fragment>
              ))}
            </div>
          ) : null}
          {model.note ? <div className={styles.tipNote} data-tone={model.noteTone ?? undefined}>{model.note}</div> : null}
        </>
      ) : null}
    </div>
  );
});
