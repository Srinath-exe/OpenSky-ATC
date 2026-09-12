# SKYCONTROL design system (`src/design`)

The only styling source for `src/game` and `src/app` (00-MASTER-PLAN §2.1). Implements `docs/spec/01-DESIGN-SYSTEM.md` 1:1
(base + critic addendum; A1 resolutions win). No Tailwind, no inline colour literals: CSS Modules + the tokens below.

```ts
import { GlassPanel, Button, Kpi, Icon, useToast, formatAltitude } from '@/design'
```

Files

| File | Role |
|---|---|
| `tokens.css` | every `--token` (colours, glass, text tiers, orange scale, status, chart neutrals, map tint, type scale, spacing, radii, icon sizes, pill scale, layout, z-index, motion, shadows, focus) + A5 breakpoint overrides |
| `type.css` | `.display-xl .display-l .display-m .title-l .title-m .body-m .body-s .label-xs .micro-caps`, `.text-1..5`, `.tnum .pnum .prose .ellipsis .nowrap` |
| `motion.css` | global keyframes `ds-*` and `.ds-enter` (staggered card enter); reduced-motion rules |
| `map.css` | `.map-satellite .map-veil .map-puck .map-ring .map-datablock .map-route .map-pin .map-marker .map-controls` (section 5 / A10 overlays) |
| `icons.tsx` | `<Icon name size />` wrapper (stroke 1.5 absolute), `Icon*` named exports, custom glyphs, `LogoMark` |
| `utils.ts` | `cx`, `useControllable`, `usePrefersReducedMotion`, `useCountUp`, `mergeRefs`, `useStableId`, `clamp`, `wrapHeading`, A9 formatters (`formatAltitude`, `formatHeading`, `formatSpeed`, `formatDistanceNm`, `formatPercent`, `formatSigned`, `formatTimeZ`, `formatTimestamp`, `formatRelative`, `formatThousands`, `splitNumber`) |
| `primitives/<Name>/<Name>.tsx + .module.css` | one folder per component |
| `index.ts` | barrel |
| `src/app/globals.css` | imports the four css files; reset, DM Sans fallback face, focus ring, scrollbar, selection, `.glass*`, `.scroll-region`, `.tabular`, `.sr-only` |
| `src/app/design/page.tsx` | `/design` showcase: every primitive in every state (visual QA) |

Fonts: `src/app/layout.tsx` loads DM Sans (variable, opsz axis) via `next/font/google` into `--font-dm-sans`; `--font` resolves to it with the A18 metric fallback.

## Conventions shared by every primitive

- `testId?: string` renders `data-testid` on the root interactive element; sub-elements get `${testId}-<part>` (documented per component).
- All interactive components implement the A2 states (rest / hover / pressed / focus-visible / selected / disabled / loading) and keyboard access. `forceState?: 'hover' | 'pressed' | 'focus'` is a **dev-only** prop (Button, IconButton, Pill, ListRow, GlassPanel, Toggle, Input) that renders a state statically for screenshots; never use it in game UI.
- Focus is keyboard-only (`:focus-visible`) and always the white ring `--focus-ring` (never orange).
- Icons: pass elements from `icons.tsx`; the primitives size them per A3 when you omit `size`.
- Numbers: use `tabular` for timers, timestamps, squawks, deltas, axis labels; display KPIs stay proportional.
- Everything is dark-only; there is no light theme.

## Tokens (all on `:root`, literal px)

Neutral ground `--bg-0 #0b0b0c` (shell) · `--bg-1 #121212` (solid cards) · `--bg-1-hover #151515` · `--bg-2 #1c1c1e` (tiles, chips, count pills) · `--bg-3 #252628` (active pill, hover surface) · `--bg-4 #3a3b3c` (raised controls) · `--line` .06 · `--line-strong` .12 · `--chip-on-glass` .14 · `--chip-on-glass-strong` .18.
White alpha ramp `--w-02 … --w-85` (`--w-04 --w-06 --w-08 --w-10 --w-12 --w-14 --w-16 --w-18 --w-20 --w-22 --w-25 --w-28 --w-30 --w-35 --w-40 --w-45 --w-55 --w-70 --w-80 --w-85`).

Glass `--glass-fill` rgba(40,40,42,.5) · `--glass-fill-strong` rgba(24,24,26,.72) · `--glass-fill-fallback` · `--glass-border` .10 · `--glass-border-hover` .16 · `--glass-border-lit` .18 · `--glass-highlight` .14 · `--glass-blur` 40px · `--glass-saturate` 1.15 · `--glass-shadow` · `--glass-lit-gradient` · `--glass-lit-gradient-60` · `--glass-prism` · `--glass-btn` .06 / `-hover` .12 / `-pressed` .16 · `--glass-map-btn` .10 / `-hover` .16 / `-pressed` .22 · `--puck-fill` .28 · `--puck-ring` .35 · `--puck-blur` 12px.

Text `--text-1 #fff` · `--text-2 #c8c8c8` · `--text-3 #868686` (`--text-3-on-glass #a9a9a9`, applied automatically inside `.glass`) · `--text-4 #606060` (trailing digits only) · `--text-5 #444446` (far ticks, disabled).

Orange `--orange #f5933f` · `--orange-deep #ea7226` · `--orange-text` · tints `--orange-tint-03/04/08/15/16/20/24/30/35` · `--orange-40/60/90` · `--orange-border` .35 · `--orange-glow` (+ `-50`, `-30`).
Status `--red #fb0a08` · `--red-tint` .10 (`-08 -12 -16 -24`) · `--red-border` .35 (`-25 -45 -55 -70`) · `--red-40 --red-85` · `--red-glow` · `--red-glow-core #ff3a3a` · `--red-glow-ring #501519` · `--green #57cd50` · `--green-dim` · `--blue-marker #0a609b` · `--pink-marker #b5647a` · `--lime-marker #8e9716` (`--lime-50`, `--lime-feather`).
Chart `--chart-grey-bar` .55 · `--chart-line-muted` .30 · `--chart-line-hi #fff` · `--chart-grid` .12 · `--chart-grid-faint` .04 · `--chart-target` .85 · `--chart-band` .04 · `--chart-area` .03 · `--tick` .45 · `--tick-major` .20 · `--tick-lit` .70.
Map `--map-water(-2) --map-veg(-2) --map-rock(-2) --map-veil --map-veil-lost --map-vignette --map-filter` · chart theme `--chart-ground --chart-block(-2) --chart-street --chart-road --chart-water` · ground chart `--gnd-runway --gnd-runway-edge --gnd-taxiway --gnd-apron --gnd-terminal` · `--route-shadow` · `--data-block` rgba(37,38,40,.8) · `--tag-bg` · `--wire` .85 · `--wire-dim` .55 · `--rule-left` .80 · station pins `--map-pin-fill --map-pin-glyph --map-pin-muted-fill --map-pin-muted-glyph`.
Derived `--btn-primary-hover #e8e8e8` · `--btn-primary-pressed #d4d4d4` (A2 primary button) · `--bg-4-hover #444546` (raised control hover) · `--mask-solid` (opaque stop for `mask-image` gradients). No hex literal may appear outside `tokens.css`; white is always `var(--text-1)` and SVG glyphs use `currentColor`.

Type `--font` · `--fw-light 300 --fw-regular 400 --fw-medium 500` · per token `--fs-X --lh-X --ls-X --fw-X` for X in `display-xl 44 · display-l 36 · display-m 28 · title-l 20 · title-m 16 · body-m 14 · body-s 13 · label-xs 11 · micro-caps 10` (tablet ×1.125, mobile ×1.25 via media queries) · `--lh-multiline 1.5` · `--max-line 60ch`.

Spacing `--s-1 4 --s-2 8 --s-3 12 --s-4 16 --s-5 20 --s-6 24 --s-7 28 --s-8 32 --s-10 40` · `--card-pad 20` · `--card-pad-lg 24` · `--tile-pad 16` · `--card-gap 12` · `--pill-gap 8` · `--nav-tab-gap 32` · `--icon-label-gap 8` · `--group-icon-gap 10` · `--gutter 20` (16 below 1440) · `--title-to-kpi 24 --kpi-to-tabs 24 --tabs-to-chart 28 --chart-to-axis 12`.
Shape `--r-card 20` (24 on tablet/mobile) · `--r-card-lg 24` · `--r-inner 14` · `--r-menu 14` · `--r-row 12` · `--r-chip 10` · `--r-menu-item 10` · `--r-skeleton 8` · `--r-kbd 2` · `--r-pill 999` · `--bw 1px`.
Icons/strokes `--icon-xs 12 --icon-s 16 --icon-m 20 --icon-l 24 --icon-14 --icon-18 --icon-22` · `--stroke-icon 1.5 --stroke-chart 1.5 --stroke-bar 2 --stroke-route 3 --stroke-wire 1`.
Pill scale (A3) `--pill-xs 24 / --pill-xs-px 10 / -icon 12 / -gap 4` · `--pill-s 30/14/14/6` · `--pill-m 36/16/16/8` · `--pill-l 40/18/18/8` · `--pill-xl 44/20/18/8` · circles `--circle-xs 32 --circle-nav 40 --circle-map 44 --circle-mobile 56` (+ `-icon`) · `--badge-s 18 --badge-m 22` · `--toggle-w 40 --toggle-h 22 --toggle-knob 18` · `--input-h 40` · `--row-h 44` · `--menu-item-h 36` · `--hit-min 44` · `--plate-circle 28 / -l 36` · `--plate-pill-w 72 / -l 96`.
Layout `--nav-h 64` (56 <1440) · `--left-col 440/380/360` · `--panel-w 400/340` · `--panel-top 84` · `--bottom-row-h 250` · `--strip-w 194 --strip-h 176 --strip-selected-w 400 --strip-selected-h 440` · `--tile-w 200 --tile-h 104` · `--modal-w 440` · `--toast-min-w 280 --toast-max-w 420` · `--menu-max-w 320 --menu-max-h 320` · `--search-w 320 --search-w-focus 400` · `--bp-mobile 767 --bp-tablet 1023 --bp-laptop 1439 --min-width 360`.
Z `--z-map 0 --z-map-overlay 1 --z-float 10 --z-nav 20 --z-menu 30 --z-sheet 35 --z-modal 40 --z-toast 50`.
Motion `--ease-out cubic-bezier(.2,.8,.2,1)` · `--ease-inout cubic-bezier(.65,0,.35,1)` · `--t-fast 120 --t-lift 160 --t-base 200 --t-bump 240 --t-slow 320 --t-bars 400 --t-draw 600 --t-count 600 --t-pan 600 --t-fix 1000 --t-pulse 1200 --t-shimmer 1400 --t-marker 1600` · `--stagger 40 --stagger-bar 30`.
Shadows `--shadow-glass --shadow-menu --shadow-toast --shadow-modal --shadow-thumb --shadow-puck --shadow-tooltip`.
Focus/misc `--focus-ring` · `--focus-ring-inset` · `--focus-underline` · `--selection` · `--caret` · `--scrim` · `--scrim-blur` · `--scrim-loading` · `--skeleton` · `--skeleton-shimmer` · `--scrollbar-thumb` · `--scrollbar-w` · `--fade-mask` · `--grab-handle`.

Global keyframes (motion.css, reference from modules as `global(ds-x)`): `ds-enter ds-fade-in ds-fade-out ds-pop ds-rise ds-drop ds-scale-in ds-spin ds-shimmer ds-shake ds-badge-ring ds-pulse-opacity ds-marker-halo ds-bump ds-crawl ds-crawl-8 ds-dot-pop ds-bar-grow ds-flash-fill`.

## Icons

`<Icon name="bell" size={20} />` - `name` is an `IconName` from the A6 map (`arrow-up-right chevron-up chevron-down chevron-left chevron-right x search radio-tower headphones bell settings-2 house circle-check triangle-alert git-compare-arrows plane-landing plane-takeoff siren wind sparkles clock plus minus locate-fixed map plane navigation volume-2 volume-x pause play arrow-up arrow-down arrow-left arrow-right rotate-ccw rotate-cw corner-down-left undo-2 mouse-pointer-click terminal check info circle-alert wifi radio gauge layers eye eye-off circle square zap timer thermometer cloud-fog droplets map-pin move crosshair compass copy trash-2 filter list-filter menu more-horizontal loader help-circle external-link users building-2 route fuel snowflake ambulance`). Named exports with the spec default size: `IconArrowUpRight(18) IconChevronUp/Down/Left/Right(16) IconX(16) IconSearch(20) IconRadioTower(20) IconHeadphones(20) IconBell(20) IconSettings(20) IconHouse(20) IconCircleCheck(20) IconTriangleAlert(20) IconSeparation(18) IconPlaneLanding(18) IconPlaneTakeoff(16) IconSiren(18) IconWind(18) IconSparkles(18) IconClock(14) IconPlus/Minus(18) IconLocate(18) IconMap(18) IconPlane(18) IconNavigation(22) IconVolumeOn/Off(20) IconPause/Play(16) IconArrowUp/Down(14) IconArrowLeft(22) IconArrowRight(16) IconRotateCcw/Cw(14) IconSend(16) IconGoAround(16) IconPointerClick(24) IconTerminal(16) IconCheck(16) IconInfo(18) IconCircleAlert(18) IconWifi(16) IconRadio(16)`. Props are Lucide's (`size`, `className`, `style`, `aria-label`, `strokeWidth` override).

Custom glyphs (24 viewBox, 1.5px non-scaling stroke): `AircraftTop FireTruck FollowMeCar Tug Ambulance Fuel Deice Windsock` - props `size`, `rotate` (deg), `title`, `testId`, SVG attrs. `VEHICLE_GLYPHS` maps `aircraft | arff | follow-me | tug | ambulance | fuel | deice | windsock` to them. `LogoMark({ size=28, opacity })`.

## Components

Props marked `…HTML` mean the component spreads remaining native attributes (`className`, `style`, `aria-*`, `onClick`, `data-*`).

### GlassPanel (4.1, 1.2, A1-3/4/9, A11.10)
`variant` `'glass' | 'glass-strong' | 'solid' | 'lit' | 'prism' | 'nested'` (glass over map, solid `--bg-1` on the shell, nested `--bg-2` inside a panel) · `title` · `titleSize 'm' | 'l'` · `parenthetical` ("(2 lines)") · `subtitle` (body-s text-3, tabular) · `header` (replaces the title block) · `headerRight` · `affordance 'open' | 'collapse' | 'none'` (+ `affordanceLabel`, `onAffordance`, `collapsed`) · `hasDisplayNumber` (title becomes text-2) · `interactive` (hover lift; with `onClick` it is a focusable button) · `selected` · `disabled` · `error` + `onRetry` (error card body) · `padding 'card' | 'card-lg' | 'tile' | 'none'` · `radius 'card' | 'card-lg' | 'inner'` · `enter` (section 7 enter animation) · `headerGap` (24px title→KPI; default 12) · `as` · `testId` (`-open`, `-collapse`) · …HTML div. Body renders `children`; collapsed hides the body.

### Button (4.18, A2, A3)
`variant` `'primary'` (white pill, rare) `| 'accent'` (orange, the single main action) `| 'secondary'` (glass .08) `| 'ghost' | 'danger'` · `size 'sm' 30 | 'md' 36 | 'lg' 40` · `iconLeft` / `iconRight` (pass Icon elements; padding adjusts per A3) · `loading` (16px spinner, width kept) · `selected` · `disabled` · `fullWidth` · `tabular` · `flashKey` (bump to replay the A11.4 fill flash) · `testId` · …HTML button (type defaults to `button`).

### IconButton (4.9, 4.16, A2)
`label` (required aria-label) · `icon` (Icon element; sized 40→20, 44→18, 56→22, 32/36→16) · `size 32 | 36 | 40 | 44 | 56` · `variant 'glass' (nav .06) | 'map' (.10) | 'solid' (mobile --bg-1) | 'ghost' | 'raised' (--bg-4 thumb)` · `active` (--bg-3) · `accentIcon` (orange icon, map follow-on) · `danger` (feed lost) · `loading` · `badge` (number, Ø18 red at -4/-4) · `badgePulse` · `ring` (avatar .12 ring) · `testId` (`-badge`) · …HTML button.

### Pill / PlateChip (4.3, 4.10, A3)
`size 'xs' 24 | 's' 30 | 'm' 36 | 'l' 40` · `tone 'neutral' (--bg-2) | 'solid' (--bg-3) | 'outline' | 'dim' | 'green' | 'red' | 'red-solid' (EMERG) | 'orange' | 'glass' (map pill) | 'tag' (radar tag) | 'chip' (plate over glass)` · `dot` `'green' | 'red' | 'orange' | 'white' | 'grey' | <css colour>` + `dotGlow` · `icon` + `iconTone 'orange' | 'green' | 'red' | 'white' | 'none'` (signal chips colour the icon only) · `trailing` (14px chevron) · `count` (number before label, 6px gap) · `tabular` · `uppercase` · `interactive` (renders `<button>`; A2 count-pill states) · `onClick` · `selected` · `disabled` · `testId` · …HTML.
`PlateChip({ letter, value, size 'm' | 'l', onGlass, testId })` - wake letter circle overlapping the squawk / registration pill.

### Badge (4.19, A13, A24-8)
`value` number|string (`max` 99 → "99+") · `size 's' 18 | 'm' 22` · `tone 'red' | 'orange' | 'neutral' | 'white'` · `glow` (critical) · `pulse` (new-alert ring x2) · `bumpKey` (scale bump on change) · `dot` (Ø8 bullet) · `testId` · …HTML span.

### Tabs (4.9, A2, A15)
Position / nav tabs with the sliding `--bg-3` pill. `items: { id, label, disabled?, badge?, testId? }[]` · `value` · `onChange(id)` · `compact` (36 tall) · `tabular` · `ariaLabel` · `testId` (`-<id>` per tab). Arrow / Home / End keys; `role=tablist`.

### Segmented (4.6, A2)
Text tabs with the 1px sliding underline (Week · Month, 1× 2× 4×). `items` · `value` · `onChange` · `tabular` · `small` · `ariaLabel` · `testId` (`-<id>`).

### Toggle (4.19, A2)
`checked` · `onChange(bool)` · `label` · `description` · `labelPosition 'left' | 'right'` · `disabled` · `name` · `testId`. `role=switch`.

### Checkbox
`checked` · `onChange` · `indeterminate` · `label` · `description` · `disabled` · `error` · `name` · `testId`. Checked = orange fill (matches the toggle).

### Input (4.19, A2, A11.6)
`label` · `prefixIcon` (16px, text-3) · `suffix` (Kbd / ghost IconButton) · `error` (red border + body-s red helper, no fill) · `helper` · `size 'l' 40 | 'm' 36` · `surface 'solid' (--bg-2) | 'glass' | 'transparent'` · `tabular` · `fullWidth` · `shakeKey` (±3px shake on parse error) · `acceptKey` (border flash .28 → rest) · `wrapClassName` · `testId` (`-wrap`) · …HTML input (forwardRef).

### Select / Menu (A11.1)
`Select`: `options: MenuOption[]` · `value` · `onChange(value, option)` · `placeholder` · `label` · `icon` · `size 'l' | 'm'` · `surface 'solid' | 'glass'` · `disabled` · `error` · `helper` · `fullWidth` · `menuPlacement 'bottom' | 'top'` · `tabular` · `ariaLabel` · `testId` (`-menu`). Keyboard: arrows, Home/End, typeahead, Enter/Space, Esc, Tab.
`MenuOption`: `{ value, label, description?, right?, icon?, disabled?, section?, divider?, text?, testId? }`.
`Menu` (standalone panel for autocomplete / search results): `options` · `value` · `activeIndex` · `onActiveChange` · `onSelect` · `placement 'bottom' | 'top' | 'static'` · `emptyText` · `id` · `tabular` · `testId`.

### Kpi (2.2, A9)
Big-number pattern: white leading group, `--text-4` trailing group at the same size, unit in body-s on the baseline.
`value` number | string (optional when `hi`/`lo` given) · `decimals` · `split 'auto' (first comma, else decimal) | 'comma' | 'decimal' | 'none'` · `hi` / `lo` explicit groups · `unit` (`'%'` gets no gap) · `unitTone 'text-2' | 'text-3' | 'text-4'` · `suffixDisplay` (same-size dim word, "min") · `prefix` rendered verbatim ("± ", "HDG ", "FL") + `prefixDim` · `size 'xl' 44 | 'l' 36 | 'm' 28` · `label` (label-xs above; metrics grid) · `delta` + `deltaUnit` + `deltaTone 'auto' (positive = orange late) | 'neutral' | 'red' | 'green'` · `tabular` · `countUp` (600ms on increase) · `dim` · `red` · `testId` · …HTML div.
Use `formatAltitude(ft)` → `{ hi, lo, unit, fl }` for `5,000 ft` / `FL350` / `SFC`.

### StatTile (4.2, A7)
`label` · `value` · `icon 'ok' | 'alert' | 'none' | ReactNode` · `conflict` (inner red stroke + red number when > 0) · `fixedWidth` (200) · `countUp` · `onClick` · `testId` (`-value`). Zero state: icon hidden, text-3.

### BarChart (4.5, A8)
`data: { label, current: [min,max] | n, compare?, value?, delta?, testId? }[]` · `yTicks` (labels right) · `domain` · `formatY` (`50k`) · `formatValue` · `height` 220 · `selected` / `onSelect(index | null)` · `tooltip` · `legend { current, compare? }` · `animate` · `onGlass` · `ariaLabel` · `testId` (`-tooltip`). Hover band .04, click selects (band .08 + glow + tooltip), `←/→` when focused. A visually-hidden table backs the SVG.

### Sparkline (4.7, A8)
`data: number[]` · `domain` · `yTicks` · `formatY` · `formatValue` · `xLabels` · `target` + `targetCaption` ("Target:") + `targetLabel` (">80%") · `highlightAbove` (white segments + Ø7 dots + bands) · `lowThreshold` (orange segments) · `height` 120 · `showCurrent` (pulsing last-point marker) · `cursor` / `onCursorChange` (vertical cursor line, controlled or hover) · `cursorTooltip` · `animate` (600ms draw) · `onGlass` · `ariaLabel` · `testId`.

### ProgressBar (A11.10)
`value` 0..1 · `indeterminate` · `tone 'white' | 'orange' | 'red' | 'green'` · `thickness 2 | 4` · `label` · `showValue` · `fixedWidth` (200) · `testId` · …HTML.

### Divider (4.19)
`vertical` · `spacing 'none' | 's' | 'm' | 'l'` · `strong` · `label` · `testId`.

### ListRow (4.17, A2)
`icon` + `iconTone` · `title` · `subtitle` · `meta` + `metaTone 'neutral' | 'orange'` · `trailing` · `chevron` · `selected` · `disabled` · `loading` (skeleton) · `flush` · `rule` (2px left rule variant) · `href` · `onClick` · `testId` · …HTML.

### AlertItem / AlertGroup (4.12, A13)
`AlertItem`: `severity 'critical' | 'warning' | 'advisory' | 'info'` · `index` (badge numeral) · `title` · `time` · `expanded` / `onToggle` (uncontrolled when omitted) · `affectedLabel` · `affected: { name, detail?, testId? }[]` · `description` · `recommend { text, onAccept?, done?, loading? }` (Accent button 36, full width) · `actions` · `pulse` · `testId` (`-toggle`, `-recommend`).
`AlertGroup`: `icon` · `title` · `parenthetical` · `count` + `countTone 'red' | 'white' | 'text-2' | 'text-3'` · `children`.

### Toast (A11.3)
Wrap the app once in `<ToastProvider max={3}>`; then `const { toast, dismiss, clear } = useToast()`; `toast({ kind 'info' | 'success' | 'attention' | 'error', text, detail?, action? { label, onClick }, duration? (5000 / error 8000 / 0 sticky), dismissible?, id?, testId? })` or `toast('text')`. Host: bottom-centre, stacks upward, pause on hover, `data-testid="toast-host"`, each toast `toast-<kind>` unless `testId` given. `Toast` (presentational) and `ToastStack` exist for docs.

### Tooltip (4.19, A20)
`content` · `kbd: string[]` · `children` (single element) · `placement 'top' | 'bottom' | 'left' | 'right'` · `delay` 300 · `disabled` · `block` · `open` (forced, inline; docs only) · `testId`. Shows on hover and focus, hides on Esc / scroll.

### Modal / Sheet (A11.2, A5)
`Modal`: `open` · `onClose` · `title` · `children` · `footer` | (`confirmLabel`, `cancelLabel` 'Cancel', `onConfirm`, `confirmVariant 'primary' | 'accent' | 'danger'`, `confirmDisabled`, `confirmLoading`) · `footerLeft` · `showClose` · `wide` (640) · `dismissOnScrim` · `inline` (no portal; docs) · `testId` (`-scrim -close -cancel -confirm`). Focus trapped, Esc closes, body scroll locked.
`Sheet`: `open` · `onClose` · `title` · `count` · `snap 'peek' | 'half' | 'full'` + `onSnapChange` · `headerRight` · `children` · `inline` · `testId` (`-handle`). Drag the handle ≥ 24px to change snap / close.

### Kbd (A20)
`<Kbd>Esc</Kbd>` · `keys={['Ctrl','K']}` (joined with "+") · `plain` (text-3, no chrome - placeholders) · `testId`.

### Skeleton (A11.10)
`variant 'text' | 'number' | 'block' | 'circle' | 'pill'` · `width` · `height` · `lines` · `testId` · …HTML.

### EmptyState (A11.10)
`icon` · `title` · `hint` · `action` · `compact` · `error` · `testId` · …HTML.

### ScrollArea (A4, A11.7)
`direction 'vertical' | 'horizontal'` · `fade` (12px mask, default on) · `maxHeight` / `height` · `stickToBottom` + `newCount` (radio log "n new" pill) · `onAtBottomChange` · `testId` (`-root`, `-new`) · …HTML (forwardRef to the scrolling element).

### LoadingOverlay (A11.10)
`open` · `text` · `progress` 0..1 (indeterminate when omitted) · `fixed` · `testId`. Fades out 320ms after `open` turns false.

### Dial (04 command tree)
Circular heading picker. `value` 0-359 · `onChange` · `current` (aircraft heading: white marker + orange turn arc) · `turn 'left' | 'right' | 'auto'` · `step` 5 · `size` 200 · `label` 'HDG' · `disabled` · `quickSteps` ([-30,-10,10,30] pills) · `onGlass` · `testId` (`-svg`, `-step-<n>`). Drag / click on the card; arrows ±step, Shift ±1, PageUp/Down ±30, Home = current, End = reciprocal. `role=slider`.

### Ladder (04 command tree, A11.4)
Vertical altitude / speed picker. `value` · `onChange` · `min` · `max` · `step` · `majorEvery` · `current` (white dashed marker + tinted range) · `label` 'ALT' · `unit` 'ft' · `formatTick` · `formatValue` · `height` 240 · `width` 128 · `quickSteps` ([3000,1000,-1000,-3000] as A11.4 pills) · `quickLabel` · `stepsLayout 'column' | 'row'` · `hideHeader` · `disabled` · `onGlass` · `testId` (`-value`, `-svg`, `-step-<n>`). Drag / click / wheel; arrows ±step, PageUp/Down ±5 steps, Home = current, End = max.

### Stepper (04 command tree)
Wizard chrome for the click-to-command tree. `steps: { id, label, value?, testId? }[]` · `activeIndex` · `onStepClick(i)` (done chips are clickable) · `title` · `subtitle` · `summary` (phrase preview; use `<StepperSummary parts={[{ text:'BAW123', strong:true }, ' turn left heading ', { text:'270', strong:true }]} />`) · `children` (current picker) · `onBack` · `onCancel` · `onConfirm` · `backLabel` · `cancelLabel` · `confirmLabel` 'Transmit' · `confirmDisabled` · `confirmLoading` · `confirmHotkey` · `keyboard` (Enter confirms, Esc cancels, Backspace goes back when focus is not in an input) · `testId` (`-step-<id> -summary -back -cancel -confirm`).

## Composition notes for the game UI

- Strip card (A12): `GlassPanel variant="lit"` (selected) or `variant="nested"` (compact) + `PlateChip` + `Pill` status + signal chips (`Pill` with `iconTone`) + `Kpi size="m"` metrics.
- Alerts panel: `GlassPanel variant="glass" titleSize="l" affordance="collapse" padding="card-lg" radius="card-lg"` → `AlertGroup` → `AlertItem`.
- Command panel: `GlassPanel variant="glass-strong"` → header `Kpi` row → `Button variant="secondary"` action list → `Stepper` with `Dial` / `Ladder` / `Select` pickers → `Button variant="accent"` transmit, `Button variant="danger"` go-around.
- Nav: `LogoMark` + `Tabs` + `Pill tone="glass"` (airport / ATIS) + `Input surface="glass"` search + `IconButton` cluster.
- Map overlays: classes in `map.css`; canvas renderers read colours with `getComputedStyle(document.documentElement).getPropertyValue('--orange')` and wait for `document.fonts.ready` before the first frame (A8).
