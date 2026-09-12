# SKYCONTROL Design System — reverse-engineered from Ron Design Lab "TheTrail / Traffic Management"

Source: 23 reference JPEGs in `/root/atc/refrence/design_language/` (all 1440×1920). Every hex below was sampled with PIL (median of a 7×7 patch for fills; 97th-percentile luminance inside the glyph box for text; brightest-saturated-pixel median for accents). Frames are referenced by the first 9 digits of the file name. Where the mock-up photography dims the screen (phone-in-hand shots), the clean straight-on renders (`672372960`, `672433464`, `673081880`, `673092619`, `673820714`, `674444147`) were used as the authority.

Sizes are given for a **1440-wide desktop dashboard at 1×**. The straight-on vehicle-card render (`673081880`) was measured to derive ratios (card 800×1063 px, corner radius 58 px, title cap-height 40 px, title-to-edge padding 53 px, pill height 88 px for a 27 px cap-height label) — i.e. **radius ≈ 1.05 × title size, padding ≈ 0.95 × title size, pill height ≈ 2.3 × label size**. Mobile uses the same tokens at ×1.25.

---

## 1. Palette

### 1.1 Neutral ground (three depth layers, all near-neutral, never blue-black)

| Token | Hex | Sampled from | Use |
|---|---|---|---|
| `--bg-0` | `#0b0b0c` | phone shell `#060606` (673145138, 673110170), desktop shell `#0e0f11` (672456451) | App shell, page background, map "void" behind tiles |
| `--bg-1` | `#121212` | solid card `#121212` (672372960), `#101010` (673145138) | Solid (non-glass) cards on the shell |
| `--bg-2` | `#1c1c1e` | tiles `#1b1d1c`, category pills `#1e201f`, vehicle card `#222222`, chips `#1d1d1d` | Nested surfaces: stat tiles, count pills, chips, dropdown pills, table chips |
| `--bg-3` | `#252628` | active nav pill `#252628` / `#252726` (673814523, 672456451) | Active/selected pill, hover surface |
| `--bg-4` | `#3a3b3c` | slider thumb `#3a3b3a`, map-pill `#363739`, zoom button `#3c3c3c` | Raised controls (thumbs, floating circular buttons) |
| `--line` | `rgba(255,255,255,0.06)` | derived | Dividers, faint separators |
| `--line-strong` | `rgba(255,255,255,0.12)` | pill outline delta ≈ +22 luminance over `#303435` (673081880) | Outlined pills, inputs, card edge |

Overlay-on-glass chips (measured on the vehicle card over map): "L" circle `#464646`, "45623" plate `#4e4e4e` over glass `#2e2e2e` → `rgba(255,255,255,0.14)` and `rgba(255,255,255,0.18)`.

### 1.2 Glass

Sampled behaviour: over a white bus body (`#939496` outside the card) the glass reads `#616566`; over dark (`#101211`) it reads `#1e1e1e` (673092619). Solving both gives fill ≈ `rgb(46,46,46)` at α ≈ 0.46, plus a heavy blur that lets the map's hue bleed through (search bar over green terrain reads `#2d3923`, Passenger-Load card reads `#3a4733`).

```css
--glass-fill:        rgba(40, 40, 42, 0.50);
--glass-fill-strong: rgba(24, 24, 26, 0.72);   /* panels that must stay readable over bright map */
--glass-border:      rgba(255, 255, 255, 0.10);
--glass-highlight:   rgba(255, 255, 255, 0.14); /* 1px inner top edge */
--glass-blur:        40px;
--glass-shadow:      0 24px 60px rgba(0,0,0,0.45), 0 2px 6px rgba(0,0,0,0.30);

.glass {
  background: var(--glass-fill);
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(1.15);
  backdrop-filter: blur(var(--glass-blur)) saturate(1.15);
  border: 1px solid var(--glass-border);
  box-shadow: inset 0 1px 0 var(--glass-highlight), var(--glass-shadow);
  border-radius: var(--r-card);
}
/* Selected / hovered glass card (Bus 6023 in 672456451: #969b92 top-left → #232323 bottom-right) */
.glass--lit {
  background:
    linear-gradient(135deg, rgba(255,255,255,0.28) 0%, rgba(255,255,255,0.08) 40%, rgba(255,255,255,0.02) 100%),
    var(--glass-fill);
  border-color: rgba(255,255,255,0.18);
}
/* Optional "refraction rim" seen on the reference (blue/rainbow band 12–14px at top edge, 673092619 top sweep #193c66→#637f8a) */
.glass--prism::before {
  content:""; position:absolute; inset:0; border-radius:inherit; padding:1px; pointer-events:none;
  background: conic-gradient(from 200deg, rgba(255,255,255,.0), rgba(120,170,255,.55), rgba(255,255,255,.0) 30%, rgba(255,190,120,.35) 55%, rgba(255,255,255,.0));
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor; mask-composite: exclude; opacity:.55;
}
```

Solid cards (`--bg-1`) get **no** border and no shadow; glass cards get border + shadow. Glass is used only where something (map, photo, other cards) is behind the surface.

### 1.3 Text

| Token | Value | Sampled | Use |
|---|---|---|---|
| `--text-1` | `#ffffff` | titles, big numerals, arrows all `#ffffff` | Primary: titles, leading digits, values, active tab |
| `--text-2` | `#c8c8c8` (= white .78) | nav inactive `#b9babc`, "Online" `#d8d8d8`, "Capacity Issues" `#ced0cf`, timestamp `#c8c8c8` | Secondary: nav tabs, labels next to values, list titles |
| `--text-3` | `#868686` (= white .52) | "Target:" `#838584`, ">80%" `#7f8082`, "100%" `#87888a`, "Route 14" `#676767`, "4m ago" `#7a706e`, "(2 lines)" `#686a65`, month labels `#808080` | Tertiary: captions, timestamps, axis labels, parentheticals, placeholders |
| `--text-4` | `#606060` (= white .37) | "580" `#606060`/`#646464`, ".3" `#5d5f5e`, "min" `#626262` | Dimmed trailing digits and units of big numbers; table headers |
| `--text-5` | `#444446` (= white .26) | far axis labels "21:00" `#444446`, "09:00" `#4e4e4e` in dark closeups | Lowest-priority axis ticks, disabled |

### 1.4 Accent orange (single accent hue; used for data, selection, and "attention but not danger")

| Token | Value | Sampled |
|---|---|---|
| `--orange` | `#f5933f` | bars `#f59443` `#f79441` `#f59445` (672372960), `#f69143` (672433464), spark `#f69632` (672456451), `#f59131` (673110170) |
| `--orange-deep` | `#ea7226` | tooltip specular rim `#ea7226` (672372960) |
| `--orange-text` | `#f5933f` (render at ≥13px; thin strokes desaturate in the refs due to JPEG chroma — do **not** copy `#c79876`) | |
| `--orange-tint-20` | `rgba(245,147,63,0.20)` | tooltip fill `#3f2c1d` over `#121212` = orange @ .20 |
| `--orange-tint-08` | `rgba(245,147,63,0.08)` | selected-column band `#261d16` over `#121212` = orange @ .08 |
| `--orange-glow` | `0 0 24px rgba(245,147,63,0.35)` | halo around tooltip and selected column |

### 1.5 Status

| Token | Value | Sampled |
|---|---|---|
| `--red` | `#fb0a08` | badges `#f80606` `#fb0e0c` `#f90504` `#fe0200`, bell `#f81215`, triangle `#ff0600` |
| `--red-tint` | `rgba(251,10,8,0.10)` | alert card `#312624` over panel `#232520`; second card `#392b2b` over `#1e201f` (≈ .08–.12) |
| `--red-glow` | `0 0 12px rgba(251,10,8,0.55)` | glowing bullet core `#ff3a3a`, ring `#501519` (671736848) |
| `--green` | `#57cd50` | check icon `#57ce50` `#56cd4b` `#5cce54` |
| `--green-dim` | `rgba(87,205,80,0.70)` | Online-pill text/border and LTE icon read `#5d7c5c`/`#698f66` on the dimmed desktop render |
| `--blue-marker` | `#0a609b` | port/harbour map marker `#0a609b` `#075b99` |
| `--pink-marker` | `#b5647a` | bus-station map marker `#b56477` `#b46578` |
| `--lime-marker` | `#8e9716` | airport map marker + secondary route `#8e9716` `#8f9615` |

Blue and pink appear **only** as small map category markers — never in UI chrome.

### 1.6 Chart neutrals

| Token | Value | Sampled |
|---|---|---|
| `--chart-grey-bar` | `rgba(255,255,255,0.55)` | grey bars `#8b8b8b`–`#9a9a9a` on `#121212` |
| `--chart-line-muted` | `rgba(255,255,255,0.30)` | sparkline `#555555` on `#0f0f0f`, `#545454` |
| `--chart-line-hi` | `#ffffff` | highlighted segment, dots, step-chart value lines |
| `--chart-grid` | `rgba(255,255,255,0.12)` | dashed grid `#313131` on `#0f0f0f`, `#3e3f41` on `#1c1d1f`, `#403c39` on `#121212` |
| `--chart-grid-faint` | `rgba(255,255,255,0.04)` | secondary grid `#151515` on `#121212` |
| `--chart-target` | `rgba(255,255,255,0.85)` dashed | target line `#cfcfcf`–`#ffffff` |
| `--chart-band` | `rgba(255,255,255,0.04)` | selected band `#292929` on `#212322`, `#171717` on `#0d0d0d` |
| `--chart-area` | `rgba(255,255,255,0.03)` | step-area fill under the "today" chart |
| `--tick` | `rgba(255,255,255,0.45)` | slider ticks `#808080` |

### 1.7 Map tint (see §5)

Water `#1d2c33`–`#202f36`, vegetation `#3b4f37`–`#3d4d3e` (S ≈ 30 %), rock/urban `#2b2b2b`–`#474948` (S ≈ 0). Veil colour `rgba(8,10,12,0.28)`.

---

## 2. Typography

### 2.1 Family

Observed letterforms (enlarged crops of `673081880`, `673820714`, `672433464`): geometric, low-contrast, wide round `O`/`0`, **double-storey `a`**, **single-storey `g`**, straight-tailed `y`, `t` with a hooked foot, `1` with a flag and **no base**, `M` with vertical sides and a low vertex, `W` with four straight strokes, `R` with a straight leg, round dot on `i`. Display numerals are set in a Light weight; body in Regular; nothing heavier than Medium appears in the UI.

**Pick: `DM Sans` (variable; weights 300 / 400 / 500; `opsz` axis).** Of the candidates — Inter (too neutral/narrow, flat-sided round letters), Manrope (squared bowls, straight `t`), Plus Jakarta Sans (angled terminals, distinctive `J`/`t`), Geist (Inter-like rhythm) — DM Sans is the only one that is genuinely geometric with circular bowls, has the double-storey `a` + single-storey `g` + hooked `t` combination, ships a true 300 weight, and its optical-size axis produces the hairline display numerals seen in "122,580". (If the list is not a hard constraint, `Outfit` is the closest visual twin and can be swapped 1:1 with the same scale.)

```css
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500&display=swap');
:root { --font: "DM Sans", "Outfit", "Helvetica Neue", Arial, sans-serif; }
body { font-family: var(--font); font-feature-settings: "ss01"; -webkit-font-smoothing: antialiased; }
```

### 2.2 Scale (desktop 1×; mobile ×1.25)

| Token | Size / weight / line-height / tracking | Use (reference) |
|---|---|---|
| `display-xl` | 44px / 300 / 1.0 / −0.02em | Map title "Traffic Management"; hero KPI "122,580", "142,580", "± 2.5" |
| `display-l` | 36px / 300 / 1.0 / −0.02em | Stat-tile numbers "12", "4"; floating card "87" |
| `display-m` | 28px / 300 / 1.05 / −0.01em | Mobile stat numbers, table totals |
| `title-l` | 20px / 400 / 1.2 / 0 | Panel titles "Warning", mobile screen title |
| `title-m` | 16px / 400 / 1.25 / 0 | Card titles "Live Passenger Volume", "Operational Efficiency", "Bus 6023", group headers "Capacity Issues" |
| `body-m` | 14px / 400 / 1.4 / 0 | Nav tabs, segmented tabs, alert titles, station names, pill labels, table values |
| `body-s` | 13px / 400 / 1.4 / 0 | Timestamps, "Next: Central Station", "4m ago", axis labels, units |
| `label-xs` | 11px / 400 / 1.2 / +0.01em | Table headers "Route number", column keys "L1 L12", badge numerals (500) |
| `micro-caps` | 10px / 500 / 1.2 / +0.08em uppercase | Not in reference; reserve for ATC strip codes (e.g. "SQK", "WTC") |

Rules
- Weights: 300 for anything ≥ 28px, 400 for everything else, 500 only for the active nav tab and badge numerals.
- `font-variant-numeric: tabular-nums` on tables, timers, timestamps, offsets (±2min), axis labels. Display KPIs use proportional figures (default).
- **Big-number pattern** (measured on "122,580", "78.3 %", "± 2.5 min"): leading significant group in `--text-1`, trailing group/decimals in `--text-4` **same size**, then the unit in `body-s`/`--text-2` (or `--text-3`) sitting on the baseline with an 8px gap. The comma/decimal point stays white. Percent sign after "78.3" is `body-s` `--text-3`. "min" after "± 2.5" is display size but `--text-4`.
  ```html
  <div class="kpi"><span class="kpi-hi">122,</span><span class="kpi-lo">580</span><span class="kpi-unit">Month</span></div>
  ```
  `.kpi{display:flex;align-items:baseline;gap:8px;font:300 44px/1 var(--font);letter-spacing:-.02em}` `.kpi-lo{color:var(--text-4)}` `.kpi-unit{font:400 13px/1 var(--font);color:var(--text-2);margin-left:0}`
- Parentheticals in headers ("(2 lines)", "(Route 14)") are the same size as the header but `--text-3`, separated by a normal space.
- Never all-caps for titles in this language; sentence case throughout.

---

## 3. Spacing & shape

```css
--s-1: 4px; --s-2: 8px; --s-3: 12px; --s-4: 16px; --s-5: 20px; --s-6: 24px; --s-8: 32px; --s-10: 40px;
--r-card: 20px;   /* measured 58px @ 2.9× → 20 */
--r-card-lg: 24px;/* mobile / hero cards */
--r-inner: 14px;  /* nested cards (alert item, mini-map, tooltip body) */
--r-chip: 10px;   /* small square chips (slider thumb) */
--r-pill: 999px;  /* every pill, tab, button, badge */
--bw: 1px;        /* the only border width; never 2px */
--icon-s: 16px; --icon-m: 20px; --icon-l: 24px;
--stroke-icon: 1.5px;   /* line icons (Phosphor Light / Lucide with strokeWidth 1.5) */
--stroke-chart: 1.5px;  /* sparklines, value lines */
--stroke-bar: 2px;      /* vertical bar charts */
--stroke-route: 3px;    /* map routes */
--stroke-wire: 1px;     /* vehicle wireframe illustration */
```

- Card padding **20px** (title-m cards), 24px for hero/glass cards on mobile, 16px for small stat tiles.
- Gap between sibling cards **12px**; gap between pills in a row **8px**; gap between nav tabs **32px** (text-to-text).
- Inside a card: title → KPI 24px; KPI → tabs 24px; tabs → chart 28px; chart → axis labels 12px.
- Icon-to-label gap 8px (GPS/LTE), 10px for group headers (bus icon → "Capacity Issues").
- Corner "↗" affordance sits at `top:20px; right:20px` (same inset as padding) — 18px icon.
- Pills: height 32px (desktop) / 40px (mobile), padding-x 14px / 20px; with leading icon: padding-left 12px, icon 18px, gap 8px.
- Circular icon buttons: 40px (desktop nav), 44px (map controls), 56px (mobile header).
- Badge: 18px circle, offset `top:-4px; right:-4px` on a 40px button.

---

## 4. Component catalogue

### 4.1 Glass card (`.card`)
- Structure: `header` row (title-m `--text-2`→ white on hover, "↗" icon right), body, optional footer.
- Solid variant on shell: `background: var(--bg-1)`; no border. Glass variant over map/photo: recipe §1.2.
- Radius 20, padding 20. Min-height by content. Title colour: `#ffffff` on glass cards (sampled), `--text-2` on solid cards when the card contains a display number (the number takes the white).
- "↗" (arrow-up-right, 18px, 1.5px stroke, white): the "open detail" affordance on every card and floating popover. Hover: `translate(2px,-2px)`.
- Collapsible panels use a chevron-up (16px) instead of "↗" (Warning panel).

### 4.2 Stat tile (Online 12 / Offline 4)
- Size ≈ 200×104 (desktop), `--bg-2`, radius 20, padding 16.
- Top-left: status icon 20px — filled green circle with white check (`--green`) or filled red triangle with "!" (`--red`). Bottom-left: label `body-m` `--text-2` ("Online"). Bottom-right: `display-l` 300 white number.
- Grid: two tiles side by side, 12px gap.

### 4.3 Count pill row (24 Bus · 100 Taxi · 12 Trains · 13 Trams)
- Pill `--bg-2`, radius 999, height 40, padding 0 18, `body-m`: number then label with a 6px gap, both `--text-2`. Four pills, 8px gap, wrap allowed. Active state: `--bg-3` + white text.

### 4.4 Big-number + unit block — see §2.2 pattern.

### 4.5 Vertical orange bar chart ("Live Passenger Volume", monthly)
- Plot height 220 (desktop) / 300 (mobile). Y-axis labels on the **right** (`body-s` `--text-3`: 50k/100k/150k), x labels below (`body-s` `--text-3`; selected month in `--orange`).
- Grid: horizontal dashed lines at each y label, `1px`, `stroke-dasharray 10 8`, `--chart-grid`.
- Per category two bars: **current** `--orange` and **comparison** `--chart-grey-bar`, each 2px wide, `stroke-linecap: butt` (square ends), 7px apart (orange left). Bars are floating ranges (min→max), not zero-based — they start and end at data values.
- Selected column: band `width = column pitch − 8px`, fill vertical gradient `orange @.03 → @.08 → @.03`, plus `--orange-glow` at 50 %.
- Tooltip above the selected orange bar: pill 84×32, fill `--orange-tint-20` on top of the card colour, border 1px `rgba(245,147,63,0.35)`, **left-side specular arc** (a 2px `--orange-deep` arc with 6px blur, the reference's "lens" highlight), text `body-s` white, `tabular-nums`. Arrow-less; bottom-centred 8px above the bar top.
- Segmented time tabs above the plot (§4.6).

### 4.6 Segmented text tabs (Week · Month · Quarter · Year)
- Text-only, `body-m`, `--text-2`; active: white + **1px underline** the width of the label, 6px below the baseline. Gap 24px. No container, no pill. Underline slides 200ms.

### 4.7 Sparkline with target ("Operational Efficiency")
- Plot 100–140 tall. Y labels right (25% 50% 75% 100%, `body-s` `--text-3`); x labels bottom (06:00 … 21:00 every 3h). "Target:" label top-left `body-s` `--text-3`; ">80%" label above the target line at right.
- Base line: `--chart-line-muted`, 1.5px, `linejoin round`, high-frequency data (no smoothing — the jaggedness is the look).
- Target line: horizontal dashed white `rgba(255,255,255,.85)`, 1px, `dasharray 8 6`.
- Highlight segments (where value crosses target): same path drawn again in `#ffffff` 1.5px, capped by **two white dots Ø 7px** at the crossing points; a vertical **band** from the segment's x-range down to the axis, `--chart-band`.
- Negative-event segment: same treatment in `--orange` with orange dots (the 08:00 dip).
- Secondary dashed grid every 25 %, `--chart-grid`; the far dashed lines fade to `--chart-grid-faint`.

### 4.8 Step chart ("Live Passenger Volume · today")
- 3-hour buckets across 06:00–21:00. For each bucket a horizontal **value line** (1.5px) spanning the bucket, label above-left (`body-s` white "55k") and delta below-left (`body-s` "-0%").
- Buckets under target: line + delta in `--orange`; otherwise white line / `--text-2` delta.
- Background: minute-level jagged line `--chart-line-muted` 1px and a stepped area fill `--chart-area`; dashed grid at 45k/50k/55k/60k with labels on the right.

### 4.9 Top nav bar (desktop)
- Height 64, transparent over `--bg-0` (over the map it is glass-less; content simply floats).
- Left: logo mark 28px white (diagonal-stripes rounded mark) at x=24. Tabs start at x=104: `body-m` `--text-2`; **active tab is a pill** `--bg-3`, radius 999, padding 10px 22px, white 500. Tab gap 32.
- Right cluster (right-aligned, 8px gaps): search field (glass pill 320×40, padding 0 16, placeholder "Search Ctrl+Shift+F" `--text-3`, search icon 20px right-aligned inside), icon buttons 40px circles (glass `rgba(255,255,255,.06)` + 1px `rgba(255,255,255,.06)`; icons 20px 1.5px white: wifi/signal, headset, bell), bell carries the red badge (18px `--red`, 11px 500 white numeral), avatar 40px circle photo with 1px `rgba(255,255,255,.12)` ring.
- Mobile header: logo left; four 56px circular buttons right (search, wifi, bell+badge, avatar), `--bg-1` fill, 1px `rgba(255,255,255,.05)` border.

### 4.10 Status pills & signal chips
- **Online (neutral)**: outlined pill, 1px `--line-strong`, transparent fill, `body-s` white, height 30, padding 0 14. Used inside the selected/lit card.
- **Online (green)**: same pill, border `--green-dim`, text `--green-dim`.
- **Offline**: border `rgba(251,10,8,.45)`, text `--red`.
- **Signal chips** ("((•)) GPS", "wifi LTE"): icon 16px + `body-s` `--text-2`, gap 6, chips 16px apart, right-aligned in the status row. Active-signal state colours the icon only: GPS icon `--orange`, LTE icon `--green`; label stays grey.

### 4.11 Vehicle card ("Bus 6023")
Card 300×440 desktop (glass when selected — `.glass--lit`; otherwise `--bg-2` solid, radius 20, padding 20).
1. Header: title `title-m` white "Bus 6023"; timestamp `body-s` `--text-3` "08.03.2026, 02:37:53 AM" (tabular); "↗" top-right.
2. Illustration: side-elevation **wireframe** of the vehicle, 1px `rgba(255,255,255,.85)` strokes, no fill, 70 % of inner width, centred, 24px above/below. Over it, a **plate chip group** centred on the body: circle Ø36 `rgba(255,255,255,.14)` containing a single letter ("L"/"R", `body-m` white) overlapping by 40 % a pill 96×36 `rgba(255,255,255,.18)` with the numeric ID (`body-m` white, tabular).
3. Status row: Online pill left; GPS/LTE chips right.
4. Mini-map: full inner width, 120 tall, radius 14, monochrome street grid (`--bg-1` ground, streets `rgba(255,255,255,.08)` 1px, blocks `#2c2c2c`), white route 2px `linejoin round`, white location pin 20px at route start (pin = teardrop, filled white, dark dot).
5. Timeline: labels "06AM" / "11PM" (`body-s` white) at the ends; below, a ruler of 1px ticks every 5px (`--tick`), height 16; end dots Ø8 `#ababab`; **thumb** = 32×32 rounded-square (`--r-chip`) `--bg-4` with vehicle glyph 18px white, casting `0 2px 8px rgba(0,0,0,.5)`; the ticks under the thumb brighten to `.7`.

### 4.12 Warning / alert panel
- Glass panel 400 wide, radius 24, padding 24. Header: `title-l` white "Warning" + chevron-up right.
- Group header row (24px top margin): icon 18px white (bus / clock) + `title-m` white "Capacity Issues" + `--text-3` "(2 lines)".
- **Alert item** (12px below header): card `--red-tint` fill, radius 20, padding 18 20.
  - Row 1: numbered badge Ø22 `--red` with `11px 500` white numeral (glowing variant on mobile: `--red-glow`), 10px gap, `body-m` white title "~180 passengers left behind", chevron-up/down 16px right.
  - Row 2: `body-s` `--text-3` "4m ago" aligned under the title (badge width + gap indent).
  - Expanded body (16px gap): label `body-s` `--text-3` "Affected stations:"; list items with a **2px left rule** `rgba(255,255,255,.8)`, 16px padding-left, item = `body-m` white name + `body-s` `--text-3` "115 passengers waiting", 12px between items.
  - "Recommend" row: sparkle icon 18px white at the badge column, `body-m` white "Recommend" + `body-s` `--text-3` "Dispatching reserve E-Bus".
- Collapsed item shows rows 1–2 only. Groups separated by 24px.
- Mobile: same panel as a bottom sheet with a 40×4 grab handle `rgba(255,255,255,.2)`.

### 4.13 Floating popover card ("Passenger Load")
- Glass, 220×140, radius 20, padding 18; anchored 12px below/right of the position puck. `body-m` white title, `body-s` `--text-3` "Next: Central Station", "↗" top-right, `display-l` white "87" + `body-s` `--text-4` "%".

### 4.14 Schedule offset table
- Card `--bg-1`; KPI "± 2.5 min Average Variance" (§2.2).
- Header row `label-xs` `--text-4`: "Route number" left, column keys (L1, L12, L14, L15, L24) spread evenly.
- Row: plate chip group (circle Ø28 "L" + pill "45623", `--bg-2`), then cells. Each cell sits on a faint tick ruler (`| | | |`, 1px `rgba(255,255,255,.12)`, tick every 6px) that runs the full row. Value `body-s` `--text-2` ("-2min"); flagged values prefixed with a 14px clock icon and set in `--orange` ("+1min"). Rows 44 tall, no horizontal divider — the tick ruler is the row separator.
- Mobile variant wraps every value in a chip: `--bg-2` pill 64×32; orange chips get `--orange-tint-08` fill and `--orange-glow` at 30 %.

### 4.15 Map overlays (see §5 for colours)
- Route (active leg): solid white 3px, round joins/caps, drop shadow `0 0 6px rgba(0,0,0,.5)`.
- Route (planned / ahead): white 3px dashed `dasharray 6 4`.
- Secondary routes: `--lime-marker` 2px solid; tertiary roads `rgba(255,255,255,.35)` 1.5px.
- Radius / geofence circle: 1.5px white dashed `dasharray 4 4`, r = 90px, no fill (max `rgba(255,255,255,.03)`), slow `stroke-dashoffset` rotation.
- **Position puck**: circle Ø56, glass fill `rgba(255,255,255,.28)` + `backdrop-filter: blur(12px)`, 1px `rgba(255,255,255,.35)` ring, shadow `0 6px 18px rgba(0,0,0,.45)`; centred white navigation-arrow glyph 22px (rounded paper-plane), rotated to heading. Sits on top of the route.
- Station pin: Ø26 disc `rgba(210,212,214,.92)` with dark glyph `#2c2f33` 12px; muted variant disc `rgba(44,47,51,.92)` with light glyph `#b7b7b9`.
- Category marker: Ø32 disc (`--blue-marker` / `--pink-marker` / `--lime-marker`) with white 14px glyph; a 1px `rgba(255,255,255,.25)` ring.
- Route end / hotspot: Ø10 `--orange` dot with 12px glow.
- Location pin (mini-map): 20px white teardrop.

### 4.16 Map controls
- Three 44px circles stacked horizontally (+ , locate ⌖ , −), 8px gap, glass `rgba(255,255,255,.10)` + border `.10`, icons 18px white 1.5px. Position: bottom-left of the map viewport, 20px from the bottom card row.
- Map pills (top-left under the title): "🚌 Bus 6023 ⌃" and "🗺 Map 2" — glass pills height 40, padding 0 16, icon 18 + `body-m` white + chevron 14 `--text-2`; 8px gap.

### 4.17 List rows
- 44px rows, 12px vertical padding, no dividers (use spacing); leading 18px icon `--text-2`; primary `body-m` white; secondary `body-s` `--text-3`; trailing value tabular `--text-2` or chevron 16px `--text-3`. Hover: `rgba(255,255,255,.04)` fill, radius 12.

### 4.18 Buttons
| Kind | Spec |
|---|---|
| Primary (rare) | pill h36, `#ffffff` fill, `--bg-0` text `body-m` 500; hover `#e8e8e8` |
| Secondary | pill h36, glass `rgba(255,255,255,.08)`, 1px `--glass-border`, white text; hover fill `.12` |
| Ghost | transparent, `--text-2`; hover `rgba(255,255,255,.06)` + white |
| Accent | pill, `--orange-tint-08`… `.16` fill, 1px `rgba(245,147,63,.35)`, `--orange` text; hover fill `.24` — only for the single main action |
| Danger | `--red-tint` fill, 1px `rgba(251,10,8,.35)`, `--red` text |
| Icon button | circle 40/44/56, glass `.06`, icon 20 white; hover `.12`; active `--bg-3` |
| Nav tab (active) | `--bg-3` pill, white 500 |

### 4.19 Toggles / inputs / misc
- Toggle (derived): 40×22 pill, off `rgba(255,255,255,.10)`, on `--orange`, knob Ø18 white, 160ms.
- Text input: glass pill h40, padding 0 16, 1px `--line-strong`, placeholder `--text-3`, focus border `rgba(255,255,255,.28)` (no coloured focus ring).
- Divider: 1px `--line`, full width, 16px margins.
- Scrollbar: 6px, thumb `rgba(255,255,255,.14)` radius 3, track transparent, visible on hover only.
- Tooltip (generic): `--bg-3` pill, `body-s` white, 8px 12px, shadow.
- Badge: Ø18 `--red`, `11px 500` white, positioned `-4px/-4px`.
- Chevrons: 16px, 1.5px, `--text-2`; up = expanded.
- Keyboard hint inside placeholder ("Ctrl+Shift+F") is plain `--text-3`, no kbd chrome.
- Logo mark: 28px, five diagonal rounded bars forming a rotated rounded square, white; over the map at 90 % opacity.

---

## 5. Map treatment

Satellite/aerial imagery is pulled toward a **monochrome terrain with a faint green memory**: rock/urban areas read pure grey (`#2b2b2b`–`#474948`, S 0–3 %), vegetation `#3b4f37`/`#3d4d3e` (S ≈ 30 %, V ≈ 30 %), water `#1d2c33`/`#202f36` (desaturated teal, V ≈ 20 %). Brightest terrain never exceeds ≈ `#666`. Hillshade relief stays strong (contrast is kept, saturation and brightness are cut).

```css
.map-satellite { filter: saturate(.45) brightness(.62) contrast(1.15); }
.map-satellite::after { content:""; position:absolute; inset:0; pointer-events:none;
  background:
    radial-gradient(120% 90% at 50% 40%, rgba(0,0,0,0) 55%, rgba(8,10,12,.55) 100%), /* vignette */
    rgba(8,10,12,.28); }
```
For MapLibre raster layers: `raster-saturation: -0.55, raster-brightness-max: 0.62, raster-contrast: 0.15`. Vector "chart" theme (mini-maps, phone dark map): ground `#131414`, land blocks `#1c1c1c`/`#2c2c2c`, streets `rgba(255,255,255,.08)` 1px, major roads `rgba(255,255,255,.35)` 1.5px, water `#0f1011`, labels off.

Overlay stack (bottom → top): imagery → veil → secondary routes (lime 2px) → planned route (white dashed 3px) → active route (white 3px) → radius circle (dashed 1.5px) → pins/markers → puck → floating glass cards → tooltips.

Route line style summary: active = `#fff` 3px solid; planned = `#fff` 3px `6 4`; alt = `#8e9716` 2px; radius = `#fff` 1.5px `4 4`; roads = white .35 1.5px.

---

## 6. Layout

Desktop (1440×900 reference; scales fluidly):
- **Nav** 64px, full-width, sits over `--bg-0` on the left and directly over the map on the right (no bar background).
- **Left column** 440px (x 20→460), padding 20/12: row of count pills (40) → 2 stat tiles (104) → Operational Efficiency card (300) → 2×2 vehicle-card grid (each 300 tall; the selected card is lit glass). Column scrolls; cards keep 12px gaps.
- **Map** fills the remainder (x 472→1440, y 64→900) edge to edge; the shell colour shows behind the left column only.
- Over the map: title `display-xl` at (map-left + 24, 88); pill row 12px under it; map controls bottom-left; **right panel** Warning: 400 wide, `top:84px; right:20px`, glass; **bottom row**: Schedule Offset (≈560×250) and Live Passenger Volume (≈400×250) floating at `bottom:20px`, 12px apart, left-aligned to map-left + 20; floating popover near the puck.
- z-index: map 0 → overlays 1–5 → floating cards 10 → nav 20 → tooltips/menus 30 → modals 40.
- Density: 20px outer gutters, 12px card gaps, 8px pill gaps; no borders between regions — depth is conveyed by `--bg-0 / --bg-1 / --bg-2` steps and glass.
- Alignment: every card's title baseline and "↗" share the 20px inset; big numbers left-align with the title; axis labels right-align to the card's inner edge; chart plots bleed to the card padding edge (no plot border).
- Mobile (390): 16px gutters, single column, cards full-width radius 24 padding 24; header 56px buttons; map screen = full-bleed map + back button (56 circle, top-left) + centred `title-l` + bell; floating card at left; bottom sheet for alerts.

---

## 7. Motion

```css
--ease-out: cubic-bezier(.2,.8,.2,1);  --ease-inout: cubic-bezier(.65,0,.35,1);
--t-fast: 120ms; --t-base: 200ms; --t-slow: 320ms; --t-draw: 600ms;
```
- Hover lift on cards: `transform: translateY(-2px)`; border → `rgba(255,255,255,.16)`; glass gains `.glass--lit` sheen at 60 %; 160ms `--ease-out`.
- Card / panel enter: `opacity 0→1, translateY 8→0, filter blur(8px)→0`, 320ms `--ease-out`, stagger 40ms per sibling.
- Chart draw: paths `stroke-dashoffset` from length→0 over 600ms `--ease-out`; bars scale-Y from their midpoint over 400ms with 30ms stagger; dots pop `scale .6→1` after the path; band and tooltip fade in 120ms after.
- Number changes: count-up 600ms `--ease-out`, tabular-nums to avoid jitter; dimmed trailing group updates without animation.
- Tab underline: slides/resizes 200ms `--ease-inout`.
- Tooltip / popover: `opacity + scale .96→1`, 120ms.
- Puck heading: `transform: rotate()` transition 400ms `--ease-inout`; position transitions 1s linear between fixes.
- Radius circle: `stroke-dashoffset` −16 per 4s linear infinite (slow crawl); alerts within the ring pulse the circle opacity .6→1 at 1.6s.
- New alert: badge `box-shadow 0 0 0 0 → 0 0 0 8px rgba(251,10,8,0)` ring, 1.2s ×2; item slides in from the top of its group.
- Selection change in a list: previous card loses sheen over 200ms while the new gains it; never a hard swap.
- Respect `prefers-reduced-motion`: keep opacity fades, drop transforms/draws.

---

## 8. ATC mapping (SKYCONTROL)

| Reference component | ATC equivalent | Notes |
|---|---|---|
| Nav tabs Live Map · Fleet · Routes · Analytics · Maintenance · Incidents · Crew | **Ground · Tower · Approach · Analytics · Settings** | Active mode in the `--bg-3` pill; replaces the current uppercase RADAR/GROUND segmented control. "Satellite / Chart" becomes a map pill (§4.16) like "Map 2". |
| Logo + "Traffic Management" map title | Mark + **airport name** ("Heathrow · EGLL") in `display-xl` over the map; sub-line `body-s` `--text-3` "GROUND · TOWER" / "APPROACH · TRACON" | |
| Search "Ctrl+Shift+F" | Callsign / squawk search "Search Ctrl+K" | |
| Wifi / headset / bell / avatar buttons | ADS-B feed status · Radio/PTT (opens the radio log) · Alerts (badge = active conflicts + emergencies) · Controller avatar | Radio log rows use `body-s`, "ATC" white / "PILOT" `--text-2` / "SYS" `--text-3`. |
| Count pills 24 Bus / 100 Taxi / 12 Trains / 13 Trams | **12 Airborne · 8 Taxiing · 5 Holding · 3 At gate** (or by wake class H / M / L) | Click filters the traffic list. |
| Stat tile Online 12 (green check) | **Under control 12** (green) | |
| Stat tile Offline 4 (red triangle) | **Conflicts 2** (red) — replaces `.conflict-banner`; zero state shows the tile in `--text-3` with no icon | |
| Operational Efficiency 78.3 % + target >80 % | **On-time / slot adherence 78.3 %** with target dashed line, or **Skill 7.4** (from `e.skill`) with the 12-point target | The current `.skill-track` bar becomes this sparkline card. |
| Live Passenger Volume (monthly bars; Week/Month/Quarter/Year) | **Movements per hour**: arrivals `--orange` vs departures `--chart-grey-bar`; tabs **Hour · Shift · Day · Week** | Selected column tooltip shows the count. |
| Live Passenger Volume today (step chart) | **Movements today** per 3-hour block with delta vs schedule; behind-schedule blocks in orange | |
| Schedule Offset ± 2.5 min table | **Slot deviation ± 2.5 min**; rows = flights (plate chip = wake class letter + squawk), columns = runways / fixes (27L · 27R · 09L · BIG · OCK); late values with clock icon in orange | |
| Vehicle card "Bus 6023" | **Aircraft strip card**: title = callsign "BAW123"; timestamp = last transmission; wireframe = side-profile aircraft silhouette (from `aircraftShapes.ts`, 1px white); plate chip = wake letter ("M") + squawk ("4523") or registration; Online pill → **AIRBORNE** (green) / **GROUND** (neutral) / **EMERG** (red); GPS/LTE chips → **ADS-B** (orange when receiving) · **ILS** / **COMM** (green when tuned); mini-map → last-60-fix radar trail with cleared route; timeline → ETD → ETA progress with an aircraft-glyph thumb | Selected aircraft card uses `.glass--lit`; the right `atc-right` detail panel becomes this card's expanded state ("↗"). |
| Detail panel metrics grid (callsign, airline, ICAO, WC) | Same big-number pattern: "5,000 ft" (white "5," dim "000"), "250 kt", "HDG 270", with `body-s` units | |
| Warning panel / Capacity Issues (2 lines) / Schedule Deviations (Route 14) | **Alerts** panel; groups: **Separation** (n pairs), **Runway** (incursion / occupied), **Emergency** (7700/7600/7500), **Wake turbulence**; header parenthetical = affected runway/sector | Badge number = pair index; "Affected stations" → **Affected aircraft** (callsign + "3.1 nm / 900 ft"); **Recommend** → auto-resolver suggestion ("BAW123 turn left heading 270"), clicking issues the command. |
| Passenger Load 87 % floating card, "Next: Central Station" | **Selected-aircraft callout** anchored to the puck: title callsign, "Next: BIG" (next fix / runway), display number = **altitude** or **distance to threshold** ("4.2 nm"), "↗" opens the strip | |
| Position puck with heading arrow + dashed radius circle | Aircraft symbol (heading-rotated) + **separation ring** (3 nm / 5 nm) around the selected aircraft; ring turns `--red` when a conflict pair is inside | Non-selected aircraft use a 12px white chevron with a 24px callsign tag (`body-s`, `--bg-3` pill at 80 %). |
| Solid white route / dashed route | **Cleared taxi route or active leg** (solid) / **planned route or expected path** (dashed); lime secondary line → ILS localizer/extended centreline | |
| Station pins / category markers | Gates & holding points (grey pins) / runway thresholds (lime), VOR-NDB beacons (blue), other airports (pink) | |
| Map "+ ⌖ −" controls | Same; ⌖ recentres on the selected aircraft | |
| "Bus 6023 ⌃" map pill / "Map 2" pill | **Selected-aircraft selector** "BAW123 ⌃" / **Layers** "Satellite · Chart" | |
| Mobile bottom sheet | Alerts sheet on the Ground/Approach mobile views | |
| + DEP / + ARR / pause / rate buttons (existing) | Secondary pills in the card footer; the one primary action (e.g. "Issue clearance") uses the accent button; rate 1×/2×/4× uses the text-tab-with-underline pattern | |

---

## 9. Anti-patterns (each one breaks the look)

1. **Saturated blues / purples / teals** in chrome, charts or focus rings — the system has exactly one accent (orange) plus red/green for status; blue exists only as a tiny map marker.
2. **Heavy or coloured borders** (2px, `#333` solid outlines, orange card borders). Only 1px at ≤ 12 % white.
3. **Bright or blue-tinted backgrounds** (`#1e293b`, `#0f172a` style navy) — grounds are neutral `#0b0b0c → #1c1c1e`.
4. **Bold weights**: 600/700 titles, bold numerals. Display is 300, text 400, 500 only for the active tab and badges.
5. **Fully rounded cards** (radius ≥ 32) or sharp cards (radius ≤ 8). Cards are 20–24; pills are the only fully rounded shapes.
6. **Emoji, filled/duotone icons, 2px+ icon strokes**. Use 1.5px line icons at 16–20px.
7. **Gradient fills on charts, area fills > 4 % white, smoothed (bezier) sparklines, zero-based bar fills, thick bars** — bars are 2px lines, sparklines are jagged 1.5px.
8. **Coloured text for regular labels** (blue links, orange headings). Colour is reserved for data and status; hierarchy is done with white → grey steps.
9. **Uppercase tracking-heavy labels everywhere** (the current SKILL LEVEL / TRAFFIC style) — sentence case; caps only for micro-codes.
10. **Undarkened satellite tiles** (full-colour green/blue imagery) or a blue-tinted map veil; the map must read grey-green with V ≤ 35 %.
11. **Glass without blur**, or blur without the dark fill (washed-out translucent white), or glass stacked on glass.
12. **Drop shadows on solid cards**, inner strokes on tiles, visible dividers between every row.
13. **Focus rings in accent colours**, hover states that fill cards with solid grey, or pressed states that darken to black.
14. **Big numbers set uniformly white** — the trailing-group dimming (`--text-4`) and baseline-aligned small unit are mandatory.
15. **Toast/alert banners in solid red** — alerts are red-tinted cards (`--red-tint`) with a small red badge; the only solid red is the Ø18–22 badge/bullet.


---
# CRITIC ADDENDUM
# ADDENDUM — SKYCONTROL Design System (pixel-precision pass)

Numbered A1…A24. Each item states the gap, then the content to paste into the base document. Where the base document contradicts itself, the resolution here wins.

---

## A1. Resolved contradictions (these currently block a build)

| # | Where | Conflict | Resolution |
|---|---|---|---|
| 1 | §3 "Pills: height 32" vs §4.3 count pill 40 vs §4.10 status pill 30 vs §4.16 map pill 40 vs §4.18 buttons 36 | No pill height scale | Add scale: `--pill-xs: 24` (inline tags, callsign tag on radar), `--pill-s: 30` (status pills inside cards), `--pill-m: 36` (buttons, quick-command pills), `--pill-l: 40` (count pills, map pills, nav search, inputs), `--pill-xl: 44` (mobile buttons). §3 "32" is deleted. Padding-x = `height × 0.45` rounded to 2px: 24→10, 30→14, 36→16, 40→18, 44→20. |
| 2 | §4.11 vehicle card 300×440 vs §6 "2×2 vehicle-card grid (each 300 tall)" and left column inner width 400 | 2×300 + 12 gap = 612 > 400 | Two variants. **Compact strip** 194×176 (two per row, 12 gap, fits 400): header + status row + plate chip only, no illustration/mini-map/timeline. **Selected strip** spans both columns: 400×440, full §4.11 content, `.glass--lit`. Grid uses `grid-template-columns: 1fr 1fr; .strip--selected { grid-column: 1 / -1 }` and the selected card always moves to the first row. |
| 3 | §4.1 "title-m `--text-2` → white on hover" vs "Title colour: `#ffffff` on glass cards" | Two rules | Title is `--text-1` when the card has **no** display number; `--text-2` when it has one (the number takes the white). Hover does **not** change the title colour (hover is border + lift only). Applies to solid and glass alike. |
| 4 | §7 hover lift on cards vs §9-12 "no drop shadows on solid cards" | Lift with no shadow reads as a jump | Solid cards: hover = `translateY(-1px)` + background `--bg-1` → `#151515`; **no shadow ever**. Glass cards: hover = `translateY(-2px)` + border `.16` + sheen 60 %. Non-interactive cards (charts, tables) have **no hover**. Only cards that open something ("↗") lift. |
| 5 | Header "Mobile uses the same tokens at ×1.25" vs explicit mobile sizes (radius 24 not 25, header buttons 56 not 50, pills 40 not 40) | Multiplier is wrong for shape tokens | Rule: **type scale** ×1.25 on mobile (rounded to whole px); **shape/space tokens** use the explicit mobile column in A5, never the multiplier. |
| 6 | §4.16 "Three 44px circles stacked horizontally" | "stacked" vs "horizontally" | Row, left→right: `−`, `⌖`, `+`. Horizontal. 8 px gap. Bottom-left at `left: map-left + 20px; bottom: 20px + (bottom card row height 250) + 12px` = bottom 282. |
| 7 | §2.2 "78.3 %" vs §8 "78.3%" | Space before % | **No space** before `%`; `body-s` unit set with `margin-left: 2px`. Space before every other unit (`ft`, `kt`, `nm`, `min`). |
| 8 | §8 "wireframe = side-profile aircraft silhouette (from `aircraftShapes.ts`)" | `aircraftShapes.ts` builds **top-down plan** polygons (`spanM × lengthM`, parts `body`/`engine`) and `drawShape` takes fill colours (`#fbbf24`). | The strip illustration is the **plan-view wireframe** of the actual type: `parts` drawn as closed paths, `stroke: rgba(255,255,255,.85) 1px`, `fill: none`, `stroke-linejoin: round`; `engine` parts at `rgba(255,255,255,.55)`. Nose points **up** (rotate so `-len/2` is at top). Add `shapeToWireSVG(icao)` returning `<path fill="none" stroke=…>` — `drawShape` fills are for the canvas radar only, and its default body colour changes to `#ffffff`. |
| 9 | §1.2 anti-pattern 11 "no glass stacked on glass" vs Warning panel (glass) containing red-tint alert items, popover on glass | Nested surfaces on glass | Surfaces **inside** a glass panel are plain `rgba()` fills with **no** `backdrop-filter`. Only one `backdrop-filter` per stacking branch. |
| 10 | §2.1 `font-feature-settings: "ss01"` | DM Sans `ss01` is undocumented for this purpose; risk of silently changing glyphs | Drop `ss01`. Use `font-feature-settings: "kern"; font-optical-sizing: auto;` and `tnum` only where §2.2 says tabular. |

---

## A2. Interaction-state matrix (missing everywhere; only hover was given)

All interactive components implement **all seven** states. Timings from §7 (`--t-fast` 120ms unless noted).

```css
/* Focus: keyboard only, never on mouse. One rule, sitewide. */
:focus { outline: none; }
:focus-visible { box-shadow: 0 0 0 1px var(--bg-0), 0 0 0 3px rgba(255,255,255,.45); }
/* On pills/circles the ring follows border-radius automatically via box-shadow. */
/* Inputs: focus-visible = border rgba(255,255,255,.28) (per §4.19) AND the ring above. */
```

| Component | Rest | Hover | Pressed (`:active`) | Focus-visible | Selected / on | Disabled | Loading |
|---|---|---|---|---|---|---|---|
| Nav tab (inactive) | `--text-2` | `--text-1`, no bg | `--text-1`, bg `rgba(255,255,255,.04)` pill | ring | = active tab (`--bg-3` pill, white 500) | `--text-5`, no hover | — |
| Primary button | `#fff` / `--bg-0` text | `#e8e8e8` | `#d4d4d4`, `scale(.98)` | ring | — | fill `rgba(255,255,255,.12)`, text `--text-4`, cursor `not-allowed` | text → 16px spinner (1.5px arc, `--bg-0`), width preserved |
| Secondary | glass `.08` | `.12` | `.16`, `scale(.98)` | ring | fill `--bg-3`, border `.16`, white | fill `.04`, border `.04`, text `--text-5` | spinner white |
| Ghost | transparent, `--text-2` | `.06` + white | `.10` | ring | `.10` + white | `--text-5` | — |
| Accent | `--orange-tint-08`, border orange .35, orange text | fill `.16` | fill `.24`, `scale(.98)` | ring **white** (never orange) | — | fill `.04`, border orange .15, text orange @ .40 | spinner orange |
| Danger | `--red-tint`, border red .35 | red .16 | red .24 | ring | — | text red @ .40 | — |
| Icon button | glass `.06` | `.12` | `.16` | ring | `--bg-3` | icon `--text-5` | — |
| Count pill | `--bg-2`, `--text-2` | `--bg-3`, `--text-2` | `--bg-4` | ring | `--bg-3`, white; number white 500 | `--text-5` | — |
| Segmented text tab | `--text-2` | `--text-1` | `--text-1` | underline `rgba(255,255,255,.45)` 1px | white + 1px white underline | `--text-5` | — |
| List row / strip | none | `rgba(255,255,255,.04)` r12 | `.06` | ring inset (`inset 0 0 0 1px rgba(255,255,255,.35)`) | `.glass--lit` (strip) / `.06` (row) | opacity .45 | skeleton (A12) |
| Table row | none | `rgba(255,255,255,.03)` | — | ring inset | `--orange-tint-08` band only when the row is the selected aircraft | — | — |
| Chart column | — | band at `orange @.04`, tooltip **not** shown | — | band `.08` (arrow keys move) | band `.08` + glow + tooltip | — | — |
| Toggle | off `.10` | off `.14` / on orange `.90` | knob `scale(.92)` | ring | on `--orange` | off `.05`, knob `rgba(255,255,255,.4)` | — |
| Text input | border `--line-strong` | border `.18` | — | border `.28` + ring | — | text `--text-5`, border `.06` | — |
| Text input **error** | border `rgba(251,10,8,.55)`, helper `body-s` `--red` 6px below, **no** red fill | same | — | border red .70 + white ring | — | — | — |
| Map control circle | glass `.10` | `.16` | `.22` | ring | ⌖ "follow on": `--bg-3` + icon `--orange` | icon `--text-5` | — |
| Chevron (expand) | `--text-2` | white | — | ring | rotated 180° when expanded (`--t-base`) | — | — |
| "↗" affordance | white | `translate(2px,-2px)` | `translate(3px,-3px)` | ring 2px offset | — | hidden | — |

Pressed transitions are `--t-fast`; release returns over `--t-base`. `cursor: pointer` on every row above; `cursor: default` on chart plots except columns.

---

## A3. Pill / button / control geometry (was partially given; now complete)

| Height | Padding-x | Icon | Icon gap | Font | Radius | Used by |
|---|---|---|---|---|---|---|
| 24 | 10 | 12 | 4 | `label-xs` | 999 | callsign tag on radar, inline chips (`DCT BIG`, `EXPD`) |
| 30 | 14 | 14 | 6 | `body-s` | 999 | status pills (AIRBORNE / GROUND / EMERG), signal chips |
| 36 | 16 | 16 | 8 | `body-m` | 999 | all buttons, quick-command pills, rate tabs |
| 40 | 18 | 18 | 8 | `body-m` | 999 | count pills, map pills, search, text inputs, selector |
| 44 | 20 | 18 | 8 | `body-m` | 999 | map control circles (icon only), mobile controls |

Leading-icon pills reduce padding-left by 2 px (36 → 14, 40 → 16). Trailing chevron pills: chevron 14 px, gap 6, padding-right reduced by 4.
Icon-only circles: 40 (nav), 44 (map), 56 (mobile). Icon sizes inside: 20, 18, 22.
Minimum hit target on touch: 44 × 44 via `::before` inset when the visual is smaller (24/30 pills).

---

## A4. Z-index tokens, layer ownership, scroll regions

```css
--z-map: 0; --z-map-overlay: 1;     /* SVG/canvas overlays inside the map element */
--z-float: 10;    /* floating cards, popover, map pills, map controls */
--z-nav: 20;
--z-menu: 30;     /* dropdowns, tooltips */
--z-sheet: 35;    /* mobile bottom sheet */
--z-modal: 40;    /* modal + scrim */
--z-toast: 50;
```
Scroll regions (each `overflow-y: auto`, scrollbar per §4.19, and a **12 px fade mask** at top and bottom edges `mask-image: linear-gradient(transparent, #000 12px, #000 calc(100% - 12px), transparent)`): left column; Warning panel body (max-height `calc(100vh − 84 − 20 − 250 − 12)`, header stays); radio log; traffic list. The page itself never scrolls on desktop (`html,body{height:100%;overflow:hidden}`); on mobile the page scrolls, the map screen does not.

---

## A5. Breakpoints and explicit mobile/tablet tokens (only 1440 and 390 were given)

| Token | ≥1440 desktop | 1024–1439 laptop | 768–1023 tablet | ≤767 mobile |
|---|---|---|---|---|
| Outer gutter | 20 | 16 | 16 | 16 |
| Nav height | 64 | 56 | 56 | 56 (header) |
| Left column | 440 | 380 | hidden → becomes a **left drawer** 360 w (secondary button "Traffic" in nav opens it) | full-width screen "Traffic" tab |
| Warning panel | 400, floating | 340, floating | bottom sheet | bottom sheet |
| Bottom card row | 560 + 400 | 480 + 340 (`display-xl` → 36) | hidden; reachable from "Analytics" tab | Analytics tab |
| Map title | `display-xl` 44 | 36 | `title-l` 20 in header | `title-l` centred in header |
| Card radius | 20 | 20 | 24 | 24 |
| Card padding | 20 | 20 | 24 | 24 |
| Type scale | ×1 | ×1 | ×1.125 | ×1.25 |
| Map controls | 44 | 44 | 44 | 56, right-bottom (thumb reach), 16 from edges |
| Vehicle/strip grid | 2 cols | 2 cols | 2 cols | 1 col |
| Min supported width | — | — | — | 360 (below 360, gutter drops to 12) |

Bottom sheet: snap points 88 px (peek: title + count), 50 %, 92 %; grab handle 40 × 4 `rgba(255,255,255,.2)` radius 2 centred 8 px from top; sheet radius 24 top only; `--glass-fill-strong`; drag threshold 24 px; spring 320 ms `--ease-out`.

---

## A6. Iconography — exact library and name map (base doc says "Phosphor Light / Lucide" with no names)

**Lucide** (`lucide-react`), `strokeWidth={1.5}`, `absoluteStrokeWidth`, `size` per context. Replace every Unicode/emoji glyph in the current code (`◆ ⌂ ⚙ 🔊 🔇 ✕ ▲ ▼ ◀ ▶ ◎ ⚠`).

| Meaning | Lucide name | Size |
|---|---|---|
| Open detail "↗" | `arrow-up-right` | 18 |
| Expand/collapse | `chevron-up` / `chevron-down` | 16 |
| Dropdown pill | `chevron-down` | 14 |
| Close | `x` | 16 |
| Search | `search` | 20 |
| ADS-B feed | `radio-tower` | 20 |
| Radio / PTT | `headphones` | 20 |
| Alerts | `bell` | 20 |
| Settings | `settings-2` | 20 |
| Home | `house` | 20 |
| Under control (stat) | `circle-check` (filled variant: draw a 20 px `--green` circle, white `check` 12 px 2 px stroke inside) | 20 |
| Conflicts (stat) | `triangle-alert` (filled `--red` triangle, white `!` 2 px) | 20 |
| Group: Separation | `git-compare-arrows` | 18 |
| Group: Runway | `plane-landing` | 18 |
| Group: Emergency | `siren` | 18 |
| Group: Wake | `wind` | 18 |
| Recommend | `sparkles` | 18 |
| Late (table) | `clock` | 14 |
| Zoom | `plus` / `minus` | 18 |
| Recentre | `locate-fixed` | 18 |
| Layers | `map` | 18 |
| Selected aircraft pill | `plane` | 18 |
| Puck / heading | `navigation` (rotated) | 22 |
| Departure / arrival | `plane-takeoff` / `plane-landing` | 16 |
| Voice on/off | `volume-2` / `volume-x` | 20 |
| Pause / play | `pause` / `play` | 16 |
| Step alt/spd | `arrow-up` / `arrow-down` | 14 |
| Step hdg | `rotate-ccw` / `rotate-cw` | 14 |
| Send command | `corner-down-left` | 16 |
| Go around | `undo-2` | 16 |
| Mobile back | `arrow-left` | 22 |

Logo mark: 28 × 28 SVG, five bars 3 px wide, 45°, rounded caps, 4 px pitch, clipped to a 28 px rounded square (r 8), white. Provide as inline SVG; never a font glyph.

---

## A7. Stat tile — internal geometry (base gave only outer size)

200 × 104, padding 16, `position: relative`.
- Icon: 20 px at `top:16; left:16`.
- Label `body-m` `--text-2`: `left:16; bottom:16` (baseline sits 16 + descender).
- Number `display-l` 36/300 white: `right:16; bottom:12` (36 px cap-height box bottom-aligned with label baseline ±1 px), `tabular-nums` off.
- Zero-state (Conflicts 0): icon hidden, label and number `--text-3`.
- Conflict tile with n>0: additionally `box-shadow: inset 0 0 0 1px rgba(251,10,8,.25)` and number `--red`. This is the **only** tile allowed an inner stroke (replaces the old `.conflict-banner`).
- Number change: count-up 600 ms; decreasing values do **not** animate.

---

## A8. Charts — exact plot geometry (base doc gives styles but no layout)

Common: SVG, `viewBox` = pixel size, `shape-rendering: crispEdges` for grid only. Plot bleeds to card padding edge (left/right inset 0). Y-axis label column **right**, width 44 px, labels `body-s` `--text-3` right-aligned, vertically centred on their gridline. X labels 12 px below plot bottom, centred on column/tick. Number format: `50k`, `100k`, `150k` (no space); percent `25%`.

**Bar chart (Movements per hour)**: plot 220 tall; n columns = 12 (Hour view: 5-min buckets), 8 (Shift), 24 (Day), 7 (Week); column pitch = plotWidth / n; the orange bar at `pitch/2 − 4.5`, grey at `+2.5` (7 px apart, centre-to-centre 7). Bars `<line>` 2 px `butt`. Min bar length 4 px (values with zero range still show). Selected column band 200 ms; tooltip `min-width: 84`, padding 0 12, height 32, centred over the orange bar, `bottom = barTop − 8`, clamped 8 px inside plot edges. Tooltip text: value `tabular-nums` + optional delta `--text-2` ("142 ▲4"). Hover on a column shows band @ .04 only; click selects. Keyboard: `←/→` moves selection when plot focused.

**Sparkline (Slot adherence / Skill)**: plot 120 tall; samples every minute → one point per px (no smoothing, no `stroke-dashoffset` beyond initial draw). Dots Ø7 at target crossings, `fill #fff`, 1 px `--bg-1` ring. Band fill spans crossing x-range, full plot height. Current-value marker: last point gets Ø5 white dot with 12 px `rgba(255,255,255,.25)` halo, pulsing 1.6 s.

**Step chart (Movements today)**: buckets 3 h → 5 columns; value line spans `x0+4 → x1−4`; label 6 px above line, left-aligned +4; delta 6 px below.

**Ruler (table cells, timeline)**: ticks 1 px wide, 6 px tall, every 6 px; every 5th tick 10 px tall @ `.20`.

Canvas radar text and SVG chart text use the same `--font`; wait for `document.fonts.ready` before the first canvas frame; canvas scaled by `devicePixelRatio` (cap 2), line widths in CSS px.

---

## A9. Number, unit and text formatting rules (absent; ATC values will otherwise render 6 different ways)

| Datum | Format | Example | Colour split |
|---|---|---|---|
| Altitude < 18,000 | thousands comma, ` ft` | `5,000 ft` | "5," white / "000" `--text-4` / "ft" `body-s` `--text-2` |
| Altitude ≥ 18,000 | `FL` + 3 digits | `FL350` | "FL" `--text-2` / "350" white |
| Ground | `SFC` | | `--text-3` |
| Speed | integer, ` kt` | `250 kt` | all white, unit `--text-2` |
| Heading | 3-digit zero-padded, `°` on strip only | `HDG 270`, `HDG 005` | "HDG" `--text-3` |
| Distance | 1 decimal, ` nm` (lowercase) | `3.1 nm` | |
| Vertical rate | signed, `±1,200 fpm` | | rate < 0 on descent shows `−`, never `-` (U+2212) |
| Squawk | 4 digits, `tabular-nums` | `4523` | emergency codes `7500/7600/7700` in `--red` 500 |
| Time | `HH:MM:SS` + `Z`, 24 h | `14:07:53Z` | "Z" `--text-3` |
| Timestamp (last tx) | `DD.MM.YYYY, HH:MM:SS` | `08.03.2026, 02:37:53` | `--text-3` |
| Relative | `4m ago`, `12s ago`, `1h 04m ago` | | |
| Delta | `±2min`, `+1min`, `−2min` | | late (positive) orange, early/on-time `--text-2` |
| Counts | plain integer, thousands comma ≥ 1,000 | `122,580` | big-number split at the first comma |
| Percent | 1 decimal, no space | `78.3%` | |
| Callsign | uppercase, never truncated, `tabular-nums` off | `BAW123` | |
| Runway | `27L` (uppercase suffix) | | |
| Empty value | `—` (em dash) `--text-4` | | never `-`, `N/A`, `???` |
Truncation: single-line `text-overflow: ellipsis` for airline names and route strings only; titles, callsigns, values never wrap or truncate — the container grows.

---

## A10. Radar layer (canvas/SVG) — the base doc has one sentence

**Aircraft symbol** (all views): chevron `navigation` glyph 12 px, 1.5 px stroke, `#fff`, rotated to heading, `translate(-50%,-50%)`. Ground view: 12 px; approach view: 10 px. Selected: replaced by the **puck** (§4.15, Ø56) — but Ø40 in approach view.
**Data block**: anchored at 45° up-right of the symbol, leader line 1 px `rgba(255,255,255,.35)` from symbol edge to block corner, length 18 px (auto-flips to up-left within 60 px of the map's right edge). Block = pill 24 tall `--bg-3 @ .80` (`rgba(37,38,40,.80)`, **no blur**), padding 0 10, `label-xs` white callsign, 500 weight; second line only when airborne: `body-s`... no — keep one line: `BAW123 · 050 · 25` (alt ÷100, speed ÷10) with the two numbers `--text-2`, dots `--text-4`. Block width by content. Block never overlaps another block: resolve by nudging 4 px steps around 8 candidate angles, selected aircraft wins.
**Trail**: last 60 fixes as Ø2 dots, `rgba(255,255,255,.35)` fading linearly to `.05`; no line.
**Heading vector**: 1 px `rgba(255,255,255,.35)`, length = 1 min of travel at current GS.
**States**:

| State | Symbol | Data block | Extra |
|---|---|---|---|
| Rest | white | as above | |
| Hover | white, symbol `scale(1.15)` | bg `--bg-3 @ 1` | cursor pointer |
| Selected | puck | bg `--bg-4`, callsign white, border 1 px `rgba(255,255,255,.18)` | separation ring 3/5 nm white dashed |
| Conflict | white symbol **plus** Ø24 `--red` ring 1.5 px, opacity pulse .6→1 @ 1.2 s | callsign `--red`, bg `--red-tint` over `--bg-3` | line 1 px `--red` dashed `4 4` to the paired aircraft with the separation `3.1 nm / 900 ft` in a 24-pill at midpoint; **never blink the row** (delete `.acft-row-conflict{animation:blink}`) |
| Emergency (7x00) | symbol `--red` | bg `--red @.85`, white text 500 | Ø32 red ring, static |
| Handed off / not mine | symbol `rgba(255,255,255,.45)` | text `--text-3`, bg `--bg-2 @.6` | no vector |
| Holding | white | suffix ` · HLD BIG` `--text-3` | racetrack 1 px dashed white .35 |
| Landed / at gate | symbol `rgba(255,255,255,.55)`, 10 px | block hidden until hover | |

**Ground chart**: runways fill `#2a2a2b`, edge 1 px `rgba(255,255,255,.14)`, centreline 1 px white `.35` dashed `12 8`, threshold bars 2 px white `.55`, runway ID `label-xs` white `.55` at each end rotated to runway heading; taxiways fill `#232324`, centreline 1 px `--lime-marker @ .5` (never yellow); hold-short lines 2 px `--orange @ .6` (this is the one permitted orange on the ground chart, it is "attention"); aprons `#1e1e1f`; gates Ø8 grey pins (§4.15 station pin at Ø20 for the selected gate); terminals `#1a1a1b` fill, no stroke; grass = map ground.
**Approach chart**: range rings every 5 nm, 1 px `rgba(255,255,255,.08)`, ring labels `label-xs` `--text-5` at 45°; extended centreline `--lime-marker` 2 px dashed `10 6` 10 nm; ILS feather (localizer ±2.5° wedge) `rgba(142,151,22,.06)` fill, no stroke; fixes = 8 px white `.55` triangle outline + `label-xs` `--text-3` name 6 px right; VOR = Ø10 hexagon `--blue-marker`; airspace boundary 1 px `rgba(255,255,255,.14)` dashed `2 6`; airport symbol = Ø14 circle 1 px white .55 with runway strokes.

---

## A11. Missing components — full specs

### A11.1 Dropdown menu (selector "BAW123 ⌃", "Satellite · Chart", airport picker, rate 1×/2×/4× on mobile)
Trigger: map pill (40). Panel: `--bg-2` solid (glass-less, because it sits over the map pill which is glass), radius 14, padding 6, `min-width` = trigger width, `max-width` 320, `max-height` 320 scroll, `box-shadow 0 12px 32px rgba(0,0,0,.5)`, border 1 px `--line-strong`, `top: trigger bottom + 6`. Item: 36 tall, padding 0 12, radius 10, `body-m` `--text-2`; hover `rgba(255,255,255,.06)` + white; selected: white + `check` 16 px right; disabled `--text-5`. Section label: `label-xs` `--text-4` 8 px 12 px. Divider 1 px `--line` 6 px margins. Enter 120 ms `opacity + translateY(-4→0)`; typeahead; `Esc` closes; arrow keys move; focus ring inset.

### A11.2 Modal / dialog (airport change confirm, settings, end-of-shift score)
Scrim `rgba(6,6,7,.72)` + `backdrop-filter: blur(6px)`. Panel `--bg-1` solid, radius 24, padding 24, width 440 (mobile: sheet), `box-shadow 0 32px 80px rgba(0,0,0,.6)`, border 1 px `--line`. Title `title-l` white; body `body-m` `--text-2` 12 px below; footer 24 px below, buttons right-aligned 8 px gap: Ghost "Cancel" + Primary/Danger. Enter 200 ms `scale .96→1 + opacity`; scrim 200 ms. Focus trapped; `Esc` = cancel.

### A11.3 Toast
`--bg-3` solid, radius 14, padding 12 16, `min-width` 280, `max-width` 420, border 1 px `--line-strong`, shadow `0 12px 32px rgba(0,0,0,.5)`, `bottom: 20; left: 50%` on desktop (`bottom: 16 + safe-area` mobile). Leading icon 18 px: info = `--text-2`; success = `--green`; attention = `--orange`; error = `--red` (icon only — background never coloured). Text `body-m` white; optional action Ghost button right. Stack upward 8 px gap, max 3. Auto-dismiss 5 s (error 8 s), pause on hover. Enter `translateY(8→0)` 200 ms; exit fade 120 ms.

### A11.4 Stepper row (ALT / SPD / HDG in the expanded strip)
Row 36 tall: label `label-xs` `--text-3` uppercase width 36 left (ATC codes are permitted caps per `micro-caps`), then Secondary pills 36 tall 8 px gap, `tabular-nums`, `min-width` 56: `▲3k ▲1k ▼1k ▼3k` etc. Icon 14 + value. Pressed = command issued: pill flashes fill `.16` → rest over 320 ms and the value in the metrics grid count-ups. `EXPD` toggle uses Accent style when on. ILS/HOLD pills: Secondary; assigned/selected = `--bg-3` + white; `GO AROUND` = Danger button, full width, 36. Rows 8 px apart; section 16 px below the metrics grid.

### A11.5 Quick-command grid (`.gnd-grid`)
3 columns, 8 px gap, Secondary pills 36, `body-m`, text sentence case ("Taxi 27L", "Line up", "Take off", "Hold position", "Push back", "Cross 09L"). Disabled when the command is invalid for the phase. Never uppercase, never blue.

### A11.6 Command line (`.cmd-form`)
Text input 40 (A3) full width of the footer, glass on map / `--bg-2` on shell, prefix `›` replaced by `terminal` icon 16 `--text-3` at padding-left 14; input `body-m` white `tabular-nums` off; placeholder `--text-3` sentence case (`BAW123 heading 270 · ils 27L · hold BIG`); trailing Ghost icon button `corner-down-left` 32 inside the pill (right 4). Parse error: A2 input-error state, helper text `body-s` `--red` below-left ("Unknown command 'hedaing'"), input shakes ±3 px 240 ms. Accepted: input clears, border flashes `.28` → rest. Autocomplete: A11.1 menu above the input (`bottom: 46`), items = command + `--text-3` description. `Ctrl+K` focuses; `↑` recalls history.

### A11.7 Radio log (`.radio-log`)
Card `--bg-1` (shell) or `--glass-fill-strong` (over map), radius 20, padding 12 16, height 140 desktop, monospace **not** used. Line: `body-s` 1.5 lh, 4 px between lines; who-column 40 px `label-xs` 500: `ATC` white, `PILOT` `--text-2`, `SYS` `--text-3`; text `--text-2`, ATC lines white. Readback errors / "unable" lines: `--orange`. Emergency declarations: `--red`. Newest at bottom, auto-scroll unless the user scrolled up (then a 24-pill "↓ 3 new" appears bottom-centre, Secondary style). Fade mask A4.

### A11.8 Status bar (footer)
Height 40, `body-s`. Left: airport name `--text-2` + ICAO white `tabular` 8 px gap; score chip = 30-pill `--bg-2` "Score" `--text-3` + value white + "HI 1,240" `--text-3`. Right: airport picker = segmented text tabs (§4.6) with ICAO codes; voice toggle = icon button 32; clock `body-m` white `tabular-nums` + `Z` `--text-3`. On desktop this row moves into the **nav right cluster** (clock before the avatar); the footer disappears.

### A11.9 Rate control (1× 2× 4×) and pause
Segmented text tabs (§4.6) `tabular-nums`; pause = icon button 36 to their left; paused state: whole map gets `filter: saturate(.8)` and a 30-pill "Paused" `--bg-3` at top-centre of the map, 12 px below the nav.

### A11.10 Empty / loading / error states (none in base)
- **Skeleton**: blocks `rgba(255,255,255,.06)` radius 8, shimmer `rgba(255,255,255,.10)` sweep 1.4 s; text lines 12 tall, big numbers 36 tall × 120 wide; never spinners inside cards.
- **Loading overlay** (airport load): scrim `--bg-0 @ .92`, centred logo mark 40 px + `body-m` `--text-2` "Loading EGLL…" + 200 × 2 progress rule `rgba(255,255,255,.12)` with white fill; exit 320 ms fade.
- **Empty list** (`No traffic`): centred, icon `plane` 24 `--text-4`, `body-m` `--text-3` "No traffic", `body-s` `--text-4` "Use + DEP or + ARR"; 40 px vertical padding.
- **Empty detail panel**: icon `mouse-pointer-click` 24 `--text-4`, `body-m` `--text-3` "Select an aircraft on the map or in the list". Panel keeps its size.
- **Feed lost** (ADS-B): nav icon button fill `--red-tint`, icon `--red`; toast error; map veil +.10.
- **Error card**: card keeps layout, body replaced by `body-s` `--red` message + Ghost "Retry" button; card border 1 px `rgba(251,10,8,.25)`.

---

## A12. Aircraft strip card (§4.11 for ATC) — content, geometry, states

**Compact strip 194 × 176** (padding 16):
1. Row 1 (h 20): callsign `title-m` white; right: `A`/`D` 24-pill (`plane-landing`/`plane-takeoff` icon 12 + letter) `--bg-3`.
2. Row 2 (+4): type + airline `body-s` `--text-3` (`A320 · British Airways`, ellipsis).
3. Row 3 (+12, h 30): status pill left (AIRBORNE/GROUND/EMERG); right `body-s` white `tabular` altitude or `SFC`.
4. Row 4 (+12, h 28): plate chip group (circle Ø28 wake letter + pill 72 × 28 squawk).

**Selected strip 400 × 440** (`.glass--lit`, padding 20), vertical budget top→bottom: header 24 (callsign + timestamp `body-s` `--text-3` right; "↗" top-right) → 16 → illustration 128 (plan-view wireframe A1-8, `max-width` 70 %, plate chip group centred over the fuselage) → 16 → status row 30 → 16 → mini-radar 120 (`--bg-1`, radius 14, last-60-fix trail + cleared route white 2 px, own-symbol at centre, north-up, 3 nm across) → 16 → timeline 34 (labels 13 + ruler 16 + 5). Sum = 24+16+128+16+30+16+120+16+34 = 400 + 40 padding = **440**.
Timeline thumb x = `pad + (now − ETD)/(ETA − ETD) × (innerW − 32)`, clamped; ground phase uses pushback → takeoff.
Signal chips: `ADS-B` (`radio-tower`) icon `--orange` when a fix arrived < 5 s ago else `--text-3`; `ILS` (`plane-landing`) icon `--green` when `ilsCaptured` (`LOC` label until `gsCaptured`); `COMM` (`headphones`) `--green` when on frequency.
Strip states: rest / hover / selected (A2 list row) + **conflict**: 1 px `rgba(251,10,8,.35)` border + callsign `--red`, no animation; **emergency**: status pill `EMERG` red + Ø8 red glowing dot before the callsign; **stale** (no fix > 30 s): whole card opacity .55, timestamp `--orange`.
"↗" on the selected strip opens the **expanded detail panel** = right panel 400 wide, `top:84; right:20; bottom:20`, glass-strong, padding 24, sections: header (callsign `title-l`, sub `body-s` `--text-3`, close `x` icon button 32 right) → metrics grid 2 × 3 (cells: label `label-xs` `--text-3` + big-number pattern at `display-m` 28) → tag row (24-pills) → route line `body-s` (`EGLL → EDDF · BIG · via 27L`, fixes white, rest `--text-3`) → divider → stepper rows (A11.4) or quick-command grid (A11.5) → GO AROUND. Panel scrolls with fade mask. It replaces the Warning panel while open (Warning collapses to a 40-pill "Alerts 3" at its top-right anchor; badge pulse continues).

---

## A13. Alerts panel — severity, sizing, behaviour (base has one severity)

| Severity | Group | Item fill | Badge | Header count | Sound |
|---|---|---|---|---|---|
| Critical | Emergency, Runway incursion | `--red-tint` (.12) | Ø22 `--red` glowing (`--red-glow`) | `--red` numeral | chime once |
| Warning | Separation, Wake | `--red-tint` (.08) | Ø22 `--red` no glow | white numeral | — |
| Advisory | Slot / sequencing suggestions | `--orange-tint-08` | Ø22 `--orange-tint-20` ring 1 px orange .35, numeral `--orange` | `--text-2` | — |
| Info | Resolved, handoffs | `rgba(255,255,255,.04)` | Ø22 `--bg-4`, numeral `--text-2` | `--text-3` | — |

Panel: collapsed = header only (height 72: 24 pad + 24 title + 24 pad), chevron rotates 180°; expanded max-height A4; groups ordered by severity then time; item enter from top 200 ms with height animation (`grid-template-rows 0fr→1fr`); resolved items slide to Info and fade after 30 s. Item hover `rgba(255,255,255,.03)` over its tint; item click toggles expanded (chevron rotates). "Recommend" row is an **Accent button** 36 (full text: `BAW123 turn left heading 270`), pressed → command issued, row becomes Info with `check` icon. Max 3 expanded at once (oldest collapses). Bell badge = Critical + Warning count, `99+` cap, `label-xs` 500 at 11 px on Ø18 (note: white on `#fb0a08` is 4.1:1 — accepted only because it is a ≤ 2-glyph badge; never set body text white on solid red).

---

## A14. Table (§4.14) — columns, alignment, sorting, sticky

Card inner width 520: "Flight" column 148 (plate chip group), then n runway/fix columns equal width, `min-width` 64, values right-aligned inside a 56-wide cell `tabular-nums`. Header row 28 tall, `label-xs` `--text-4`, sticky (`position: sticky; top: 0; background: var(--bg-1)`); header hover `--text-2`; sortable header shows `arrow-up`/`arrow-down` 12 px right after the label when sorted (only one column). Row 44; selected-aircraft row gets `--orange-tint-08` full-row band radius 10; row hover `.03`; row click selects the aircraft. Overflow: horizontal scroll on the table body only, first column sticky (`left:0`, same bg). Max 8 rows visible, then scroll. Empty: single row `--text-4` "No slot deviations".

---

## A15. Nav bar — exact positions and states

Desktop 1440: logo 28 px centred vertically at x 24–52; tabs container starts x 104; each tab = text `body-m` with 10 px 22 px padding box (height 40) so the active pill fits around it without shifting siblings — **inactive tabs also reserve the pill box** (transparent); gap 32 text-to-text = 32 − 44 = the pill boxes touch at −12, so set `gap: 0; margin: 0 -6px` → simpler: `gap: 32px` on the text and pills are drawn via `::before` inset `-10px -22px`. Badge on bell: Ø18 at `top:-4; right:-4`. Right cluster from the right edge: avatar 40 at x 1376–1416 (right gutter 24), gap 8, clock (desktop only, `body-m` white tabular), bell 40, headset 40, radio-tower 40, search 320 × 40. Search focus: width → 400 over 200 ms, placeholder → "Callsign, squawk, gate…". Search results = A11.1 menu below (items: callsign white + type `--text-3` + phase 24-pill right). Active tab change: pill slides via FLIP 200 ms `--ease-inout`. `Alt+1…5` switches tabs.

---

## A16. Glass — fallbacks and performance rules (missing)

```css
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .glass { background: rgba(24,24,26,.92); }           /* strong opaque fallback */
}
.glass { will-change: transform; transform: translateZ(0); contain: paint; }
```
Max **6** `backdrop-filter` surfaces on screen at once (nav search + 3 icon buttons count as 1 group by wrapping them in one glass strip on low-power devices: `@media (max-resolution: 1.5dppx)` or `navigator.hardwareConcurrency < 6` → wrap). Never animate `backdrop-filter` or `filter` on glass. Cards over the **MapLibre canvas** must sit in a sibling layer (not inside the map container) or the blur samples a stale frame.

---

## A17. Contrast floors and colour usage rules (missing)

On `--bg-1`: `--text-2` 11.3:1, `--text-3` 5.2:1, `--text-4` 3.0:1, `--text-5` 1.9:1, `--orange` 8.2:1, `--green` 9.1:1, `--red` 4.6:1.
Rules: `--text-4`/`--text-5` are **decorative only** (trailing digits, far ticks, disabled) — never the sole carrier of a value or a label; interactive text never below `--text-2`; `--red` text ≥ 13 px only; on glass over bright map, promote `--text-3` → `--text-2` (`.glass { --text-3: #a9a9a9 }`). `::selection { background: rgba(245,147,63,.30); color:#fff }`; `caret-color: #fff`; links inside text: white + 1 px underline `rgba(255,255,255,.35)`, hover underline white — never blue.

---

## A18. Typography — loading, metrics, line rules (missing)

```css
@font-face fallback: font-family "DM Sans Fallback"; src: local("Arial"); size-adjust: 104%; ascent-override: 92%; descent-override: 24%; /* prevents CLS */
html { font-size: 16px; }  /* all px tokens are literal px; do not convert to rem except in .settings */
h1..h6, p { margin: 0; }  /* spacing only via tokens */
```
Google Fonts request adds `&display=swap`. Line-height rules: single-line UI = tokens in §2.2; multi-line body (alert descriptions, recommendations) = `body-m` at 1.5. Max line length in panels 60 ch. Titles never wrap on desktop (`white-space: nowrap`), wrap on mobile. Letter-spacing on numerals at `display-*` is `−0.02em` **including** the dimmed group (do not reset it on `.kpi-lo`).

---

## A19. Motion — additions

- Aircraft position: interpolate between engine ticks with `requestAnimationFrame` lerp (canvas), never CSS transitions on canvas objects; SVG overlays (`puck`, ring) `transition: transform 1s linear`.
- Map pan to selection (⌖): `easeTo` 600 ms `--ease-inout`, zoom unchanged.
- Strip card layout change (compact ↔ selected): FLIP 320 ms `--ease-out`; other cards in the grid reflow with the same easing.
- Data-block re-positioning (de-overlap): 200 ms ease; no more than one re-position per 2 s per aircraft.
- Alert critical enter: item scale `.98→1` + red badge ring pulse ×2; panel header count "bump" `scale 1→1.15→1` 240 ms.
- Conflict pair line: `stroke-dashoffset` crawl −8 per 1 s; opacity pulse shared with ring.
- `prefers-reduced-motion`: puck rotation snaps, ring crawl stops, pulses become static rings, count-ups become instant.

---

## A20. Keyboard, kbd rendering, shortcuts (missing)

Global: `Ctrl+K` search/command, `Esc` deselect/close, `Alt+1…5` modes, `Space` pause, `[`/`]` rate, `↑/↓` in traffic list, `Enter` select, `Tab` order: nav → left column → map controls → floating cards → right panel → footer. Kbd hints inside placeholders stay plain `--text-3`; kbd hints in menus/tooltips render as `label-xs` `--text-3` inside a 20-tall 2 px-radius box `rgba(255,255,255,.06)` padding 0 5 (the only non-pill chip; keep it ≤ 3 glyphs).

---

## A21. Mode-specific layout deltas (Ground / Tower / Approach)

| Region | Ground | Tower | Approach |
|---|---|---|---|
| Map | satellite (§5) zoomed to aerodrome | satellite, runway-centred | vector "chart" theme (§5), range rings, 40 nm |
| Count pills | Taxiing · Holding · At gate · Pushback | Departing · Arriving · On runway · Line-up | Airborne · Descending · Holding · On ILS |
| Sparkline card | Taxi-time vs target | Runway throughput vs target | Slot adherence |
| Bar chart | Movements per 5 min | Movements per hour | Arrivals vs departures per hour |
| Table | Gate / hold deviations | Runway slot deviations | Fix ETA deviations |
| Radius ring | none | none | separation ring |
| Extra overlay | hold-short bars, taxi route | runway occupancy band (2 px `--orange @.6` along the runway while occupied) | ILS feather, extended centreline |

---

## A22. Settings page & home page (referenced in code, unspecified)

Settings: single column 640 wide centred, `title-l` "Settings", sections as solid cards `--bg-1` radius 20 padding 20, rows = A17 list rows with a toggle / dropdown / stepper on the right; section gaps 12. Home: nav + centred hero `display-xl` "SKYCONTROL" (the one permitted uppercase title: it is a wordmark) + `body-m` `--text-2` sub + airport cards (§4.11 compact-strip size ×2: 400 × 176, glass over a darkened satellite thumbnail of each airport, ICAO `title-m`, name `body-s`, "↗").

---

## A23. Asset & CSS deliverables (so two engineers ship the same files)

- `tokens.css` (all `--` vars from §1, §3, A3, A4), `type.css` (classes `.display-xl … .micro-caps`), `components.css` (one class per §4/A11 component with the state selectors from A2), `map.css` (§5), `motion.css` (§7/A19).
- Aircraft wireframes: `public/aircraft/wire/<icao>.svg` generated by `shapeToWireSVG`, 240 × 240 viewBox, nose up.
- Icons: tree-shaken Lucide imports; a single `<Icon name size>` wrapper enforcing `strokeWidth 1.5`.
- Logo: `public/brand/mark.svg`.

---

## A24. Wrong or risky statements to correct in the base doc

1. §8 "side-profile silhouette from `aircraftShapes.ts`" — it is plan-view (A1-8).
2. §2.1 `ss01` — remove (A1-10).
3. §4.15 puck "centred white navigation-arrow glyph 22 px" — in approach view the puck is Ø40 with an 18 px glyph; state it.
4. §4.9 "avatar 40 px circle photo" — the controller has no photo by default: fallback = Ø40 `--bg-3` with initials `body-s` 500 white.
5. §4.12 numbered badge "glowing variant on mobile" — glow is by **severity**, not by platform (A13).
6. §6 "Warning panel `top:84`" while the map title sits at y 88 with `display-xl` 44 — they overlap only if the map is < 1000 wide; at 1024 the title max-width is `map-width − 400 − 60` and truncates the sub-line, never the title.
7. §1.3 `--text-4` for "table headers" conflicts with A17's floor — table headers use `--text-3`; `--text-4` is for trailing digits only. Update §4.14 accordingly.
8. §3 "Badge: 18 px circle … on a 40 px button" and §4.12 "badge Ø22" — two badge sizes are intentional: Ø18 nav counter, Ø22 alert index. Name them `--badge-s: 18`, `--badge-m: 22`.
