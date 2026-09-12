# SkyControl — Interaction Model Specification (Click-to-Command)

**Scope.** One game screen, three positions (Ground · Tower · Approach), one command grammar reachable by click, keyboard, or voice. Modelled on Tower!Simulator 3's phase-gated command panel ("commands are made available in a logical way, following the progress of each airplane"), Endless ATC's gesture layer (drag-to-heading, wheel-to-altitude, OK/Cancel commit), and VRC/vStrips strip-bay conventions (bays per position, drag with insertion line, annotation boxes, push to next bay).

**Grounding in the current code.**
- Phases come from `/root/atc/src/lib/sim/types.ts` (`parked | pushback | taxi | hold_short | lineup | takeoff | climb | cruise | descent | approach | landing | rollout | arrived | departed`). This spec adds three: `startup`, `go_around` (today `initiateGoAround()` in `engine.ts` re-uses `climb`), and an `emergency` substate object that overlays any phase.
- Engine verbs that exist today (`/root/atc/src/lib/sim/engine.ts`): `cmdPushback, cmdTaxiTo(dest, via), cmdHoldShort, cmdCross, cmdLineUp, cmdTakeoff, cmdClearedLand, cmdHeading(hdg, dir), cmdAltitude(ft, expedite), cmdSpeed, cmdExpedite, cmdILS(rwy), cmdDirect(fix), cmdHold(fix, inbound, dir), cmdGoAround`. Anything marked **(NEW)** below is an engine addition; the text grammar in `/root/atc/src/lib/sim/commands.ts` must grow to match so that click, typed, and STT inputs share one tree.
- The current `/root/atc/src/app/atc/page.tsx` (left list · canvas · right panel · bottom log) is replaced by the architecture in §2; its `quick()` buttons become tree leaves.

Design tokens referenced throughout: glass panel = `rgba(9,14,22,.72)` + `backdrop-filter: blur(18px)` + 1 px `rgba(120,160,255,.18)` border + 12 px radius (matches `refrence/design_language/*` frosted cards). Fonts: UI = system sans; data = mono. Colours: DEP amber `#f59e0b`, ARR cyan `#38bdf8`, VFR/GA green `#22c55e`, EMERG red `#ef4444`, warn `#fb923c`, info `#60a5fa`, ok `#34d399`.

---

## 1. THE COMMAND TREE

### 1.1 Mechanic

```
select aircraft ──▶ CONTEXT PANEL (only valid actions) ──▶ action ──▶ param picker(s) ──▶ CONFIRM (+ add part) ──▶ TRANSMIT
      ▲                                                                                                          │
      └────────────────────── readback (typed out after pilot delay) ◀── engine applies after PILOT_DELAY_S ◀────┘
```

Rules that never change:
1. **The panel is phase-gated.** `actionsFor(aircraft)` returns only actions whose `valid(phase, state)` is true; actions that are *nearly* valid render **disabled with a reason** (§9). Actions that are impossible for the phase are not rendered at all.
2. **Every action is a linear stepper**: `Action → Step 1 → Step 2 … → Confirm`. Steps have a default (pre-selected, shown as a chip), so the fast path is `hotkey → Enter → Enter`.
3. **One grammar, three inputs.** Clicking builds a `CommandAST`; typing in the command line parses to the same AST; STT text parses to the same AST. Transmission text and readback text are generated from the AST, so all three paths produce identical radio lines.
4. **Nothing transmits without Confirm** except drag gestures with "instant vectors" enabled in Settings (off by default) and `Ctrl+Enter` (power user: skip confirm).
5. **Pilot delay is sacred.** The engine's `PILOT_DELAY_S` gap is the undo window (§1.5).

### 1.2 Picker types (shared components)

| Picker id | Used for | UI | Keyboard | Validation surface |
|---|---|---|---|---|
| `picker-runway` | expect/assign/ILS/land/takeoff runway | Row of runway-end chips grouped by physical runway; active-for-dep / active-for-arr badges; wind component (head/cross kt) under each chip; disabled chips show reason ("H not permitted", "closed", "inspection") | `1–9` selects nth chip; `←/→`; `Enter` | weight-class table (`engine.weightsFor`), runway status, wind |
| `picker-taxiroute` | taxi to runway/gate/point, re-route | Map enters **route-build mode**: tap taxiways/holding points/runway entries in order; chips fill a route bar ("A · B · hold short 27L"); "AUTO" chip asks `findPath`; "CLEAR"; destination chip (runway picker or gate picker); optional pills: *hold short of ▾*, *cross runway ▾*, *intersection ▾* | Type taxiway letters (`A`, `B`, `Space`), `Backspace` removes last chip, `Enter` accepts; `Tab` cycles destination/route/hold | `routeVia` reachability, active-runway crossing without clearance → auto-inserts *hold short* pill |
| `picker-heading` | headings, after-departure headings, hold inbound course | Compass dial (drag needle; ticks every 10°, labels every 30°); centre readout `240`; `L`/`R`/`shortest` segmented control; ±5/±10 nudge; direct type-in | Digits type heading; `←/→` −/+5, `Shift+←/→` −/+10; `L`/`R` sets turn dir; `Enter` | 001–360; `L`/`R` shows the resulting turn arc on the map live |
| `picker-altitude` | climb/descend/maintain, "climb to" on departure, MSA info | Vertical ladder 0…FL200 with 1000-ft rungs (500 ft below 10 000 if `Shift`); current alt marker; cmd alt marker; shaded bands: below MSA/MVA (red), above type ceiling (grey), glideslope-intercept band when an ILS is armed (blue); `EXPEDITE` toggle | Digits (`3` → 3000, `35` → 3500, `130` → FL130); `↑/↓` ±1000, `Shift+↑/↓` ±500; `E` expedite; `PgUp/PgDn` jump 3000; `Enter` | min = MSA of area / 1000 ft floor; max = `perf.ceiling`/TMA cap FL130 for departures per approach_atc.md §9 |
| `picker-speed` | assign speed | Horizontal chip rail 140→300 kt in 10-kt steps; envelope shading from `perf` (below `approachSpeed` disabled; above `maxAirspeedTMA` disabled); quick chips `160 · 180 · 210 · 250 · final approach speed · resume normal` | Digits; `←/→` ±10; `Enter` | ≤250 below FL100 (warn), envelope (block) |
| `picker-fix` | direct-to, hold fix, expect-fix | Searchable list of `RadarBeacon`s sorted by bearing from aircraft (with bearing/distance); map fixes pulse while list is open; click fix on map = select | Type letters to filter; `↑/↓`; `Enter` | fix in db |
| `picker-hold` | holding pattern | Composite: fix (picker-fix) → inbound course (picker-heading, default = bearing to fix or published `holdHeading`) → turns `L/R` (default R) → leg `1 min / 1.5 min / 4 NM` → EFC time chip (+10/+20 min); racetrack previewed on map live | `Tab` between fields | inbound 001–360; fix in db |
| `picker-direction` | vacate left/right, next exit left/right, turn direction, pushback facing | Two big chips with arrows (`◀ LEFT`, `RIGHT ▶`), optional 4-way for pushback facing (N/E/S/W) | `L`/`R` or `←/→`; `N/E/S/W` | none |
| `picker-taxiway` | exit at, hold short of taxiway, hold at intersection | Chips of taxiways along the aircraft's current/planned path first, then all; map highlights the candidate as you hover | Letters; `Enter` | taxiway exists on airport (`air.taxiwayNodes`) |
| `picker-gate` | taxi to stand | Terminal-grouped stand list; free stands white, occupied grey ("occupied by …"), assigned stand pre-selected | Type ref; `Enter` | stand free |
| `picker-position` | handoff/contact | Chips `GROUND 121.9 · TOWER 118.5 · DEPARTURE 120.4 · APPROACH 119.7` (from airport data); the logical next position is pre-selected | `1–4`; `Enter` | position exists; strict-frequency realism setting |
| `picker-vehicle` | dispatch services | Cards per vehicle with status (Station / En route / On scene); multi-select for ARFF | `↑/↓`, `Space` toggle, `Enter` | vehicle available |
| `picker-aircraft` | give way to / follow / behind landing traffic | Mini list of nearby aircraft (≤ 1 NM ground, or on final) with bearing; hovering highlights on map | `↑/↓`, `Enter` | aircraft exists |
| `picker-info` | report / request info from pilot | Multi-select chips (heading, position, airspeed, POB, fuel, nature of emergency, dangerous goods) | `Space` toggle; `Enter` | none |
| `confirm` | every action | Summary line rendered exactly as it will be transmitted; chips per part with `×`; `+ ADD PART` chips (§1.4); `TRANSMIT` (primary, `Enter`), `BACK` (`Backspace`), `CANCEL` (`Esc`). If any soft warning exists the button becomes amber "TRANSMIT ANYWAY" with a 600 ms press-and-hold; hard blocks replace the button with the reason. | `Enter`, `Backspace`, `Esc`, `+` | aggregated |

### 1.3 Root hotkeys (aircraft selected, no picker open)

Letters are stable across phases so muscle memory transfers; where a letter is unused in a phase it is simply absent.

`P` push/start-up · `T` taxi / amend route · `H` hold (short / position / at fix) · `X` cross / continue · `W` line up and wait · `O` cleared for takeoff · `L` cleared to land · `G` go around · `E` exit / vacate · `V` vector (heading) · `A` altitude · `S` speed · `D` direct · `I` ILS / approach clearance · `F` frequency / contact (handoff) · `R` report / say again · `Y` standby · `N` unable / negative (answers a pilot request) · `C` cancel a clearance · `M` emergency menu · `J` give way / follow · `U` undo (also `Ctrl+Z`) · `Enter` accept the highlighted default answer to a pilot request · `Esc` back/close · `Tab`/`Shift+Tab` next/prev aircraft (priority to REQ and alerts) · `` ` `` focus the command line · `Space` (hold) push-to-talk.

### 1.4 The tree, phase by phase

Notation: **Action [key]** → steps → *validation* → **TX** (what the controller voice says) / **RB** (pilot readback) · engine hook.

#### `parked` (at stand, engines off; pilot calls "request pushback" or "request start-up" after spawn)

| Action | Steps | Validation | TX / RB | Engine |
|---|---|---|---|---|
| **Pushback approved [P]** (stands with `needsPushback`) | ① `picker-runway` *expect runway* (default `plan.runway`, dep-active first) ② `picker-direction` facing (optional, default "as required") ③ confirm | Soft: aircraft/vehicle on the apron lane within 60 m behind → "tail traffic BAW12 pushing"; Hard: stand blocked by a vehicle | TX "{cs}, pushback approved, expect runway 27L[, face north]." RB "Pushback approved, expect runway 27L, {cs}." | `cmdPushback` + sets `plan.runway` |
| **Start-up approved [P]** (stands without pushback) | ① expect runway ② confirm | as above | TX "{cs}, start-up approved, expect runway 27L." RB "Start-up approved, expect 27L, {cs}." | **(NEW)** `cmdStartup` → phase `startup` |
| **Pushback + taxi (combined)** via `+ ADD PART → taxi` on the confirm step | adds `picker-taxiroute` | route valid from stand exit node | TX "…, after pushback taxi to holding point A1 runway 27L via A." RB echoes route | **(NEW)** conditional queue |
| **Standby [Y]** | confirm | — | TX "{cs}, standby." RB "Standing by, {cs}." Suppresses REQ chip 60 s | **(NEW)** `cmdStandby` |
| **Unable / expect delay [N]** | ① reason chips (*traffic*, *runway change*, *slot*) ② confirm | — | TX "{cs}, expect 5 minutes delay, traffic." RB "Roger, {cs}." | **(NEW)** |

#### `startup` (engines running, stationary; also the state right after pushback completes — pilot calls "ready to taxi")

| Action | Steps | Validation | TX / RB | Engine |
|---|---|---|---|---|
| **Taxi to runway [T]** | ① `picker-runway` (default expected) ② `picker-taxiroute` (AUTO route pre-filled; hold-short pills auto-inserted at every runway crossing) ③ optional part *hold short of* / *at intersection* ④ confirm | Hard: no route; Soft: route crosses active runway (pill inserted, shown amber); Soft: opposite-direction traffic on the same taxiway | TX "{cs}, taxi to holding point A1 runway 27L via A, B[, hold short of runway 27R]." RB "Taxi holding point A1 runway 27L via A, B, hold short 27R, {cs}." | `cmdTaxiTo(rwy, via)` + `cmdHoldShort` semantics |
| **Taxi to point / hold at intersection [T → "point"]** | ① `picker-taxiway` ×2 (intersection) ② route ③ confirm | reachable | TX "{cs}, taxi and hold at the intersection of taxiway A and V via B." | **(NEW)** `cmdTaxiToNode` |
| **Hold position [H]** | confirm | — | TX "{cs}, hold position." RB "Holding position, {cs}." | **(NEW)** `cmdHoldPosition` |
| **Follow company / give way [J]** | ① `picker-aircraft` ② confirm | target within 300 m | TX "{cs}, follow the company A320 ahead." RB "Follow the company, {cs}." | **(NEW)** |
| **Contact ground/tower [F]**, **Standby [Y]**, **Report [R]** (position) | as generic | | | |

#### `pushback` (moving backwards on the tug)

| Action | Steps | Validation | TX / RB | Engine |
|---|---|---|---|---|
| **Hold position [H]** | confirm | — | TX "{cs}, hold position, stop pushback." RB "Stopping, {cs}." | **(NEW)** `cmdHoldPosition` (pauses the push; **Continue [X]** resumes) |
| **Taxi after pushback [T]** | same as `startup → Taxi`, transmitted now, executed when the push completes | as taxi | TX "{cs}, when ready taxi to holding point A1 runway 27L via A." RB "When ready, taxi A1 27L via A, {cs}." | **(NEW)** conditional |
| **Change expected runway [T → runway]** | `picker-runway` | | TX "{cs}, change to runway 27R." | sets `plan.runway` |
| **Standby [Y]** | | | | |

#### `taxi` (moving on taxiways — outbound to a runway or inbound to a stand)

| Action | Steps | Validation | TX / RB | Engine |
|---|---|---|---|---|
| **Hold short of [H]** | ① target chips: *next runway on route* (default), *runway ▾*, *taxiway ▾*, *here* ② confirm | target ahead on path; "here" = hold position | TX "{cs}, hold short of runway 27R." RB "Hold short 27R, {cs}." · "here" → TX "{cs}, hold position." | `cmdHoldShort` (runway) / **(NEW)** `cmdHoldShortOf(node)` / `cmdHoldPosition` |
| **Continue taxi [X]** (visible when `trafficHold` or a hold pill is active and it is *not* a runway crossing) | confirm | — | TX "{cs}, continue taxi." RB "Continue taxi, {cs}." | `cmdCross` (rename `cmdContinue`) |
| **Cross runway [X]** (visible when the next hold point is a runway crossing; pilot calls "request cross 27R") | ① runway (pre-filled from the hold point) ② optional *expedite* chip ③ confirm | Hard: aircraft on that runway rolling / cleared for takeoff; Hard: arrival < 2 NM final to that runway; Soft: arrival 2–4 NM ("crossing takes ≈ 45 s, arrival in 70 s") | TX "{cs}, cross runway 27R[, expedite], report vacated." RB "Cross 27R, wilco, {cs}." | **(NEW)** `cmdCrossRunway(rwy)` (today `cmdCross` releases any hold) |
| **Amend taxi route [T]** | `picker-taxiroute` from the aircraft's current node; destination change allowed (other runway, other gate, intersection) | as taxi | TX "{cs}, amend routing, taxi via B, D, hold short 27L." | `cmdTaxiTo` |
| **Line up and wait [W]** (when the aircraft is on the last segment toward its runway, < 200 m from the hold point) | ① runway chip (locked to `plan.runway`) ② optional *behind next landing aircraft* (`picker-aircraft` on final) ③ confirm | Hard: runway occupied (unless *behind landing* variant); Soft: arrival < 4 NM | TX "{cs}, [behind the landing A320 on 2-mile final,] line up and wait runway 27L[, behind]." RB "Behind the landing A320, line up and wait 27L, behind, {cs}." | `cmdLineUp` + **(NEW)** conditional |
| **Cleared for takeoff (on reaching) [O]** | as `hold_short → Takeoff`; banner "aircraft not at the runway — clearance executes on reaching" | same as takeoff, evaluated again on reaching | TX "…, cleared for takeoff runway 27L, report rolling." | `cmdTakeoff` (uses `takeoffCleared` flag) |
| **Taxi to stand [T]** (inbound) | ① `picker-gate` (assigned pre-selected) ② `picker-taxiroute` (AUTO) ③ optional *hold short of* ④ confirm | stand free (soft: "occupied by X, hold at…") | TX "{cs}, taxi to stand 512 via A, B, hold short of runway 27R." RB "Stand 512 via A, B, hold short 27R, {cs}." | `cmdTaxiTo(gate, via)` |
| **Give way to [J]** | `picker-aircraft` | | TX "{cs}, give way to the B738 from the left on taxiway B, then continue." RB "Give way to the B738, {cs}." | **(NEW)** |
| **Contact tower [F]** (outbound, when ≤ 1 hold point from runway) / **Contact ground [F]** (inbound) | `picker-position` (default = next logical) | strict-frequency realism: pilot won't accept tower commands until contacted | TX "{cs}, contact tower 118.5." RB "Tower 118.5, {cs}." Then pilot on tower: "Tower, {cs}, holding short 27L." | **(NEW)** `cmdHandoff` |
| **Report position [R]** | | | TX "{cs}, report position." RB "Approaching holding point A1, {cs}." | **(NEW)** |
| **Standby [Y]** | | | | |

#### `hold_short` (stopped at a runway holding point)

| Action | Steps | Validation | TX / RB | Engine |
|---|---|---|---|---|
| **Line up and wait [W]** | ① runway chip ② `+` *behind next landing* ③ `+` *hold in position, traffic X on N-mile final* (auto text) ④ confirm | Hard: runway occupied by aircraft/vehicle (with occupant named); Soft: arrival < 4 NM; Soft: departure rolling from opposite end | TX "{cs}, line up and wait runway 27L[, traffic on 4-mile final]." RB "Line up and wait 27L, {cs}." | `cmdLineUp` |
| **Cleared for takeoff [O]** | ① runway chip ② parts (any, ordered automatically): *immediate* toggle · *after departure fly heading* (`picker-heading`) / *turn L/R N degrees* · *climb to* (`picker-altitude`, default SID initial) · *on reaching, contact departure* toggle · *wind* auto-chip (reads ATIS wind) ③ confirm | Hard: runway occupied; Hard: another aircraft cleared for takeoff on the same or crossing runway; Hard: arrival < 2 NM; Soft: arrival 2–4 NM; Soft: wake — heavy departed < 2 min (shows countdown); Soft: crossing traffic cleared | TX "{cs}, wind 260 degrees 8 knots, runway 27L, [after departure fly heading 250, climb 4000, on reaching contact departure,] cleared for [immediate] takeoff." RB "Heading 250, climb 4000, contact departure on reaching, cleared for takeoff 27L, {cs}." | `cmdTakeoff` + **(NEW)** departure-clearance fields (`afterDepHdg`, `initialAlt`, `autoHandoffAlt`) |
| **Cross runway [X]** (holding to cross) | as `taxi → Cross runway` | | | **(NEW)** |
| **Hold position [H]** | | | TX "{cs}, hold position, traffic landing." RB "Holding, {cs}." | `cmdHoldShort` |
| **Amend route / change runway [T]** | `picker-runway` → `picker-taxiroute` | | TX "{cs}, change to runway 27R, taxi via A, hold short 27R." | `cmdTaxiTo` |
| **Contact tower / ground [F]**, **Report [R]**, **Standby [Y]** | | | | |

#### `lineup` (on the runway, stationary)

| Action | Steps | Validation | TX / RB | Engine |
|---|---|---|---|---|
| **Cleared for takeoff [O]** | as above (default = Enter, Enter) | as above minus "runway occupied by self" | TX "{cs}, wind 260/8, runway 27L, cleared for takeoff." RB "Cleared for takeoff 27L, {cs}." | `cmdTakeoff` |
| **Hold in position [H]** | ① reason chip (*traffic on final*, *wake*, *crossing traffic*) ② confirm | Soft: arrival < 2 NM (suggests *Vacate* instead) | TX "{cs}, hold position, traffic on 3-mile final." RB "Holding position, {cs}." | no-op + strip note |
| **Cancel line-up / vacate runway [C]** | ① `picker-taxiway` (exits ahead) ② confirm | exit reachable | TX "{cs}, vacate runway 27L via A2, hold short." RB "Vacating via A2, {cs}." | **(NEW)** `cmdVacateLineup` |
| **Report [R]** | | | | |

#### `takeoff` (rolling, then airborne until the engine flips to `climb` at ~400 ft AGL)

| Action | Steps | Validation | TX / RB | Engine |
|---|---|---|---|---|
| **Cancel takeoff [C]** | confirm (red) | Enabled only while on the runway and ground speed < 80 kt; otherwise disabled "past abort speed" | TX "{cs}, cancel takeoff, I say again, cancel takeoff, [vehicle on runway]." RB "Stopping, {cs}." → phase `rollout` | **(NEW)** `cmdCancelTakeoff` |
| **Fly heading [V]** / **Climb [A]** (once airborne) | standard pickers | heading only after 400 ft (soft) | TX "{cs}, fly heading 250, climb 4000." | `cmdHeading`, `cmdAltitude` |
| **Contact departure [F]** | `picker-position` | airborne | TX "{cs}, contact departure 120.4." RB "Departure 120.4, good day, {cs}." | **(NEW)** `cmdHandoff` |

#### `climb` (departure climbing; also used by arrivals after go-around today — see `go_around`)

| Action | Steps | Validation | TX / RB | Engine |
|---|---|---|---|---|
| **Vector [V]** | `picker-heading` (+ L/R) → confirm | 001–360; Soft: heading points into a restricted area below its floor; Soft: turn cancels SID (pilot: "leaving the SID") | TX "{cs}, turn left heading 240." RB "Left heading 240, {cs}." | `cmdHeading(h, dir)` |
| **Climb / maintain [A]** | `picker-altitude` (+ expedite) → confirm | Hard: below current altitude → verb becomes *descend* (still allowed); Soft: above FL130 TMA cap; Hard: below MSA | TX "{cs}, climb and maintain 8000[, expedite]." RB "Climb 8000, expedite, {cs}." | `cmdAltitude(ft, xp)` |
| **Speed [S]** | `picker-speed` → confirm | envelope; ≤250 <FL100 | TX "{cs}, speed 250 knots." RB "Speed 250, {cs}." · *resume normal* → TX "{cs}, resume normal speed." | `cmdSpeed` |
| **Direct [D]** | `picker-fix` (or drag on map) → confirm | fix in db | TX "{cs}, proceed direct BIG." RB "Direct BIG, {cs}." | `cmdDirect` |
| **Resume SID / own navigation [D → "resume SID"]** | confirm | | TX "{cs}, resume own navigation, climb via SID." RB "Resume own nav, {cs}." | **(NEW)** `cmdResumeSid` (sets `navMode='sid'`) |
| **Hold at fix [H]** | `picker-hold` → confirm | | TX "{cs}, hold at BIG, inbound 270, right turns, 1 minute legs, expect further clearance 12:45." RB "Hold BIG inbound 270 right turns, EFC 45, {cs}." | `cmdHold(fix, inbound, dir)` + **(NEW)** leg/EFC fields |
| **Expedite [A → E]** | toggle inside altitude ladder or standalone chip | | TX "{cs}, expedite climb through 6000." | `cmdExpedite` |
| **Contact departure / centre [F]** | `picker-position` | Soft: below FL90 with SID off (would count as diversion) | TX "{cs}, contact London Control 127.4." RB "127.4, {cs}." → phase `departed` | **(NEW)** `cmdHandoff` |
| **Report [R]** (heading/altitude/speed) | `picker-info` | | TX "{cs}, report heading." RB "Heading 245, {cs}." | **(NEW)** |
| **Standby [Y]** | | | | |

#### `cruise` (level in TMA — arrivals inbound before descent, departures topped out)

Same set as `climb` (V · A · S · D · H · F · R · Y) with these additions:

| Action | Steps | Validation | TX / RB | Engine |
|---|---|---|---|---|
| **Descend [A]** | ladder defaults 1000 ft below | Hard: below MSA / restricted floor (ladder red band) | TX "{cs}, descend and maintain 5000." RB "Descend 5000, {cs}." | `cmdAltitude` |
| **Expect runway / approach [I → expect]** | `picker-runway` → confirm | weight class permitted | TX "{cs}, expect ILS approach runway 27L, information K." RB "Expect ILS 27L, K, {cs}." | **(NEW)** `cmdExpectRunway` (sets `plan.runway`, shows ILS geometry aids for that runway) |

#### `descent`

Same as `cruise` plus:

| Action | Steps | Validation | TX / RB | Engine |
|---|---|---|---|---|
| **Cleared ILS approach [I]** | ① `picker-runway` (expected pre-selected; each chip shows *intercept angle* and *above/below GS* live) ② mode chips *ILS* (default) / *LOC only* / *visual* ③ `+` *descend to X then* (altitude ladder) ④ confirm | Hard: weight class; Hard: on the ground; Soft: intercept angle > 60° ("will not capture — 74° intercept"); Soft: above glideslope at the projected intercept ("1 200 ft above GS — descend first"); Soft: another aircraft established < 3 NM ahead / wake distance (from `approach_atc.md` §11 table) | TX "{cs}, [descend to 3000,] cleared ILS approach runway 27L, report established." RB "Descend 3000, cleared ILS 27L, will report established, {cs}." · LOC-only → "cleared localizer approach 27L, maintain 3000 until established" | `cmdILS` / **(NEW)** `cmdLOC`, conditional altitude |
| **Hold [H]** | `picker-hold` (approach-stack fixes first) | | | `cmdHold` |
| **Contact tower [F]** (visible when `ilsCaptured`) | `picker-position` (Tower pre-selected) | Soft: not established | TX "{cs}, contact tower 118.5." RB "Tower 118.5, {cs}." → pilot on tower: "Tower, {cs}, established ILS 27L, 8 miles." | **(NEW)** `cmdHandoff` |

#### `approach` (approach clearance issued; LOC/GS captured or intercepting; not yet cleared to land)

| Action | Steps | Validation | TX / RB | Engine |
|---|---|---|---|---|
| **Cleared to land [L]** | ① runway chip (locked to `assignedRunway`) ② parts: *wind* auto-chip · *hold short of runway/taxiway for crossing traffic* (LAHSO, `picker-runway`/`picker-taxiway`) · *exit at* (`picker-taxiway`) / *next available exit L/R* ③ confirm | Hard: another aircraft cleared to land on the same runway ahead not yet vacated **and** this aircraft < 2 NM; Soft: runway occupied (names occupant + "expected vacated in ~40 s" from its rollout speed); Soft: departure lined up; Soft: vehicle on runway (hard if ARFF/inspection active = runway closed) | TX "{cs}, wind 260 degrees 8 knots, runway 27L, cleared to land[, hold short of runway 27R for crossing traffic][, exit at A5]." RB "Cleared to land 27L, hold short 27R, {cs}." · LAHSO too short → RB "Unable hold short, {cs}." | `cmdClearedLand` + **(NEW)** LAHSO / exit fields |
| **Go around [G]** | ① optional parts *fly heading* / *climb to* / *contact departure* ② confirm (amber) | always allowed | TX "{cs}, go around, I say again, go around, [fly runway heading, climb 3000, contact approach 119.7]." RB "Going around, runway heading, 3000, {cs}." → phase `go_around` | `cmdGoAround` + parts |
| **Cancel approach clearance [C]** | forced multi-part: ① `picker-heading` ② `picker-altitude` ③ confirm | both required (button disabled until set: "needs heading and altitude") | TX "{cs}, cancel approach clearance, turn right heading 360, climb and maintain 4000." RB "Cancel approach, right heading 360, climb 4000, {cs}." → phase `descent`, `ilsArmed=false` | **(NEW)** `cmdCancelApproach` |
| **Speed [S]** (restricted rail: ≥ final approach speed; chips *160 to 4 miles*, *reduce to final approach speed*, *no speed restriction*) | | Soft: below 160 kt outside 4 NM | TX "{cs}, reduce speed 160 knots until 4 miles." | `cmdSpeed` |
| **Change runway / enter final [I]** | `picker-runway` (parallel runways only; disabled beyond 4 NM final: "too close to switch") | Soft: pilot may refuse if < 6 NM | TX "{cs}, change to runway 27R, cleared ILS 27R." RB "Cleared ILS 27R, {cs}." or "Unable, {cs}." | `cmdILS` |
| **Plan exit [E]** | `picker-taxiway` / direction | advisory | TX "{cs}, plan to vacate at A5." RB "Vacate A5, {cs}." | **(NEW)** `cmdExitAt` |
| **Contact tower [F]**, **Report [R]** (*report established*, *report 4-mile final*), **Standby [Y]** | | | | |

#### `landing` (short final, ≤ 4 NM / ≤ 1500 ft)

| Action | Steps | Validation | TX / RB | Engine |
|---|---|---|---|---|
| **Cleared to land [L]** (if not yet) | as above; panel shows a red countdown "no landing clearance — 1.8 NM" | as above; if not cleared by 0.5 NM the pilot goes around automatically (engine) | | `cmdClearedLand` |
| **Go around [G]** | as above | | | `cmdGoAround` |
| **Exit at / next available exit [E]** | ① chips *next available exit LEFT / RIGHT*, *exit at ▾* ② confirm | Disabled below 500 ft AGL with reason "too late — below 500 ft" (Tower!Sim rule) | TX "{cs}, take next available exit on the right." RB "Next available right, {cs}." | **(NEW)** `cmdExitAt` |
| **Wind check [R]** | confirm | | TX "{cs}, wind 260 degrees 8 knots." RB "{cs}." | info only |

#### `rollout` (on the runway after touchdown, decelerating)

| Action | Steps | Validation | TX / RB | Engine |
|---|---|---|---|---|
| **Vacate / exit at [E]** | ① `picker-taxiway` (exits ahead sorted by distance; the one the engine will take is pre-selected) or *left/right* ② optional *expedite, traffic on short final* chip (auto-suggested when an arrival < 3 NM) ③ confirm | Exit must be ahead of current position (passed exits disabled) | TX "{cs}, vacate right at A5[, expedite, traffic 2 miles final]." RB "Vacating A5, expediting, {cs}." | **(NEW)** `cmdExitAt` |
| **Taxi to stand [T]** | `picker-gate` → `picker-taxiroute` from the planned exit → `+` hold short ▾ → confirm | route valid; hold-short pills auto | TX "{cs}, vacate at A5, taxi to stand 512 via A, hold short of runway 27R." RB "…, {cs}." | `cmdTaxiTo(gate, via)` |
| **Hold short after vacating [H]** | `picker-runway`/`picker-taxiway` | | TX "{cs}, after vacating hold short of runway 27R." RB "Hold short 27R after vacating, {cs}." | `cmdHoldShort` |
| **Contact ground [F]** | `picker-position` (Ground pre-selected) | Soft: still on runway ("issue after vacated") | TX "{cs}, when vacated contact ground 121.9." RB "Ground 121.9 when vacated, {cs}." | **(NEW)** `cmdHandoff` |
| **Report [R]** (*report runway vacated*) | | | TX "{cs}, report runway vacated." RB "Wilco, {cs}." → later "Runway vacated, {cs}." | **(NEW)** |

#### `arrived` (on stand, engines shut down) and `departed` (handed off / left airspace)

No radio actions. Strip shows the final score line; `Delete` / strip `×` archives it (auto-archive after 30 s). `arrived` shows **"Turn around → schedule as departure"** (`picker-runway` + delay chips) only in Custom/sandbox modes **(NEW)** `scheduleTurnaround`.

#### `go_around` (missed approach — **NEW phase**; climbing on runway heading to 3000 per `initiateGoAround`)

| Action | Steps | Validation | TX / RB | Engine |
|---|---|---|---|---|
| **Vector [V]** / **Climb [A]** / **Speed [S]** / **Direct [D]** / **Hold [H]** | standard | standard | TX "{cs}, turn left heading 180, climb 4000." | existing |
| **Contact approach [F]** (highlighted default — Tower!Sim's preferred flow) | `picker-position` (Approach pre-selected) | | TX "{cs}, contact approach 119.7 for re-sequencing." RB "119.7, {cs}." → strip moves to Approach bay, phase `climb`/`descent` | **(NEW)** `cmdHandoff` |
| **Cleared ILS again [I]** | as `descent → ILS` | Disabled until > 4 NM from threshold and below GS ("not positioned — vector first") | | `cmdILS` |
| **Report [R]** (*report reason for go-around*) | | | TX "{cs}, report reason." RB "Unstable approach / runway occupied, {cs}." | **(NEW)** |

#### Emergency substates (overlay on any phase)

`aircraft.emergency = { level: 'MAYDAY'|'PAN', kind: 'engine_fire'|'engine_failure'|'medical'|'fuel'|'depressurization'|'gear'|'bird_strike'|'smoke'|'hydraulic'|'brake_fire', status: 'declared'|'acknowledged'|'services_dispatched'|'landed'|'resolved', pob?, fuelMin? }` **(NEW)**. Pilot opens with "MAYDAY MAYDAY MAYDAY, {cs}, engine fire, request immediate return runway 27L" (or "PAN PAN ×3"). A red **EMERGENCY** band is pinned to the top of the panel with these actions above the phase actions:

| Action | Steps | Validation | TX / RB | Engine |
|---|---|---|---|---|
| **Acknowledge [M] / [Enter on the alert]** | ① `picker-info` multi-select (*POB*, *fuel*, *nature*, *dangerous goods*, *intentions*) — defaults on ② confirm | — | TX "{cs}, roger mayday, [squawk 7700,] say persons on board and fuel remaining, state intentions." RB "212 on board, fuel 40 minutes, request ILS 27L, {cs}." → status `acknowledged`, strip fills POB/fuel | `cmdEmergencyAck` |
| **Priority approach / runway [I]** | ① `picker-runway` (nearest suitable pre-selected; wind and length checked) ② chips *straight-in*, *number 1*, *runway will be sterile* ③ confirm | Soft: other arrivals on final will need breaking off (panel lists them with one-click *break off*) | TX "{cs}, expect runway 27L, number one, straight-in ILS 27L, cleared ILS approach 27L, emergency services will be alerted." RB "Cleared ILS 27L, number one, {cs}." | `cmdILS` + **(NEW)** priority flag |
| **Dispatch services [M → D]** | ① `picker-vehicle` (ARFF ×2 pre-ticked; +Ambulance if medical) ② location chips *runway 27L*, *aircraft position*, *gate*, *map tap* ③ confirm | vehicle available | System line "FIRE 1, FIRE 2 → RWY 27L, ETA 02:10." Vehicles roll (§6) | `dispatchVehicle` |
| **Hold all traffic / sterile runway [M → H]** | ① scope chips *departures 27L*, *crossings*, *all ground movement* ② confirm | | TX "All stations, {airport} tower, emergency in progress, hold position." Strips in the chosen scope get a "HELD" chip; `Cleared for takeoff` is hard-blocked on that runway until *Resume* | **(NEW)** `runwayStatus='sterile'` |
| **Break off other arrival [M → B]** | `picker-aircraft` (arrivals on that final) → adds a go-around/vector part | | TX "DLH2GK, break off approach, turn right heading 360, climb 4000, emergency traffic." | `cmdCancelApproach` |
| **After landing: stop on runway / vacate if able [E]** | chips *stop on the runway, fire services will meet you*, *vacate if able at ▾* | | TX "{cs}, stop on the runway if able, fire services are positioned." RB "Stopping on the runway, {cs}." → runway status `closed` until *Reopen runway* | **(NEW)** |
| **Reopen runway [M → R]** | `picker-runway`, chips *after inspection* (dispatches Ops vehicle) | vehicle not on runway | System: "RWY 27L reopened." | **(NEW)** `runwayStatus='open'` |
| **Cancel emergency** (pilot-initiated "cancel mayday") | shows as a REQ; `Enter` acknowledges | | TX "{cs}, roger, mayday cancelled." | status `resolved` |

Ground emergencies (`brake_fire` on taxi, medical at stand) use the same band with **Hold position [H]** and **Dispatch services** highlighted and a *close taxiway* advisory chip.

#### Pilot requests (not emergencies, but they gate the flow)

Requests from the engine surface as a yellow **REQ** chip on the strip, the data block, and the panel header: *request pushback*, *request start-up*, *ready to taxi*, *ready for departure*, *request cross runway 27R*, *with you* (initial call after handoff), *request higher/lower*, *request direct FIX*, *request hold*, *say again*, *radio check*. The panel pre-highlights the answering action; `Enter` runs it with defaults; `N` opens **Unable** (reason chips: *traffic*, *wake*, *runway closed*, *standby* → TX "{cs}, unable, traffic; standby."); `Y` = standby. Unanswered requests re-call after 45 s (louder, pilot tone "…{cs}, did you copy?") and count against the "responsiveness" score.

### 1.5 Multi-part commands

The confirm step exposes `+ ADD PART` chips filtered to parts compatible with the current AST. Parts are ordered automatically into ICAO word order and read back in the same order.

| Base | Allowed parts (max 4 total) | Emitted order |
|---|---|---|
| Vector / Altitude / Speed (any airborne phase) | each other; *then* conditionals: `then cleared ILS ▾`, `when passing ALT ▾`, `after fix ▾` | turn → climb/descend → speed → then-clause |
| ILS / LOC clearance | `descend to ▾` (before), `speed ▾`, `report established` (toggle, default on) | descend → cleared → speed → report |
| Takeoff | `immediate`, `after departure fly heading ▾` / `turn L/R N degrees ▾`, `climb to ▾`, `on reaching contact departure`, `wind` (auto) | wind → runway → after-departure → climb → contact → cleared for [immediate] takeoff |
| Line up | `behind next landing aircraft`, `traffic on N-mile final` (auto) | as listed |
| Land | `wind`, `hold short of ▾` (LAHSO), `exit at ▾` / `next exit L/R` | wind → runway → cleared to land → hold short → exit |
| Taxi | `via ▾` (route), `hold short of ▾`, `cross runway ▾`, `hold at intersection ▾`, `contact tower at holding point` | taxi → via → hold short/cross → contact |
| Pushback / start-up | `expect runway ▾`, `face ▾`, `after pushback taxi ▾` | approved → expect → face → then taxi |
| Go around | `fly heading ▾` / `runway heading`, `climb to ▾`, `contact ▾` | go around → heading → climb → contact |

Example: `A` → ladder `3000` → `+ then cleared ILS` → runway `27L` → confirm → **TX** "BAW117, descend to 3000, cleared ILS approach runway 27L, report established." **RB** "Descend 3000, cleared ILS 27L, will report established, BAW117." The engine queues `altitude(3000)` immediately and arms ILS with a `notBefore: altitude ≤ 3000` guard **(NEW)** `PendingCmd.condition`.

Pilot-side partial refusal: if a part fails a *pilot* rule (speed below envelope, LAHSO distance too short, exit already passed) the readback contains "unable {part}" and the engine applies the remaining parts; the strip shows the refused part struck through.

### 1.6 Cancel and undo

| Moment | Gesture | Result |
|---|---|---|
| While building | `Esc` / `CANCEL` | Discard draft, panel returns to root. No radio. |
| While building | `Backspace` / `BACK` | Return to the previous step (values retained). |
| While building, click another aircraft | — | Draft is parked as a **"Resume draft"** chip on the first aircraft's strip and panel header for 20 s; new aircraft's panel opens. |
| After **TRANSMIT**, before the pilot executes (`PILOT_DELAY_S`, ≈ 3–5 s; shown as a shrinking ring on the log line and an `UNDO` chip) | `U` / `Ctrl+Z` / click `UNDO` | **TX** "{cs}, disregard." **RB** "Disregard, {cs}." State restored to pre-command targets; the pending `PendingCmd` is dropped **(NEW)** `cmdDisregard`. Counts as one extra transmission (frequency-load meta-score). |
| After execution | no undo | Use the explicit cancel actions: *Cancel takeoff* (`C`, only < 80 kt), *Cancel approach clearance* (`C`, forced heading + altitude), *Go around* (`G`), *Hold position* (`H`), *Cancel line-up / vacate* (`C`), *Recall vehicle*, *Amend route* (`T`). Each is its own tree leaf above. |
| Any time | `Ctrl+Shift+Z` | Re-transmit the last undone command (draft reopens on confirm). |

### 1.7 "Say again"

- **Pilot asks controller.** Triggered when STT confidence < 0.72, when the parsed AST is invalid for the phase, or randomly at 2 % ("bad radio" realism setting). Pilot: "{cs}, say again?" / "confirm heading 240?". The ATC log line gains a **REPEAT** button; `R` on the selected aircraft reopens the last transmission as a filled draft at the confirm step (`Enter` re-transmits). Voice users may just re-key the mic.
- **Controller asks pilot.** `R → Say again` (or the ↻ button on any pilot log line): **TX** "{cs}, say again." Pilot repeats the last transmission (TTS replays; the log line re-highlights and scrolls into view). Free of penalty.
- **Last plane called** (`Shift+R`, from Tower!Sim): replays the most recent *unanswered* pilot call and selects that aircraft.
- **Read-back error simulation** (realism setting): pilots occasionally read back a wrong value (heading 240 → 250). The log line flags the mismatch with a red diff; the controller must send **Correction** (`R → Correction`, pre-filled with the correct value): **TX** "{cs}, negative, heading 240, I say again, heading 240." Missing it for 20 s costs score.

---

## 2. SCREEN ARCHITECTURE

One route (`/atc`), one full-bleed map/radar canvas, floating glass panels. Modes change *layers, filters, bays, and default actions* — never the page.

```
┌ TOPBAR (56px, glass) ─────────────────────────────────────────────────────────────────────────────────┐
│ ◆ SKYCONTROL EGLL │ [ GROUND ] [ TOWER ] [ APPROACH ] │ ATIS K · 27L/27R · 260/08 · Q1013 · CAVOK │ 12:34:56Z │ ⏸ 1× 2× 4× ⏩ │ 1,240 ▲ (HI 2,310) │ 🔔 2 │ ● TX │ ⚙ │ ? │
├ STRIP BAY (300px, glass, collapsible ◀) ┬ MAP / RADAR (fills) ───────────────────────────┬ COMMAND PANEL (340px, glass, appears on selection) ┤
│ ▸ bay tabs per mode                      │ ┌ ALERT STACK (top-centre, max 3) ┐            │ BAW117  B738/M  DEP  ● TAXI                        │
│ ┌ DEPARTURES ─────────────────────────┐  │ └─────────────────────────────────┘            │ ALT 0  SPD 12  HDG 271   RWY 27L  VIA A B          │
│ │ ▌BAW117 B738 M  S512 27L  BPK  TAXI  │  │                                                │ ┌ ACTIONS (phase-gated) ─────────────────────────┐ │
│ │ ▌DLH2GK A320 M  S540 27L  DET  REQ▲  │  │       (aircraft, taxiways, runways,            │ │ [T] Amend taxi   [H] Hold short   [X] Continue  │ │
│ └─────────────────────────────────────┘  │        route preview, measure tool)            │ │ [W] Line up (soon)  [F] Contact tower           │ │
│ ┌ ARRIVALS ───────────────────────────┐  │                                                │ └────────────────────────────────────────────────┘ │
│ │ … │                                     │ ┌ MAP TOOLBAR (bottom-right, vertical) ┐        │ ┌ STEPPER / PICKER ──────────────────────────────┐ │
│ └───┘                                     │ │ + − ⌖follow ◎rings ⟷measure ▦layers ▣presets │        │ │ …                                              │ │
│ [ALL][DEP][ARR][REQ][ALERT] 🔍            │ └──────────────────────────────────────┘        │ │ [BACK]        [TRANSMIT ▶ Enter]              │ │
├ COMM LOG (collapsible, 160px, glass) ────┴────────────────────────────────────────────────┴───────────────────────────────────────────────────┤
│ [GND][TWR][APP][ALL]  ATC ▸ BAW117, taxi to holding point A1 runway 27L via A, B. ↶undo (2.4s)                                                │
│                        ◂ PIL Taxi holding point A1 runway 27L via A, B, BAW117. ✓                                                             │
│ › BAW117 _                                                                                  [● PTT  hold Space]  [SEND ⏎]                     │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 Panel inventory and placement

| Panel | Position | Default | Collapse | Notes |
|---|---|---|---|---|
| Top bar | fixed top, full width | always | never | Brand+airport, mode tabs, ATIS chip (click → ATIS/weather panel), UTC clock (click → sim time & rate), sim-rate segmented control + hold-to-fast-forward, score with live delta, alerts bell (badge = unacked), TX indicator (lights while transmitting / PTT), Settings, Help. |
| Strip bay | left, floats 12 px inside the map, from 68 px to bottom of map area | open | `F4` or ◀; collapsed = 44 px rail showing counts per bay and REQ/ALERT dots | Width 300 (1280–1439), 320 (1440–1919), 340 + optional second column (≥1920). |
| Command panel | right, floats 12 px inside the map | appears on selection, slides in 160 ms | `Esc` deselect closes; pin button keeps it open empty | Width 320 / 340 / 380. Header (callsign, type/wake, DEP/ARR, phase chip, REQ/EMERG bands) · live metrics · actions grid · stepper area · confirm bar. |
| Alert stack | top-centre over map, below the top bar | on demand | auto (info 6 s, warn 12 s, critical never) | Max 3 stacked; more collapse into "+N". |
| Map toolbar | bottom-right of the map, vertical | always | — | zoom ±, follow, range rings, measure, layers, camera presets, compass/north-up (Ground 3D only). |
| Comm log | bottom, full width, 160 px | open | `F5` or ▾; collapsed = 40 px showing only the last line + command line | Frequency filter tabs; each line has who/when/undo/repeat. Command line lives in its footer. |
| ATIS / weather panel | drops from the ATIS chip | closed | click-away / `F6` | Letter, wind (live arrow), vis, cloud, QNH, temp/dew, active runways per role with *change* (opens runway-config dialog), runway status chips (open/closed/sterile/inspection/wet), ATIS text as a broadcast line. |
| Vehicles panel | drops from a truck icon in the map toolbar (Ground/Tower only) | closed | `F7` | §6. |
| Help overlay | full-screen modal | closed | `?` / `F1` / `Esc` | §8. |
| Pause menu | full-screen modal | `Esc` with nothing selected | `Esc` | Resume, Restart, Runway config, Settings, Track history, Quit. Sim paused. |

### 2.2 What changes per mode

| | **GROUND** | **TOWER** | **APPROACH** |
|---|---|---|---|
| Map layer | Airport chart or satellite (`groundTheme`), zoom 14–19, optional 2.5D (`Ground3DView`); taxiway labels on; hold-short bars; stand numbers; vehicles | Same airport base at zoom 13–16 **plus** a 10 NM final/departure corridor overlay: runway extended centre-lines with 1 NM ticks, arrival "blips" with distance-to-threshold, runway occupancy bars beneath the top bar (one per runway end: green free / amber lined-up / red occupied / purple closed) | Dark radar scope (`ApproachView`): 30 NM boundary, range rings, fixes, ILS feathers with 2000/3000/4000 ft GS-intercept circles, restricted areas, wake arcs, turn predictors |
| Strip bays | DEPARTURES: `PENDING` (parked/REQ) → `PUSH · START` → `TAXI OUT` → `AT HOLD` (handed to Tower) / ARRIVALS: `TAXI IN` → `AT STAND` / `VEHICLES` | DEPARTURES: `AT HOLD` → `LINED UP` → `ROLLING · AIRBORNE` (auto-pushes to Approach on handoff) / ARRIVALS: `FINAL` (sorted by distance) → `LANDED · ROLLOUT` → `TO GROUND` | ARRIVALS: `INBOUND` (entry-point order) → `SEQUENCE` (sorted by ETA to FAF, drag to re-sequence = sets number) → `ESTABLISHED` → `TO TOWER` / DEPARTURES: `CLIMB OUT` → `HANDED OFF` |
| Data block | callsign · type · dest (`27L` / `S512`) · phase chip · next taxiway; REQ badge | callsign · type/wake · runway · alt (hundreds) · GS · `2.4 NM` to threshold for arrivals; `CLR T/O` / `LUAW` state for departures | 3-line Endless-style: callsign / `alt→cmd ▲▼` / `GS · wake · mode (ILS/LOC/DCT/HLD)`; 4th line runway or destination; small 2-line block when not under control |
| Default root actions (first row) | P · T · H · X · W | W · O · L · G · E | V · A · S · I · D |
| Alert filter | ground conflict, runway incursion (vehicles + aircraft), stand blocked | runway incursion, occupied-runway landing/takeoff, wake, go-around, LAHSO | STCA, MSAW, restricted-area, wake on final, diversion/boundary, delay |
| Comm log filter | GND (+ALL) | TWR (+ALL) | APP (+ALL) |
| Aircraft on other positions | shown at 45 % opacity with a `TWR`/`APP` tag; selectable; commanding them shows a "not on your frequency" note (hard block only if *strict frequencies* realism is on) | same | same |
| Camera presets | Overview, each apron, each runway end, custom 1–6 | Overview, Final 27L/27R (10 NM), Departure end, custom | Full 30 NM, 15 NM, Final area, Hold stacks, custom |
| Vehicles panel | on | on | off |

Switching modes (`F1/F2/F3`, click, or `[`/`]`) keeps the current selection; the camera animates 300 ms to the mode's last camera; the strip bay cross-fades bays. Selecting a strip that belongs to another mode's bay never switches mode automatically (the user asked for that aircraft, not that view); a small "View in TOWER ↗" link appears in the panel header.

### 2.3 Responsive rules (≥ 1280 px only; below 1280 show a "desktop required" holding screen with a screenshot)

| Width | Strip bay | Command panel | Comm log | Other |
|---|---|---|---|---|
| 1280–1439 | 300 px, single column; bays stack vertically with scroll | 320 px | 140 px; collapses automatically when the command panel's stepper needs height (restores on close) | Top-bar ATIS chip shows letter + wind only; score hides HI |
| 1440–1919 | 320 px | 340 px | 160 px | Full top bar |
| ≥ 1920 | 340 px, optional second column (DEP/ARR side by side) | 380 px; picker dials enlarge to 220 px | 180 px, two columns (ATC / pilot) optional | Alerts panel may dock as a permanent 280 px column right of the strip bay |
| Height < 800 | bay headers shrink to 28 px; strips 2-line | stepper scrolls internally | 100 px | top bar 48 px |

Panels never overlap each other; the map always has ≥ 560 px of unobstructed width between the strip bay and the command panel at 1280.

---

## 3. FLIGHT STRIPS

### 3.1 Strip anatomy (glass card, 4-px left colour bar, 2 rows at 64 px; 3 rows expanded on hover/selection)

**Departure strip**
```
▌ BAW117        B738/M   S512 ▸ 27L   BPK · FL130      [TAXI]   ⏱ 03:12
▌ via A · B · hold 27R                                  □P ☑T □W □O □F
```
Fields: callsign (mono, 15 px) · type/wake · stand → runway (runway editable: click → `picker-runway`, writes `plan.runway` and transmits "expect runway" if the aircraft has been contacted) · SID fix / requested cruise · phase chip · timer (time since last pilot call, turns amber at 45 s, red at 90 s) · route string · clearance boxes auto-ticked when the corresponding command is transmitted (P push, T taxi, W line-up, O take-off, F handed off). Boxes are also clickable to open that action directly.

**Arrival strip**
```
▌ DLH2GK        A320/M   LAM ▸ 27L   8.4 NM · 2,300 ft · 180 kt   [APP]   ⏱ 00:40
▌ ILS 27L est · stand S540                               □I ☑L □E □F
```
Fields: callsign · type/wake · entry fix → runway · live distance/alt/GS (updates 2 Hz) · phase chip · timer · approach state · stand · boxes (I approach cleared, L landing cleared, E exit given, F handed off).

**Vehicle strip** (Ground/Tower): `▌ FIRE 1   ARFF   → RWY 27L   EN ROUTE 01:20   [RECALL]`.

Annotation: a free-text box (max 24 chars) at the right end, like VRC's annotation boxes (`Ctrl+Enter` to edit; `Shift+/` inserts ✓).

### 3.2 Colour coding

| State | Left bar | Card | Extra |
|---|---|---|---|
| Departure | amber | — | |
| Arrival | cyan | — | |
| VFR / GA | green | — | |
| Not yet on frequency ("with you" pending) | grey, 50 % opacity | dimmed text | tag `GND`/`TWR`/`APP` |
| Pilot request pending | + yellow glow (2 s pulse) | `REQ ▲` chip with text ("req push") | timer shows since request |
| Selected | white 2-px ring | lifted 2 px, brighter | |
| Conflict / alert involved | red bar override | red 1-px outline, pulse 1 Hz until acknowledged | alert chip (`STCA`, `RWY`, `MSAW`) |
| Emergency | red bar + red header band | | `MAYDAY`/`PAN` chip, POB/fuel fields appear |
| Handed off / archived | ghost 35 % | strikethrough route | auto-remove after 30 s (departed) |
| Draft parked on it | — | "Resume draft" chip | |

Colour is never the only channel: DEP/ARR also differ by the arrow glyph (▲ dep, ▼ arr) before the runway.

### 3.3 Bay behaviour

- **Auto-flow.** Strips move between bays automatically as phase changes, with a 240 ms slide; the destination bay header flashes once. Push to the next position's bay happens on handoff (`F`) or automatically when *auto-handoff* is on (default on, as in single-player Tower!Sim).
- **Manual reorder.** Drag within a bay; a 2-px insertion line shows the drop point (VRC convention). In `SEQUENCE` (Approach) reordering writes the landing sequence number (`#1, #2…`) shown on the strip and on the data block; the engine treats it as advisory unless *auto-sequence assist* is on.
- **Manual bay move.** Drag between adjacent bays is allowed (e.g., `PENDING → TAXI OUT` when you cleared by voice and the parser missed it); non-adjacent drops snap back with a shake. Dropping onto another mode's bay tab pushes the strip to that position (handoff) after a confirm bubble.
- **Sort menu** per bay: *Auto* (phase progress → ETA/distance → time-since-request) · *Callsign* · *Time on frequency* · *Runway*. **Filter chips** at the bay footer: `ALL · DEP · ARR · REQ · ALERT` plus a search field (callsign/type/stand). Filters persist per mode in `localStorage`.
- **Separators.** `+ SEP` adds a named divider (VRC `.sep`), draggable, saved per airport.
- **Collapse** a bay to its header (count badge stays).
- **Keyboard.** `Tab`/`Shift+Tab` cycle strips (order: alerts → REQ → bay order); `↑/↓` within bay; `Enter` open panel; `Delete` archive a finished strip; `Ctrl+↑/↓` move strip; `Ctrl+Alt+1–4` push to bay n (vStrips).

### 3.4 Strip ↔ map selection sync

- Hover strip → aircraft gets a soft halo + thicker leader; hover aircraft → strip glows. Both after 120 ms, no delay to clear.
- Select either → both selected (white ring on map, ring on strip); the strip scrolls into view (smooth) and the command panel opens.
- Double-click a strip → map centres on the aircraft (no follow); `Shift+double-click` → follow.
- If the selected aircraft is off-screen, the panel header shows a `⌖ locate` chip and an edge arrow on the map points toward it.
- Deselect (`Esc`, click empty map, or `×`) clears both.

---

## 4. MAP / RADAR INTERACTION

| Interaction | Gesture | Behaviour |
|---|---|---|
| Select | click target, label, or leader line (hit radius 14 px, label rect) | select + open panel; click empty map = deselect; `Tab` cycles |
| Hover tooltip | 150 ms hover on target/label | glass tooltip: callsign · type/wake · phase · alt/GS/hdg · cmd targets (▲/▼) · next instruction pending · REQ text · on ground: stand/route; disappears on move-away |
| **Drag-to-heading** (airborne, Tower/Approach) | mousedown on aircraft, move > 12 px | rubber-band line from the aircraft, heading readout follows cursor, curved turn-predictor arc (bank-limited, from `perf`) drawn live; `L`/`R` keys while dragging force direction (line colour changes); release → confirm bubble at the release point "Fly heading 240 · [L][R] · ⏎" (2 s auto-dismiss, `Enter`/click sends). *Instant vectors* setting sends on release. |
| Drag onto a fix | release over a fix (snap radius 18 px) | bubble "Direct BIG ⏎" (Endless drag-to-beacon) |
| Drag onto a runway threshold / ILS feather | release over the feather | bubble "Cleared ILS 27L ⏎" with intercept-angle and GS-height check inline |
| Drag on ground (Ground mode) | mousedown on aircraft, drag along taxiways | route-build mode: path snaps to the taxiway graph under the cursor (Dijkstra from last node), chips fill; release on a runway entry or stand = taxi draft opens at confirm |
| Wheel on selected aircraft (Approach) | wheel over the target | altitude ±1000 (Endless); `right-button + wheel` speed ±10; middle-click = transmit the pending draft; disabled when no draft exists |
| Right-click aircraft | context | radial quick menu: 6 highest-ranked valid actions from the tree (rank = phase default order) + `More…` (opens panel). Selecting an item starts that action's stepper in the panel. |
| Right-click empty map | context | *Measure from here*, *Add note*, *Centre here*, *Save preset*, layer toggles |
| **Measure** | right-drag on empty map (or `⟷` tool then click-click) | line with distance (NM + m on ground), bearing both ways, and — if an endpoint snaps to an aircraft — time-to-point at its ground speed; right-click on an aircraft on the localizer shows *time to touchdown* (Endless). Multiple measures persist until `Esc`. |
| Range rings | `◎` toggle / `Ctrl+R` | Approach 5/10/15 NM centred on the field (or on the selected aircraft with `Shift`); Tower 1/2/4 NM from thresholds; Ground 250/500 m from the selected aircraft |
| Zoom | wheel (to cursor), `+`/`−`, double-click (in), `Shift`+double-click (out), pinch | eased 180 ms; min/max per mode; labels declutter with zoom |
| Pan | left-drag empty map, arrow keys (nudge 10 %), edge-scroll off by default | inertia (decay 0.92/frame), 60 fps canvas; MapLibre for Ground, canvas for Approach |
| Follow | `⌖` or `F` with an aircraft selected (`F` = handoff when the panel has focus, follow when the map has focus — the tool shows which) | camera locks to the aircraft; any manual pan breaks follow (toast "Follow off") |
| Camera presets | `▣` menu; `Shift+1…6` recall; `Ctrl+Shift+1…6` save (Tower!Sim pattern) | auto-generated: overview, each runway end, each apron, finals; user slots 1–6 per mode; transitions 300 ms ease-in-out |
| North-up / rotate (Ground 3D only) | `N` when map focused; drag with `Alt` | |
| Label declutter | auto | labels avoid overlap via simple repulsion; leader length setting (30 s / 60 s / 2 min of travel) |
| Route preview | selection | ground: planned taxi path highlighted with hold-short bars; air: direct/hold/ILS geometry, wake arc, 3 NM ring, predicted turn |

**Data-block content per mode** is defined in §2.2. Selected aircraft always show the expanded block (all lines + pending commands in yellow, as in Endless when a new speed is set).

---

## 5. ALERTS & EMERGENCIES UX

### 5.1 Alert catalogue

| Alert | Trigger (engine) | Tier | Sound |
|---|---|---|---|
| **STCA** | predicted < 3 NM & < 1000 ft within 60 s, or actual loss (`separation_loss`) with reduced-minima exceptions applied | Critical (predicted = Warning) | two-tone 800/1000 Hz, 0.5 s, loops every 3 s until ack |
| **MSAW** | altitude below restricted-area floor / MSA and descending | Critical | warble 600–900 Hz, 1 s |
| **Runway incursion (RIMCAS)** | aircraft/vehicle crosses a hold-short bar without clearance; or enters a runway that has an arrival < 2 NM or a rolling departure | Critical | short klaxon 0.4 s ×2 |
| **Occupied-runway clearance** | player transmits takeoff/landing clearance while runway occupied (soft-warn override used) | Warning | single buzz |
| **Ground conflict** | `ground_conflict` (converging/nose-to-nose within 60 m) | Warning | double blip |
| **Wake infringement** | trailing aircraft inside the wake arc on final | Warning | low thud |
| **Go-around (auto)** | `go_around` emitted by the engine | Warning | rising chirp |
| **Emergency declared** | pilot MAYDAY/PAN | Critical | 3-beep + spoken call |
| **Diversion risk** | aircraft within 2 NM of boundary at/below FL90 or heading out | Warning | — |
| **Delay** | > 25 min in airspace / > 10 min holding short | Info | — |
| **Pilot request** | REQ chip | Info | soft radio "ding" |
| **Handoff received** | "with you" | Info | chirp |
| **Runway status change** | closed/sterile/inspection | Info | — |

### 5.2 Surfacing pipeline (all four channels fire together within one frame)

1. **Toast** (top-centre): icon · title · involved callsigns as chips · one-line geometry ("2.6 NM / 600 ft, closing 40 s") · actions: `ACK` (or `Enter` when the toast has focus), `SELECT` (selects first aircraft; `Tab` toggles to the other), `MUTE 1 min` (critical only; the toast stays). Info toasts auto-dismiss.
2. **Alerts panel** (bell → drawer): chronological list with state (active / acknowledged / resolved), duration, and score impact; click = select + centre; history kept for the session; "resolved" rows fade.
3. **Strip highlight**: red bar + outline pulse; the alert chip on the strip; involved strips jump to the top of their bay (they keep their bay).
4. **Map**: target symbol flashes red at 2 Hz, 3 NM ring red, a red conflict line between the pair with the CPA point marked, label `STCA`/`MSAW`/`RWY`; the camera does **not** move automatically (a `⌖` on the toast does).
5. **Command panel** (if the selected aircraft is involved): red banner with **resolution suggestions** computed from geometry — e.g., STCA: `Climb BAW117 +1000 ↑`, `Turn DLH2GK right 30°`, `Speed −20`; runway incursion: `Hold position`, `Cancel takeoff`, `Go around`; MSAW: `Climb to MSA 3000`. Each chip is a one-click prefilled draft (still confirmed with `Enter`).
6. **Sound**: per table; critical loops until `ACK`; muted automatically while the involved aircraft is selected (Endless behaviour) but the visual stays.

### 5.3 Acknowledge → resolve

- `ACK` stops the sound and collapses the toast into a pill in the top bar (`STCA BAW117/DLH2GK`); strip and map highlights remain until the engine clears the condition.
- **Resolved** when the engine condition clears (separation regained, runway vacated, altitude above floor): pill turns green "Resolved · −0.5" for 3 s, score delta floats, sound "resolve" chime, strip returns to normal.
- Unacknowledged critical alerts after 10 s escalate: the top bar tints red and the sound level rises one step (never above the user's alert volume).
- Multiple alerts stack by severity; the same pair never spawns duplicate toasts (the existing one updates its geometry line).

### 5.4 Emergency flow (end-to-end)

1. Pilot: "MAYDAY MAYDAY MAYDAY, BAW117, engine fire, request immediate return." → critical toast with the spoken text, strip turns red with `MAYDAY` chip, data block gains `EM` tag, `M` opens the emergency band.
2. `Enter` on the toast = **Acknowledge** (§1.4) → pilot gives POB/fuel/intentions; strip fills these fields.
3. Panel suggests **Priority runway** (best runway pre-selected) and **Dispatch services** (ARFF pre-ticked) as two large red chips; the Tower runway occupancy bar for the chosen runway shows `EMERG` and *Cleared for takeoff* on it becomes hard-blocked with the reason "sterile for emergency BAW117".
4. Vehicles roll (§6); their strips appear in `VEHICLES` with ETA vs the aircraft's ETA (the toast shows "ARFF on scene 01:10 before touchdown ✓" or "…40 s after ✗").
5. After landing the aircraft either stops on the runway (runway `closed`, vehicles gather, a `Reopen runway` chip appears after the pilot reports "fire out / request tow") or vacates; **Reopen runway** dispatches Ops for inspection (60 s) then reopens; the ATIS letter increments and the ATIS panel logs "27L reopened".
6. Score: +big for services on scene before touchdown and no other alert during the emergency; − for each departure cleared on the sterile runway or each STCA caused by the priority sequencing.

---

## 6. GROUND VEHICLES UX

**Vehicles panel** (Ground/Tower; `F7` or 🚒 in the map toolbar): glass drawer, 300 px, list of fleet cards.

| Vehicle | Card icon | Assignable to | Behaviour |
|---|---|---|---|
| ARFF (Fire 1–3) | red | runway, aircraft, map point | Drives via service roads/taxiways at 60 km/h; requests runway crossing like aircraft (auto-granted when *vehicle auto-cross* is on, else appears as a REQ strip); on scene: parks beside the target; runway stays `closed` while an ARFF vehicle is on it |
| Ambulance | white/red | aircraft (at stand or after landing), stand | as above, 50 km/h |
| Follow-me | yellow | aircraft | Aircraft's route becomes "follow vehicle"; the vehicle drives the built route (route builder opens); use for "request progressive taxi" |
| Tug / pushback truck | grey | aircraft (parked) | Explicit tug dispatch is optional: pushback approval auto-assigns the stand's tug; manual dispatch when a disabled aircraft needs a tow off the runway (`Tow`) |
| Ops / runway inspection | blue | runway | Drives the full runway length (~60–90 s), runway status `inspection` → `open`; auto-triggered by *Reopen runway after inspection* and by bird-strike reports |
| Sweeper / FOD | blue | runway, taxiway segment | 2–3 min, runway `closed` meanwhile |
| Bird control | green | runway, map point | 60 s, no closure |

**Assign flow (3 steps, same stepper component as the command tree):** ① pick vehicle card (multi-select for ARFF) ② pick target: chips *runway ▾* (`picker-runway`), *aircraft ▾* (`picker-aircraft` or click a strip/map target), *stand ▾*, *map point* (click the map, marker drops) ③ confirm → system log line "FIRE 1, FIRE 2 dispatched to RWY 27L, ETA 02:10." A vehicle strip appears in the `VEHICLES` bay; the map shows the vehicle icon with a label `FIRE 1 → 27L` and a dotted route; ETA counts down.

**Watch:** vehicle cards show status `Station → En route (mm:ss) → On scene → Returning`; clicking a card or its map icon selects it (panel shows *Recall*, *Re-task*, *Hold position*, *Cross runway* if it is holding short). Vehicles can trigger runway-incursion alerts exactly like aircraft.

**Recall:** `Recall` on the card / panel / strip (`Ctrl+R` with a vehicle selected) → returns to station; a runway it was closing reopens only after *Reopen runway* (explicit) — never silently.

**Quick dispatch from anywhere:** right-click a runway on the map → *Inspect runway*, *Send ARFF*, *Close/Open runway*; right-click a stand → *Ambulance to stand*, *Follow-me from stand*.

---

## 7. FEEDBACK & DELIGHT

### 7.1 Micro-interactions

| Element | Hover | Press | Success | Error / blocked |
|---|---|---|---|---|
| Action button | translate −1 px, glow border (mode colour), hotkey badge brightens | scale .97, 80 ms | 300 ms green ring sweep, hotkey badge ticks ✓ | 6-px horizontal shake ×2, red ring, reason tooltip pinned 2 s; disabled buttons don't shake — they show the reason inline |
| Mode tab | underline grows from centre | — | tab slides indicator 200 ms; map cross-fades layers | — |
| Toggle (expedite, immediate, LOC) | knob glow | spring (stiffness 300, damping 20) | — | — |
| Runway chip | wind arrow animates | — | selected chip fills and the runway on the map pulses once | disabled chip shows reason on hover |
| Heading dial | needle follows cursor with 60 ms lag, tick sound each 10° | — | dial snaps to the value, predicted arc on the map draws in 200 ms | out-of-range never possible |
| Altitude ladder | rung highlights, current/cmd markers animate | wheel scroll snaps per rung with a soft tick | rung lights blue, arrow ▲/▼ appears | red band rung → shake + "below MSA 2 300" |
| Speed rail | chip lifts | — | chip fills | envelope chips greyed with `min 140` label |
| Route builder | hovered taxiway glows on the map | tapped segment snaps into the chip rail with a pop (scale 1.1 → 1) | complete route draws head-to-tail 300 ms with hold-short bars pulsing | unreachable segment flashes red on the map |
| Confirm / TRANSMIT | fills solid | — | button morphs into the `TX` pill (radio-wave bars 400 ms), panel returns to root | amber *Transmit anyway* requires 600 ms hold (progress ring) |
| Strip | lifts 1 px, halo on map | — | bay move slides 240 ms; clearance box ticks with a stamp motion | drop rejected → snap back + shake |
| Alert toast | — | — | ack: collapses to a pill 200 ms | — |
| Score | — | — | number rolls (odometer), `+120` floats up from the strip and the top bar for 1.2 s | `−50` in red with a 3-px shake, no float |

### 7.2 Transmission and readback animation

1. `TRANSMIT` → top-bar `TX` lights, a small waveform animates, the ATC voice (optional) speaks the line with a bandpass filter; the comm-log line types out at ~40 chars/s with a caret; an `UNDO ↶ 2.9 s` chip with a shrinking ring sits at the line end.
2. After `PILOT_DELAY_S`: squelch click, the pilot line types out in cyan with the TTS voice (radio-filtered), 3 % chance of the "say again" branch (§1.7); when the readback matches, the relevant strip box ticks and the data block's pending value turns from yellow to white.
3. If the readback contains "unable …", the refused part is struck through in the ATC line and a small amber "unable" tag appears.
4. Voice input: while `Space` is held, the command line shows the live STT transcript with the parsed tokens highlighted (callsign green, verb blue, params white, unknown red); release → the AST goes to confirm (or transmits instantly with *voice = instant* on).

### 7.3 Sound list (all behind master / UI / radio / alerts / ambience sliders; UI sounds ≤ −18 dBFS, ≤ 120 ms)

UI tick (hover on dial/ladder) · UI select (chip) · confirm blip · error buzz (short, low) · hold-to-confirm ramp · PTT on / PTT off clicks · squelch open / close · ATC voice bed · pilot voice bed (bandpass 300–3400 Hz, light noise) · readback-ok stamp · undo "rewind" · strip slide (paper whisper) · bay push · handoff chirp · request "ding" · STCA two-tone · MSAW warble · runway-incursion klaxon · emergency 3-beep · wake thud · go-around rising chirp · resolve chime · score up (soft major third) · score down (muted thud) · landing rollout rumble (very low, Tower mode only) · sim-rate whoosh · pause / resume · ambient tower-room hum & distant airport (loopable, −30 dB, off by default).

---

## 8. ONBOARDING

- **First run (5 coach marks, skippable, 1 departure spawned):** ① "This is BAW117 — click it" (strip and map both highlighted) → ② "Only valid actions show. Press P or click Pushback" → ③ "Pick the runway — wind favours 27L" → ④ "Transmit with Enter; you have 3 s to undo" → ⑤ "Listen for the readback — the box on the strip ticks". Then: "Try T to taxi. Tip: type taxiway letters." A progress dot row sits at the bottom; `Esc` skips all.
- **Phase-triggered tips (once each, dismissable, stored in `localStorage`):** first `hold_short` ("W lines up, O clears for takeoff — check the runway bar"), first arrival on `approach` ("L clears to land; the bar shows if the runway is occupied"), first STCA ("Ack with Enter; the panel suggests fixes"), first REQ ("Enter accepts the highlighted answer"), first drag on the radar ("release to confirm the heading"), first `go_around` ("F hands off to Approach for re-sequencing").
- **Tooltips:** every control has `title` + hotkey badge; hovering a disabled control shows its reason; hovering a phase chip explains the phase.
- **Help overlay (`?` / `F1`)**: tabs *Hotkeys* (searchable map), *Phraseology* (per action: what ATC says / what the pilot says / when it is valid — generated from the same tree so it never drifts), *Phase → actions matrix*, *Alerts* (what each means and how to fix), *Glossary* (LUAW, LAHSO, MSA, STCA…). `Esc` closes.
- **Tutorial scenarios** from the home page: *One departure*, *One arrival*, *Crossing traffic*, *Emergency return*; scripted prompts appear as coach marks with the expected action highlighted.
- **Command-line hints:** the placeholder shows the three most likely commands for the selected aircraft (already partly in `page.tsx`); `Tab` autocompletes callsigns and taxiway names.

---

## 9. ACCESSIBILITY & ERROR PREVENTION

**Disabled-with-reason.** An action that is near-valid renders disabled (40 % opacity, no shake) with the reason as grey text under its label and in its tooltip; reasons are short and specific: "Runway 27L occupied by DLH2GK", "Not at the holding point yet", "Below 500 ft — too late for exit", "Past abort speed", "Needs heading and altitude", "H category not permitted on 27R", "Vehicle FIRE 1 on runway".

**Warn vs block matrix**

| Situation | Behaviour |
|---|---|
| Takeoff clearance, runway occupied by aircraft rolling / lined-up other aircraft / vehicle | **Hard block** |
| Takeoff clearance, arrival < 2 NM | **Hard block** |
| Takeoff clearance, arrival 2–4 NM, or wake timer running | **Soft** amber *Transmit anyway* (600 ms hold) |
| Landing clearance, runway occupied | **Soft** (occupant + expected vacate time shown); becomes **hard** at < 1 NM if still occupied |
| Landing clearance, runway closed / sterile / inspection | **Hard block** |
| Cross runway, arrival < 2 NM or departure rolling | **Hard block** |
| Line up, runway occupied | **Hard block** unless *behind landing aircraft* part |
| ILS clearance, intercept > 60° or above GS | **Soft** with geometry text |
| Altitude below MSA/floor | **Hard** (ladder red band not selectable) |
| Speed outside envelope | **Hard** (chips disabled) |
| Heading into restricted area below floor | **Soft** |
| Cancel takeoff > 80 kt | **Hard** |
| Exit at below 500 ft | **Hard** |
| Handoff while below FL90 with SID off | **Soft** ("counts as diversion") |
| Any command to an aircraft not on your frequency (strict realism) | **Hard**; else **Soft** note |

**Undo window** 3–5 s (= pilot delay) with visible countdown; no undo after execution (explicit cancels instead).

**Keyboard:** everything reachable; visible 2-px focus ring; `Tab` order = strips → panel → map toolbar → log; roving tabindex inside pickers; `Esc` always goes back one level; hotkey badges shown on buttons and toggleable; hotkeys never fire while an input has focus.

**Screen reader / ARIA:** strips = `listbox`/`option` with aria-label "BAW117, Boeing 737, departure, taxi, runway 27L, request pending"; pickers = `radiogroup`/`slider` with `aria-valuetext` ("heading 240"); confirm = `dialog`; comm log = `aria-live="polite"`, alerts = `aria-live="assertive"`; readbacks are captioned in the log even with voice on.

**Visual:** min body 12 px mono / 13 px sans, UI scale 90–130 % in Settings; colour never the sole channel (glyphs ▲▼ for DEP/ARR, icons per alert, hatching for closed runways); high-contrast theme (pure black panels, no blur); `prefers-reduced-motion` disables slides/springs/typing animation (lines appear instantly), keeps the undo ring.

**Pointer:** hit targets ≥ 32 px; drag gestures have keyboard equivalents (`V`, `D`, `T`); a 12-px drag threshold prevents accidental vectors; wheel-altitude is off unless the aircraft is selected and the cursor is over it.

**Error recovery:** parser failures in the command line highlight the offending token and offer the nearest valid completion; STT low-confidence never transmits (shows the draft instead); sim-rate auto-drops to 1× when a critical alert fires (setting).

---

## 10. INTERACTIVE ELEMENT INVENTORY (E2E checklist)

IDs are `data-testid` values. `{cs}` = callsign, `{rwy}` = runway end, `{n}` = index, `{id}` = entity id. "Where" uses: TOP (top bar), BAY (strip bay), MAP, PANEL (command panel), LOG (comm log), ATIS, VEH (vehicles), ALERT, HELP, PAUSE, SET (settings).

### Top bar
| id | Label | Where | Action |
|---|---|---|---|
| `brand-home` | ◆ SKYCONTROL | TOP | Link to `/` (confirms if a game is running) |
| `airport-badge` | EGLL | TOP | Opens airport/runway-config dialog |
| `mode-tab-ground` | GROUND | TOP | Switch mode (`F1`) |
| `mode-tab-tower` | TOWER | TOP | Switch mode (`F2`) |
| `mode-tab-approach` | APPROACH | TOP | Switch mode (`F3`) |
| `atis-chip` | ATIS K · 27L/27R · 260/08 | TOP | Toggle ATIS/weather panel (`F6`) |
| `clock-utc` | 12:34:56Z | TOP | Toggle sim-time popover |
| `rate-pause` | ⏸ / ▶ | TOP | Pause/resume (`Esc` when nothing selected) |
| `rate-1x` / `rate-2x` / `rate-4x` | 1× 2× 4× | TOP | Set sim rate (`,` `.`) |
| `rate-ff` | ⏩ | TOP | Hold for 8× fast-forward (`Shift+.` hold) |
| `score-chip` | 1,240 ▲ | TOP | Opens score breakdown popover |
| `alerts-bell` | 🔔 2 | TOP | Toggle alerts drawer |
| `tx-indicator` | ● TX | TOP | Visual only; click = toggle ATC voice |
| `settings-btn` | ⚙ | TOP | Open settings (`/settings` modal) |
| `help-btn` | ? | TOP | Open help overlay (`?`/`F1`) |
| `tts-toggle` | 🔊 | TOP (inside settings popover) | Toggle pilot TTS |

### Strip bay
| id | Label | Where | Action |
|---|---|---|---|
| `bay-collapse` | ◀ | BAY | Collapse/expand bay (`F4`) |
| `bay-rail-count-{bay}` | 3 | BAY (collapsed rail) | Expand and scroll to bay |
| `bay-section-{bay}` | PENDING / TAXI OUT / … | BAY | Header; click collapses section |
| `bay-sort-{bay}` | ⇅ | BAY | Sort menu (Auto/Callsign/Time/Runway) |
| `bay-sort-opt-{bay}-{key}` | Auto… | BAY | Apply sort |
| `bay-add-separator` | + SEP | BAY | Add named separator |
| `bay-separator-{id}` | — name — | BAY | Drag to move; double-click rename; `×` remove |
| `strip-{cs}` | strip card | BAY | Select (`Enter`), drag reorder/move, double-click centre map, right-click quick menu |
| `strip-{cs}-runway` | 27L | BAY | Opens runway picker (expect runway) |
| `strip-{cs}-box-{P|T|W|O|F|I|L|E}` | □ | BAY | Opens that action in the panel |
| `strip-{cs}-req` | REQ ▲ | BAY | Selects + focuses the suggested answer |
| `strip-{cs}-alert` | STCA | BAY | Selects + opens alert in panel |
| `strip-{cs}-draft` | Resume draft | BAY | Restores parked draft |
| `strip-{cs}-note` | annotation box | BAY | Edit free text (`Ctrl+Enter`) |
| `strip-{cs}-archive` | × | BAY (finished strips) | Archive (`Delete`) |
| `strip-vehicle-{id}` | FIRE 1 → 27L | BAY | Select vehicle |
| `strip-vehicle-{id}-recall` | RECALL | BAY | Recall vehicle |
| `bay-filter-all` / `-dep` / `-arr` / `-req` / `-alert` | ALL DEP ARR REQ ALERT | BAY | Filter strips |
| `bay-search` | 🔍 | BAY | Filter by text |
| `bay-tab-{mode}` (drop target) | GROUND/TOWER/APPROACH | BAY | Drop strip = push/handoff (confirm bubble) |
| `bay-push-confirm` / `bay-push-cancel` | Push to TOWER? ✓ ✗ | BAY | Confirm/cancel push |

### Map / radar
| id | Label | Where | Action |
|---|---|---|---|
| `map-canvas` | — | MAP | Click select/deselect, drag pan, wheel zoom, drag-to-heading, right-drag measure, route-build taps |
| `map-target-{cs}` | aircraft symbol (hit region) | MAP | Select; drag → heading/direct/ILS/taxi draft |
| `map-label-{cs}` | data block | MAP | Select; drag label to reposition (leader re-anchors) |
| `map-vehicle-{id}` | vehicle icon | MAP | Select vehicle |
| `map-fix-{id}` | BIG | MAP | Drop target for direct; click while `picker-fix` open selects |
| `map-runway-{rwy}` | runway end | MAP | Drop target for ILS; right-click runway menu; click while `picker-runway` open selects |
| `map-taxiway-{id}` | taxiway segment | MAP | Click while route builder open appends |
| `map-stand-{ref}` | stand | MAP | Click while `picker-gate` open selects; right-click stand menu |
| `map-hdg-bubble` | Fly heading 240 [L][R] ⏎ | MAP | Confirm drag vector; `Esc` cancels |
| `map-hdg-bubble-left` / `-right` / `-send` / `-cancel` | L / R / ⏎ / ✕ | MAP | Set dir / send / cancel |
| `map-dct-bubble-send` | Direct BIG ⏎ | MAP | Send |
| `map-ils-bubble-send` | Cleared ILS 27L ⏎ | MAP | Send |
| `map-edge-arrow` | ▶ | MAP | Pan to off-screen selected aircraft |
| `map-tooltip` | hover card | MAP | None (info) |
| `map-measure-{n}` | measure line | MAP | Click = remove; `Esc` clears all |
| `map-conflict-line-{a}-{b}` | STCA line | MAP | Click = select pair |
| `tool-zoom-in` / `tool-zoom-out` | + − | MAP toolbar | Zoom (`+`/`−`) |
| `tool-follow` | ⌖ | MAP toolbar | Toggle follow selected (`F` with map focus) |
| `tool-rings` | ◎ | MAP toolbar | Toggle range rings (`Ctrl+R`) |
| `tool-rings-centre-field` / `-selected` | field / selected | MAP toolbar | Ring centre |
| `tool-measure` | ⟷ | MAP toolbar | Measure tool (click-click mode) |
| `tool-layers` | ▦ | MAP toolbar | Layers popover |
| `layer-satellite` / `layer-chart` | Satellite / Chart | MAP layers | Ground theme (`LS_KEYS.groundTheme`) |
| `layer-3d` | 2.5D | MAP layers | Toggle `Ground3DView` |
| `layer-labels-taxiway` / `layer-labels-stand` / `layer-holdbars` / `layer-ils` / `layer-wake` / `layer-restricted` / `layer-trails` | toggles | MAP layers | Show/hide |
| `layer-leader-length` | 30s / 1m / 2m | MAP layers | Leader length |
| `tool-presets` | ▣ | MAP toolbar | Presets popover |
| `preset-auto-{id}` | Overview / RWY 27L / Apron N… | MAP presets | Recall camera |
| `preset-user-{1..6}` | 1–6 | MAP presets | Recall (`Shift+n`); `Ctrl+Shift+n` saves |
| `preset-save-{1..6}` | save | MAP presets | Save current camera |
| `tool-north-up` | N | MAP toolbar (3D) | Reset rotation |
| `tool-vehicles` | 🚒 | MAP toolbar (Ground/Tower) | Toggle vehicles panel (`F7`) |
| `runway-bar-{rwy}` | 27L ● FREE | MAP (Tower occupancy bars) | Click = select occupant / right-click runway menu |
| `ctx-aircraft-{action}` | radial items | MAP context | Start action stepper |
| `ctx-aircraft-more` | More… | MAP context | Open panel |
| `ctx-map-measure` / `ctx-map-note` / `ctx-map-centre` / `ctx-map-save-preset` | items | MAP context | As labelled |
| `ctx-runway-inspect` / `ctx-runway-arff` / `ctx-runway-close` / `ctx-runway-open` | items | MAP runway context | Dispatch / status |
| `ctx-stand-ambulance` / `ctx-stand-followme` | items | MAP stand context | Dispatch |

### Command panel
| id | Label | Where | Action |
|---|---|---|---|
| `panel-close` | × | PANEL | Deselect (`Esc`) |
| `panel-pin` | 📌 | PANEL | Keep panel open when deselected |
| `panel-locate` | ⌖ | PANEL header | Centre map on aircraft |
| `panel-view-in-{mode}` | View in TOWER ↗ | PANEL header | Switch mode keeping selection |
| `panel-req-band` | REQ: request pushback | PANEL header | Click = run suggested action (`Enter`) |
| `panel-req-unable` | Unable | PANEL header | Opens reason chips (`N`) |
| `panel-req-standby` | Standby | PANEL header | Transmit standby (`Y`) |
| `panel-emerg-band` | MAYDAY · engine fire | PANEL header | Expands emergency actions (`M`) |
| `panel-metric-alt` / `-spd` / `-hdg` | ALT SPD HDG | PANEL | Click = open the corresponding picker |
| `panel-draft-resume` | Resume draft | PANEL header | Restore draft |
| `action-pushback` | Pushback approved | PANEL | `P` |
| `action-startup` | Start-up approved | PANEL | `P` |
| `action-taxi-runway` | Taxi to runway | PANEL | `T` |
| `action-taxi-stand` | Taxi to stand | PANEL | `T` |
| `action-taxi-point` | Taxi to point | PANEL | `T` → point |
| `action-amend-route` | Amend route | PANEL | `T` |
| `action-hold-short` | Hold short of | PANEL | `H` |
| `action-hold-position` | Hold position | PANEL | `H` → here |
| `action-hold-fix` | Hold at fix | PANEL | `H` (airborne) |
| `action-continue` | Continue taxi | PANEL | `X` |
| `action-cross` | Cross runway | PANEL | `X` |
| `action-lineup` | Line up and wait | PANEL | `W` |
| `action-takeoff` | Cleared for takeoff | PANEL | `O` |
| `action-cancel-takeoff` | Cancel takeoff | PANEL | `C` |
| `action-cancel-lineup` | Vacate runway | PANEL | `C` |
| `action-land` | Cleared to land | PANEL | `L` |
| `action-goaround` | Go around | PANEL | `G` |
| `action-cancel-approach` | Cancel approach clearance | PANEL | `C` |
| `action-exit` | Exit / vacate | PANEL | `E` |
| `action-plan-exit` | Plan exit | PANEL | `E` |
| `action-heading` | Vector | PANEL | `V` |
| `action-altitude` | Climb / descend | PANEL | `A` |
| `action-speed` | Speed | PANEL | `S` |
| `action-direct` | Direct | PANEL | `D` |
| `action-resume-sid` | Resume SID | PANEL | `D` → resume |
| `action-ils` | Cleared ILS | PANEL | `I` |
| `action-expect-runway` | Expect runway | PANEL | `I` → expect |
| `action-change-runway` | Change runway | PANEL | `I` |
| `action-expedite` | Expedite | PANEL | `A` → `E` |
| `action-handoff` | Contact … | PANEL | `F` |
| `action-report` | Report | PANEL | `R` |
| `action-say-again` | Say again | PANEL | `R` → say again |
| `action-correction` | Correction | PANEL | `R` → correction |
| `action-standby` | Standby | PANEL | `Y` |
| `action-unable` | Unable | PANEL | `N` |
| `action-giveway` | Give way / follow | PANEL | `J` |
| `action-wind-check` | Wind check | PANEL | `R` |
| `action-turnaround` | Schedule as departure | PANEL (arrived, sandbox) | Opens scheduler |
| `emerg-ack` | Acknowledge mayday | PANEL | `M` / `Enter` |
| `emerg-priority` | Priority runway | PANEL | `M` → `I` |
| `emerg-dispatch` | Dispatch services | PANEL | `M` → `D` |
| `emerg-hold-all` | Hold all traffic | PANEL | `M` → `H` |
| `emerg-breakoff` | Break off other arrival | PANEL | `M` → `B` |
| `emerg-stop-runway` | Stop on runway / vacate | PANEL | `E` |
| `emerg-reopen` | Reopen runway | PANEL | `M` → `R` |
| `emerg-cancel-ack` | Roger, mayday cancelled | PANEL | `Enter` |
| `suggest-{n}` | resolution chip (e.g. Climb +1000) | PANEL alert banner | Prefill draft |
| `step-back` | BACK | PANEL stepper | `Backspace` |
| `step-cancel` | CANCEL | PANEL stepper | `Esc` |
| `step-next` | NEXT | PANEL stepper | `Enter` |
| `confirm-transmit` | TRANSMIT | PANEL confirm | `Enter` |
| `confirm-transmit-anyway` | TRANSMIT ANYWAY (hold) | PANEL confirm | 600 ms hold |
| `confirm-blocked-reason` | reason text | PANEL confirm | None (info) |
| `confirm-part-{n}` | part chip | PANEL confirm | Click = edit that step |
| `confirm-part-{n}-remove` | × | PANEL confirm | Remove part |
| `confirm-add-part` | + ADD PART | PANEL confirm | Opens part chips (`+`) |
| `confirm-add-{part}` | then ILS / climb to / … | PANEL confirm | Adds part |
| `picker-runway-{rwy}` | 27L | PANEL | Select runway (`1–9`) |
| `picker-runway-mode-ils` / `-loc` / `-visual` | ILS / LOC / VIS | PANEL | Approach type |
| `picker-route-chip-{n}` | A | PANEL route bar | Click = remove from here |
| `picker-route-auto` | AUTO | PANEL | `findPath` fill |
| `picker-route-clear` | CLEAR | PANEL | Empty route |
| `picker-route-holdshort` | hold short of ▾ | PANEL | Adds hold-short pill |
| `picker-route-cross` | cross runway ▾ | PANEL | Adds cross pill |
| `picker-route-intersection` | at intersection ▾ | PANEL | Adds intersection target |
| `picker-route-contact-tower` | contact tower at hold | PANEL | Toggle part |
| `picker-route-dest` | destination chip | PANEL | Opens runway/gate picker |
| `picker-heading-dial` | dial | PANEL | Drag/keys set heading |
| `picker-heading-input` | 240 | PANEL | Type heading |
| `picker-heading-left` / `-right` / `-shortest` | L / R / — | PANEL | Turn direction |
| `picker-heading-minus5` / `-plus5` / `-minus10` / `-plus10` | ±5 ±10 | PANEL | Nudge |
| `picker-heading-runway-hdg` | runway heading | PANEL (after-departure / go-around) | Preset |
| `picker-alt-ladder` | ladder | PANEL | Click rung / wheel / keys |
| `picker-alt-input` | 3000 | PANEL | Type |
| `picker-alt-expedite` | EXPEDITE | PANEL | Toggle (`E`) |
| `picker-alt-half-steps` | 500 ft | PANEL | Toggle |
| `picker-speed-rail` | rail | PANEL | Select |
| `picker-speed-chip-{kt}` | 210 | PANEL | Select |
| `picker-speed-final` | final approach speed | PANEL | Preset |
| `picker-speed-resume` | resume normal speed | PANEL | Preset |
| `picker-speed-until-4nm` | until 4 NM | PANEL | Toggle part |
| `picker-fix-search` | search | PANEL | Filter |
| `picker-fix-{id}` | BIG · 045°/12 NM | PANEL | Select |
| `picker-hold-inbound` | inbound course | PANEL | Heading dial |
| `picker-hold-turns-left` / `-right` | L / R | PANEL | Turn dir |
| `picker-hold-leg-{1m|1.5m|4nm}` | leg | PANEL | Leg length |
| `picker-hold-efc-{10|20|30}` | EFC +10 | PANEL | EFC |
| `picker-dir-left` / `-right` | ◀ LEFT / RIGHT ▶ | PANEL | Direction |
| `picker-dir-{N|E|S|W}` | facing | PANEL | Pushback facing |
| `picker-exit-next-left` / `-next-right` | next available L/R | PANEL | Preset |
| `picker-taxiway-{id}` | A5 | PANEL | Select |
| `picker-gate-{ref}` | S512 | PANEL | Select |
| `picker-position-{ground|tower|departure|approach}` | GROUND 121.9… | PANEL | Select |
| `picker-aircraft-{cs}` | DLH2GK · 2.1 NM final | PANEL | Select |
| `picker-info-{heading|position|airspeed|pob|fuel|nature|dg|intentions}` | chips | PANEL | Toggle |
| `picker-unable-reason-{traffic|wake|closed|slot|standby}` | chips | PANEL | Select reason |
| `picker-takeoff-immediate` | immediate | PANEL | Toggle |
| `picker-takeoff-contact-on-reaching` | on reaching contact departure | PANEL | Toggle |
| `picker-takeoff-wind` | wind (auto) | PANEL | Toggle include wind |
| `picker-lineup-behind` | behind next landing | PANEL | Opens aircraft picker |
| `picker-land-lahso` | hold short of ▾ | PANEL | Opens runway/taxiway picker |
| `picker-land-exit` | exit at ▾ | PANEL | Opens taxiway picker |
| `picker-ga-runway-heading` / `-climb` / `-contact` | parts | PANEL | Toggle parts |
| `picker-emerg-scope-{departures|crossings|all}` | chips | PANEL | Hold-all scope |
| `picker-emerg-location-{runway|aircraft|stand|map}` | chips | PANEL | Dispatch target |
| `picker-emerg-sterile` / `-number-one` / `-straight-in` | chips | PANEL | Priority options |

### Comm log & command line
| id | Label | Where | Action |
|---|---|---|---|
| `log-collapse` | ▾ | LOG | Collapse/expand (`F5`) |
| `log-filter-{gnd|twr|app|all}` | GND TWR APP ALL | LOG | Filter by frequency |
| `log-line-{key}` | line | LOG | Click = select the aircraft named |
| `log-line-{key}-undo` | ↶ UNDO 2.9s | LOG | Disregard within window (`U`/`Ctrl+Z`) |
| `log-line-{key}-repeat` | REPEAT | LOG (ATC lines after "say again") | Reopen as draft |
| `log-line-{key}-replay` | ↻ | LOG (pilot lines) | Say again / replay TTS |
| `log-line-{key}-correct` | CORRECT | LOG (readback mismatch) | Opens correction draft |
| `log-last-called` | Last plane called | LOG | `Shift+R` |
| `cmd-input` | › | LOG footer | Type command; `Tab` autocomplete; `Enter` parse → confirm (or send with *typed = instant*); `` ` `` focuses |
| `cmd-autocomplete-{n}` | suggestion | LOG footer | Insert |
| `cmd-send` | SEND | LOG footer | Parse/transmit |
| `cmd-ptt` | ● PTT | LOG footer | Hold = listen (`Space` hold); shows live transcript |
| `cmd-ptt-transcript` | transcript | LOG footer | Info; click token = edit |

### ATIS / weather panel
| id | Label | Where | Action |
|---|---|---|---|
| `atis-close` | × | ATIS | Close |
| `atis-letter` | Information K | ATIS | Click = re-broadcast ATIS line |
| `atis-wind` / `atis-vis` / `atis-cloud` / `atis-qnh` / `atis-temp` | values | ATIS | Info |
| `atis-runway-{rwy}-status` | OPEN / CLOSED / STERILE / INSPECTION / WET | ATIS | Click = status menu |
| `atis-runway-{rwy}-close` / `-open` / `-inspect` | items | ATIS | Change status (confirm) |
| `atis-runway-config` | Change active runways | ATIS | Opens runway-config dialog |
| `rwycfg-end-{rwy}-dep` / `-arr` | DEP / ARR toggles | dialog | Set roles |
| `rwycfg-end-{rwy}-weight-{L|M|H|J}` | weight toggles | dialog | Allowed classes |
| `rwycfg-apply` / `rwycfg-cancel` | Apply / Cancel | dialog | Apply (ATIS letter increments) |
| `atis-broadcast` | Broadcast ATIS | ATIS | Adds SYS line "All stations, information L…" |

### Alerts
| id | Label | Where | Action |
|---|---|---|---|
| `toast-{id}` | toast card | ALERT stack | Focusable |
| `toast-{id}-ack` | ACK | ALERT | Acknowledge (`Enter`) |
| `toast-{id}-select` | SELECT | ALERT | Select first aircraft (`Tab` toggles pair) |
| `toast-{id}-locate` | ⌖ | ALERT | Centre map |
| `toast-{id}-mute` | MUTE 1 min | ALERT | Silence sound only |
| `toast-overflow` | +N | ALERT | Opens drawer |
| `alert-pill-{id}` | STCA BAW117/DLH2GK | TOP | Click = select pair |
| `alerts-drawer` | drawer | ALERT | List |
| `alerts-drawer-close` | × | ALERT | Close |
| `alerts-row-{id}` | row | ALERT | Select + centre |
| `alerts-clear-resolved` | Clear resolved | ALERT | Remove resolved rows |
| `alerts-filter-{critical|warning|info}` | chips | ALERT | Filter |

### Vehicles panel
| id | Label | Where | Action |
|---|---|---|---|
| `veh-panel-close` | × | VEH | Close |
| `veh-card-{id}` | FIRE 1 · Station | VEH | Select; `Space` multi-select |
| `veh-card-{id}-dispatch` | DISPATCH | VEH | Starts assign stepper |
| `veh-card-{id}-recall` | RECALL | VEH | Recall (`Ctrl+R`) |
| `veh-card-{id}-retask` | RE-TASK | VEH | Reopens target step |
| `veh-card-{id}-hold` | HOLD | VEH | Stop vehicle |
| `veh-card-{id}-cross` | CROSS RUNWAY | VEH (when holding short) | Grant crossing |
| `veh-target-runway` / `-aircraft` / `-stand` / `-map` | target chips | VEH | Choose target type |
| `veh-confirm` / `veh-cancel` | DISPATCH ✓ / CANCEL | VEH | Confirm |
| `veh-auto-cross` | Auto-grant crossings | VEH footer | Toggle |

### Help, pause, settings, onboarding
| id | Label | Where | Action |
|---|---|---|---|
| `help-overlay` | — | HELP | `Esc` closes |
| `help-tab-{hotkeys|phraseology|matrix|alerts|glossary}` | tabs | HELP | Switch tab |
| `help-search` | search | HELP | Filter |
| `help-close` | × | HELP | Close |
| `pause-menu` | — | PAUSE | Opened by `Esc` with nothing selected |
| `pause-resume` / `pause-restart` / `pause-runways` / `pause-settings` / `pause-tracks` / `pause-quit` | items | PAUSE | As labelled (quit confirms) |
| `set-volume-{master|ui|radio|alerts|ambience}` | sliders | SET | Volume |
| `set-tts` / `set-atc-voice` / `set-stt` | toggles | SET | Voice features |
| `set-instant-vectors` / `set-typed-instant` / `set-voice-instant` | toggles | SET | Skip confirm per input |
| `set-pilot-delay` | slider 2–8 s | SET | `PILOT_DELAY_S` |
| `set-strict-frequencies` / `set-readback-errors` / `set-bad-radio` / `set-auto-handoff` / `set-auto-sequence` / `set-auto-slow-on-alert` | toggles | SET | Realism |
| `set-phraseology-{icao|faa}` | ICAO / FAA | SET | Wording variant |
| `set-theme-{dark|contrast}` / `set-ui-scale` / `set-reduced-motion` / `set-hotkey-badges` | display | SET | Display |
| `set-leader-length` / `set-label-lines` | radar | SET | Radar |
| `set-reset-tips` | Replay onboarding | SET | Clears tip flags |
| `tip-{n}` | coach mark | overlay | `Enter` next, `Esc` skip |
| `tip-skip-all` | Skip | overlay | Ends onboarding |
| `loading-overlay` | LOADING EGLL | overlay | Non-interactive (assert appears/disappears) |

### Home / start config (already exists; kept for the checklist)
| id | Label | Where | Action |
|---|---|---|---|
| `home-airport-{icao}` | EGLL… | `/` | Choose airport |
| `home-runway-{rwy}` / `home-weight-{rwy}-{cls}` | toggles | `/` | Start config (`skycontrol_start_config`) |
| `home-start` | START | `/` | Navigate to `/atc` |
| `home-tutorial-{id}` | tutorials | `/` | Start scripted scenario |

---

## Appendix A — Engine gaps this UX needs (for the implementation plan)

1. **Phases:** add `startup` and `go_around` to `FlightPhase`; `initiateGoAround` should set `go_around` and transition to `climb` on handoff.
2. **Emergency substate** on `AircraftState` (+ spawn hooks and pilot call lines).
3. **New commands:** `cmdStartup, cmdHoldPosition, cmdHoldShortOf(node), cmdCrossRunway(rwy), cmdContinue, cmdTaxiToNode, cmdVacateLineup, cmdCancelTakeoff, cmdCancelApproach(hdg, alt), cmdExitAt(taxiway|dir), cmdLOC, cmdExpectRunway, cmdResumeSid, cmdHandoff(position), cmdStandby, cmdUnable(reason), cmdReport(kind), cmdGiveWay(cs), cmdDisregard, cmdSayAgain, cmdCorrection, cmdEmergencyAck/priority/holdAll, vehicle dispatch/recall, runway status (open/closed/sterile/inspection)`, and departure-clearance fields (`afterDepHdg`, `initialAlt`, `autoHandoffAlt`, `immediate`), LAHSO/exit fields on landing.
4. **Conditional/pending commands:** extend `PendingCmd` with `condition` (`altitude ≤ x`, `after fix`, `on reaching`, `after pushback`, `behind aircraft`).
5. **Pilot requests & readback events:** emit `request` events (push/start/taxi/ready/cross/with-you/higher/direct) and `readback` events (ok / unable part / say again / wrong value) so the UI can drive REQ chips, strip boxes, and the correction flow.
6. **Predictive alerts:** STCA prediction (CPA within 60 s), MSAW, and runway-incursion detection with vehicles; expose alert objects with `ack`/`resolved` state.
7. **Vehicles:** entity type with service-road routing, runway-crossing holds, and status.
8. **CommandAST:** a single AST type consumed by `parseCommand`, the click stepper, and STT, with `toTransmission()` / `toReadback()` generators (ICAO and FAA variants).

## Sources consulted
- FeelThere, *Start Guide – Basics for Tower! Simulator 3* (command grammar: `#airplane1; RUNWAY; #runway1; … CLEARED FOR TAKEOFF`, LUAW behind landing traffic, hold short/cross, exit-at rules, "with you", "last plane called") — https://feelthere.com/wp-content/uploads/2022/12/Start-Guide-Basics-for-Tower-Simulator-3.pdf
- FeelThere dev blog #3 (digital strips, ground radar, view shortcuts) — https://feelthere.com/tower-simulator-developer-blog-3/
- Tower!3D Pro command list (Steam guide) — https://steamcommunity.com/sharedfiles/filedetails/?id=1102803376
- startgrid, *Endless ATC instructions* (drag-to-heading, drag-to-beacon, wheel altitude/speed, OK/Cancel, long-press ILS*, keyboard grammar A30/S170/DPAM) — https://startgrid.blogspot.com/2013/11/endless-atc-instructions.html
- VRC docs, *The Flight Strip Bay* (columns, insertion line on drag, annotation boxes, separators, colour by type) — https://vrc.rosscarlson.dev/docs/doc.php?page=the_flight_strip_bay
- vNAS, *vStrips Controller Manual* (bays per position, departure vs arrival strip fields, push to bay, `Ctrl+Alt+1–9`) — https://docs.virtualnas.net/vstrips/
- Project files: `/root/atc/context/product_overview.md`, `/root/atc/context/approach_atc.md`, `/root/atc/src/app/atc/page.tsx`, `/root/atc/src/lib/sim/commands.ts`, `/root/atc/src/lib/sim/types.ts`, `/root/atc/src/lib/sim/engine.ts`, `/root/atc/src/components/atc/simStore.ts`, `/root/atc/refrence/design_language/`.


---
# CRITIC ADDENDUM
# ADDENDUM — Completeness review of the SkyControl Interaction Model (coverage lens)

Each item is a gap that would stop an engineer building from the spec alone. The fix is written out; adopt verbatim or edit. Code references are to `/root/atc/src/lib/sim/*.ts` at HEAD.

---

## G1. WRONG: the spec gates on phases the engine does not actually hold

`aircraft.ts:192-200` recomputes `climb / cruise / descent / approach` **every tick** from `altitude` vs `targetAltitude`, and forces `approach` whenever `ilsCaptured`. `engine.ts:204` spawns boundary arrivals directly into `approach`; one tick later they read `cruise` (altitude == target). `engine.ts:698-706` flips to `landing` on LOC+GS capture inside **8 NM**, not the spec's "≤ 4 NM / ≤ 1500 ft". `engine.ts:189` spawns departures already in `taxi` (no `parked`/`pushback`, so the `parked` table never fires). `initiateGoAround` sets `climb`, then the derived logic takes over.

Consequences: an arrival and a departure both read `cruise`; "Expect runway [I]" (spec: `cruise`) and "Cleared ILS [I]" (spec: `descent`) are gated on a number that flips with every altitude command; a departure that levels off shows "Descend" as the default verb.

**Replace phase gating with `kind × stage`.** Add to `types.ts`:

```ts
export type Stage =
  // ground (== phase)
  | 'parked' | 'startup' | 'pushback' | 'taxi_out' | 'taxi_in' | 'hold_short_dep' | 'hold_short_cross'
  | 'lineup' | 'takeoff_roll' | 'takeoff_air' | 'rollout' | 'arrived'
  // airborne
  | 'dep_climb' | 'dep_level' | 'go_around'
  | 'arr_inbound' | 'arr_armed' | 'arr_established' | 'arr_final' | 'arr_short_final'
  | 'departed';

export function stage(a: AircraftState, air: OsmAirport): Stage
```

Derivation rules (single function, unit-tested):

| Stage | Predicate |
|---|---|
| `taxi_out` / `taxi_in` | `phase==='taxi' && kind==='departure'` / `'arrival'` |
| `hold_short_dep` | `phase==='hold_short' && path.holdAt is the entry node of plan.runway` |
| `hold_short_cross` | `phase==='hold_short'` and the hold node is a crossing of a runway that is not `plan.runway` (or any runway for an arrival) |
| `takeoff_roll` / `takeoff_air` | `phase==='takeoff' && altitude < 50` / `≥ 50` (ft AGL) |
| `go_around` | `a.goAround === true` (**NEW** flag set by `initiateGoAround`, cleared by handoff or new ILS clearance) |
| `dep_climb` / `dep_level` | departure, airborne, `altitude < targetAltitude-50` / else |
| `arr_inbound` | arrival, airborne, `!ilsArmed` |
| `arr_armed` | `ilsArmed && !ilsCaptured` |
| `arr_established` | `ilsCaptured && phase !== 'landing'` |
| `arr_final` | `phase==='landing' && distToThreshold > 4 NM` |
| `arr_short_final` | `phase==='landing' && distToThreshold ≤ 4 NM` |

Everywhere §1.4 says `climb`, `cruise`, `descent`, `approach`, `landing`, read it as the stage columns in G2. Keep `FlightPhase` for physics; the UI never reads it directly.

Also state explicitly: **departures must spawn in `parked`** (today `taxi`), with `plan.taxiRoute` empty and a `request pushback` event after 20–90 s (see G8). `spawnDeparture()` keeps its current behaviour only in the `+ DEP` sandbox button with "spawn at hold" option.

---

## G2. MISSING: the phase × action matrix (`actionsFor` cannot be written from §1.4)

§1.4 lists actions per phase table but never says which actions are **disabled-with-reason** vs **hidden** in the other phases, and the reason strings are scattered. The matrix below is the single source; `actionsFor(a)` returns rows where the stage is `●` (enabled) or `○` (disabled with the named reason); `—` = not rendered.

Legend for reasons (canonical strings, also used as `data-reason`):
R1 "Not at the holding point yet" · R2 "Already on the runway" · R3 "Runway {rwy} occupied by {occ}" · R4 "Arrival {cs} {n} NM final" · R5 "Past abort speed" · R6 "Below 500 ft — too late for exit" · R7 "Needs heading and altitude" · R8 "{cls} category not permitted on {rwy}" · R9 "Not established" · R10 "Not positioned — vector first" · R11 "Not moving" · R12 "No hold active" · R13 "Not on your frequency" · R14 "Runway {rwy} closed" · R15 "No route" · R16 "Airborne — use Go around" · R17 "On the ground" · R18 "Already cleared" · R19 "Stand {ref} occupied by {cs}" · R20 "No ILS on this airport" · R21 "Pushback not required at stand {ref}" · R22 "Runway {rwy} not active for {dep|arr}" · R23 "Traffic hold — wait" · R24 "Emergency in progress"

| Action (id) | parked | startup | pushback | taxi_out | taxi_in | hs_dep | hs_cross | lineup | to_roll | to_air | dep_climb / dep_level | go_around | arr_inbound | arr_armed | arr_established | arr_final | arr_short_final | rollout | arrived |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `action-pushback` | ● (○R21 if !needsPushback) | — | ○R18 | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| `action-startup` | ● (○ if needsPushback: "Use Pushback") | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| `action-taxi-runway` | ○ "Push back first" | ● | ● (conditional) | ● (=amend) | — | ● (change rwy) | ● | — | — | — | — | — | — | — | — | — | — | — | — |
| `action-taxi-stand` | — | — | — | ● (return to stand) | ● | — | ● | — | — | — | — | — | — | — | — | — | — | ● (conditional) | — |
| `action-taxi-point` | — | ● | — | ● | ● | ● | ● | — | — | — | — | — | — | — | — | — | — | — | — |
| `action-amend-route` | — | — | — | ● | ● | ● | ● | — | — | — | — | — | — | — | — | — | — | — | — |
| `action-hold-short` | — | — | — | ● | ● | ○R18 | ○R18 | — | — | — | — | — | — | — | — | — | — | ● (after vacating) | — |
| `action-hold-position` | — | ● (○R11) | ● | ● | ● | ● | ● | ● (hold in position) | — | — | — | — | — | — | — | — | — | ● | — |
| `action-hold-fix` | — | — | — | — | — | — | — | — | — | ○ "Below 1000 ft" | ● | ● | ● | ● (soft: cancels ILS) | ○R9→"Use Cancel approach" | — | — | — | — |
| `action-continue` | — | — | ● (resume push) | ● iff `trafficHold\|\|(!holdReleased && hold is not a runway)` else — | same | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| `action-cross` | — | — | — | ● iff next hold is runway crossing | same | — | ● | — | — | — | — | — | — | — | — | — | — | — | — |
| `action-lineup` | — | — | — | ● iff < 200 m from hold else ○R1 | — | ● | ○ "Holding to cross, not to depart" | ○R18 | — | — | — | — | — | — | — | — | — | — | — |
| `action-takeoff` | — | — | — | ● (on reaching) | — | ● | — | ● | ○R18 | — | — | — | — | — | — | — | — | — | — |
| `action-cancel-takeoff` | — | — | — | — | — | — | — | — | ● iff GS<80 kt else ○R5 | ○R16 | — | — | — | — | — | — | — | — | — |
| `action-cancel-lineup` | — | — | — | — | — | — | — | ● | — | — | — | — | — | — | — | — | — | — | — |
| `action-land` | — | — | — | — | — | — | — | — | — | — | — | ○R10 | ○ "Not on approach" | ○R9 | ● | ● | ● | ○R18 | — |
| `action-goaround` | — | — | — | — | — | — | — | — | ○R17 | — | — | ○R18 | — | — | ● | ● | ● | ○R17 | — |
| `action-cancel-approach` | — | — | — | — | — | — | — | — | — | — | — | — | — | ● | ● | ● (>2 NM) else ○ "Use Go around" | ○ "Use Go around" | — | — |
| `action-exit` (vacate) | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | ● | ● iff AGL ≥ 500 else ○R6 | ● | — |
| `action-plan-exit` | — | — | — | — | — | — | — | — | — | — | — | — | — | — | ● | ● | — | — | — |
| `action-heading` | — | — | — | — | — | — | — | — | — | ● (soft <400 ft) | ● | ● | ● | ● (soft "cancels ILS clearance") | ○ "Use Cancel approach (C)" | ○ same | ○ same | — | — |
| `action-altitude` | — | — | — | — | — | — | — | — | — | ● | ● | ● | ● | ● | ○ "On glideslope — use Cancel approach" | ○ | ○ | — | — |
| `action-speed` | — | — | — | — | — | — | — | — | — | ● | ● | ● | ● | ● | ● (restricted rail) | ● (restricted) | ○ "Final approach speed" | — | — |
| `action-direct` | — | — | — | — | — | — | — | — | — | ● | ● | ● | ● | ● (soft cancels ILS) | ○ "Use Cancel approach" | ○ | ○ | — | — |
| `action-resume-sid` | — | — | — | — | — | — | — | — | — | — | ● iff navMode!=='sid' && SID exists | — | — | — | — | — | — | — | — |
| `action-ils` | — | — | — | — | — | — | — | — | — | — | — | ● iff >4 NM && below GS else ○R10 | ● (○R20 if no ILS runways) | ● (re-clear other rwy) | ○R18 | — | — | — | — |
| `action-expect-runway` | — | — | — | — | — | — | — | — | — | — | — | — | ● | — | — | — | — | — | — |
| `action-change-runway` | — | — | — | — | — | — | — | — | — | — | — | — | — | ● | ● iff parallel && >4 NM else ○ "Too close to switch" | ○ | ○ | — | — |
| `action-expedite` | — | — | — | — | — | — | — | — | — | ● | ● | ● | ● | ● | — | — | — | — | — |
| `action-handoff` | — | ● (→TWR when ≤1 hold from rwy) | — | ● | ● (→GND) | ● | ● | — | — | ● | ● | ● (default) | ● | ● | ● (→TWR) | ● | ● | ● (→GND) | — |
| `action-report` | ● | ● | ● | ● | ● | ● | ● | ● | — | ● | ● | ● | ● | ● | ● | ● | ● (wind check only) | ● | — |
| `action-say-again` / `action-correction` | any stage with a pilot line in the last 60 s; else — |
| `action-standby` / `action-unable` | any stage with a pending REQ; `standby` also ● in parked/startup/hold_short without REQ |
| `action-giveway` | — | ● | — | ● | ● | ● | ● | — | — | — | — | — | — | — | — | — | — | — | — |
| `action-wind-check` | — | — | — | — | — | ● | — | ● | — | — | — | — | — | — | ● | ● | ● | — | — |
| `action-turnaround` | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | ● (sandbox) |
| `emerg-*` | rendered only when `a.emergency` exists, in every stage; individual rows: `emerg-priority` hidden on ground; `emerg-stop-runway` only in arr_final/arr_short_final/rollout; `emerg-reopen` only when a runway status is `closed` for this aircraft |

Root-hotkey resolution when one letter maps to two visible actions (not covered in §1.3):
- `X`: `cross` wins over `continue` when both predicates hold.
- `T`: `taxi_out` → `amend-route`; `startup` → `taxi-runway`; `taxi_in`/`rollout` → `taxi-stand`; `hold_short` → `taxi-runway` (change runway). Second press of `T` cycles the alternatives.
- `H`: ground → `hold-short` (with "here" chip); airborne → `hold-fix`; `lineup` → `hold-position`.
- `I`: `arr_inbound` → `ils` (default) with `expect-runway` as a sub-chip; `arr_armed/established` → `change-runway`.
- `E`: never used by the emergency band (see G6); emergency actions are `M` chords only.

---

## G3. MISSING: unsafe-action guards not in the §9 matrix

Add these rows to the warn/block matrix. "Hard" = button replaced by reason; "Soft" = amber hold-to-transmit.

| Situation | Behaviour | Where the check reads its data |
|---|---|---|
| Takeoff / line-up on a runway whose `runwayStatus` ≠ `open` (closed, sterile, inspection) | **Hard** R14 | `engine.runwayStatus` (**NEW**) |
| Takeoff / landing on a runway not active for that role (`endActive`) | **Soft** R22 | `engine.endActive(name)` exists |
| Takeoff / landing / ILS weight class not permitted | **Hard** R8 (today only `cmdILS` checks it, `engine.ts:392`; add to `cmdTakeoff`, `cmdClearedLand`, `cmdLineUp`) | `weightsFor` |
| Tailwind > 10 kt or crosswind > 25 kt on the chosen runway | **Soft** "Tailwind 12 kt" | wind model (G9) |
| Takeoff with a departure lined up / rolling on an **intersecting** runway | **Hard** "Crossing runway {rwy} in use by {cs}" | needs runway-intersection table (**NEW**, computed from OSM geometry once per load) |
| Takeoff with opposite-end operations (arrival on final to the reciprocal end) | **Hard** if < 4 NM, **Soft** otherwise | `ilsRunways` reciprocal |
| Takeoff with a ground vehicle on or crossing the runway | **Hard** "Vehicle {id} on runway" | vehicles (G10) |
| Line up while another aircraft has a pending "on reaching" takeoff clearance for the same runway | **Hard** "{cs} cleared for takeoff on reaching" | `takeoffCleared` |
| Landing clearance for a second arrival on the same runway when the first is not yet vacated and this one > 2 NM | **Soft** "Number two, {cs} ahead" (spec had only the < 2 NM hard case) | |
| Vector / direct / altitude to an aircraft with `ilsCaptured` | **Hard** — the spec lets `cmdHeading` silently break the ILS; route through *Cancel approach* (`C`) which requires both heading and altitude | `ilsCaptured` |
| Vector / direct to an aircraft with `ilsArmed && !ilsCaptured` | **Soft** "Cancels ILS clearance" and the TX line gains "cancel approach clearance" automatically | |
| Descend below the GS-intercept altitude for the armed runway | **Soft** "Below glideslope intercept ({alt})" | `gsInterceptNM` in simStore |
| Climb above `perf.ceiling` | **Hard** — note `AircraftPerformance` has **no `ceiling` field**; add `serviceCeilingFt` to `aircraftDB.ts` or use FL200 for all | |
| Any altitude for `arr_final` / `arr_short_final` | Hidden (aircraft follows the glideslope path; the engine ignores it) | |
| Go around when not airborne (`rollout`, `takeoff_roll`) | **Hard** R17 (today `cmdGoAround` only checks `isAirborne`, which is true during `landing` at 0 ft; add `altitude > 0 \|\| distToThreshold > 0`) | |
| Go around on an aircraft with no `plan.runway` (never on approach) | Hidden | |
| Speed for an aircraft on the ground | Hidden | |
| Hold at fix below the area MSA / with `holdFix` inside a restricted area below its floor | **Hard** "Fix {id} inside {area} below {alt}" | `RadarArea.altFt` |
| Handoff while the aircraft is in an active STCA / RIMCAS | **Soft** "Conflict active" | alerts |
| Handoff to a position that is the current one | Hidden chip (never "contact yourself") | |
| Any command while `paused` | Panel actions disabled with "Paused"; `Esc` resumes | |
| Sim rate > 1× shrinks the undo window | Undo window is **sim time** (`PILOT_DELAY_S`) but clamped to ≥ 1.5 s **real** time; at 4× the pending command is held until the clamp expires | |
| Double `Enter` on confirm | `confirm-transmit` disabled for 400 ms after a transmit and the same AST cannot be re-sent to the same aircraft within 3 s unless via *Repeat* | |
| Runway-config change while an aircraft is `lineup / takeoff / arr_final` on an affected end | **Hard** in `rwycfg-apply`: "Wait for {cs} to clear {rwy}"; the dialog offers *Apply when clear* (queues) | |
| Closing a runway (ATIS status menu) with an arrival < 4 NM | **Soft** "Arrival {cs} {n} NM — will go around" | |
| Dispatching a vehicle onto a runway with an arrival < 2 NM or a rolling departure | **Hard** "Runway in use"; vehicle holds short instead (auto-inserted) | |
| Granting a vehicle crossing under the same conditions | **Hard** (identical to aircraft crossing) | |
| Archiving (`Delete`) a strip whose aircraft is not `arrived`/`departed` | **Hard** — key ignored, strip shakes | |
| Restart / Quit / `brand-home` with aircraft present | Confirm dialog `pause-confirm-yes` / `pause-confirm-no`; `Enter` = No | |
| Strict-frequency loophole: drag-to-heading and typed commands on an off-frequency aircraft | Same hard block as the panel (all three inputs consult the same `valid()`); the bubble shows R13 | |
| STT callsign matches more than one aircraft (e.g. "Speedbird one one seven" vs "BAW1170") | Never transmits; `cmd-ptt-transcript` shows an aircraft picker | |
| Emergency `Hold all traffic` scope *all ground movement* | Hard-blocks `continue`, `cross`, `lineup`, `takeoff`, `taxi-*`, pushback with R24 until *Resume all traffic* (`M → A`, **missing action**, add `emerg-resume-all`) | |

---

## G4. VAGUE: picker parameters not fully enumerated

| Picker | Missing rule → definition |
|---|---|
| all | **Empty state**: if a picker has zero valid candidates the action is rendered `○` with a reason (e.g. `picker-gate` → "No free stands"; `picker-fix` → "No fixes loaded"; `picker-runway` for ILS → R20), never an empty picker. |
| all | **Default selection rule**: the default chip is the first enabled candidate by the sort order given here; if the previous transmission to this aircraft used this picker, its value is the default instead ("last used"). |
| `picker-runway` | Sort: active-for-role first, then by headwind component desc. Chip label `27L`, sub-label `HW 7 · XW 4` (kt, `TW` in amber if tailwind). Exactly one chip per runway end. Runways without ILS get a `NO ILS` badge and are disabled in ILS mode (R20), enabled in `visual` mode. |
| `picker-heading` | **Magnetic vs true**: engine headings are true (`headingTo` from projected metres). Define `magVar` per airport in `ATC_AIRPORTS` (EGLL −0.5° 2026); **all displayed and spoken headings are magnetic**; convert at the AST boundary. Rounding: to nearest 5° in the dial, exact digits allowed by type-in. `360` displayed, never `000`. "Runway heading" preset = `runwayHeading(plan.runway)` magnetic, rounded to 1°. |
| `picker-altitude` | Floor for airborne aircraft = `max(1000 ft, MSA of the sector containing the aircraft)`; MSA source: `RadarArea` polygons with `altFt` (add `msaFt` to `RadarScene`, default 2500 if absent). **Transition altitude 6000 ft**: rungs ≤ 6000 are labelled feet ("5000"), above are flight levels ("FL070"); TX/RB say "5 thousand" / "flight level 7 0". Default for `climb`: departure initial = `min(FL130, 4000 + 1000·n)` — choose **4000** unless a SID initial altitude exists (no SID data exists today; state that SID support is Phase 2 and `resume-sid` is hidden until `RadarScene.sids` is present). Default for `descend`: current altitude − 1000 rounded down to the thousand, min = floor. |
| `picker-speed` | Range `perf.minAirspeedTMA … perf.maxAirspeedTMA` (both exist), 10-kt steps; 250 chip shown with a "<FL100" tag; "final approach speed" = `perf.approachSpeed`. In `arr_established`/`arr_final` the rail floor is `perf.approachSpeed` and the ceiling is 210; chip `160 to 4 miles` emits `speed(160, until: 4 NM)` (**NEW** `PendingCmd.until`). |
| `picker-fix` | Candidates: `RadarScene.beacons`; sort by distance asc; each row shows bearing (mag) and NM; hidden fixes behind the aircraft (> 120° off the nose) sink to the bottom, not removed. `pron` field (exists in `RadarBeacon`) drives TTS. |
| `picker-hold` | EFC = sim clock + chosen delta, displayed `HH:MM`Z, spoken as minutes past the hour ("expect further clearance at 4 5"). Default inbound = `beacon.holdHeading` if present, else bearing aircraft→fix. Leg default 1 min. Engine field additions: `holdLegMin`, `holdLegNM`, `holdEfc`. |
| `picker-taxiroute` | A chip is a **taxiway designator** (`air.taxiwayNames`), a hold-short pill binds to a **node id** (the crossing node of the runway on the route), an intersection chip binds to the node where two named taxiways share a node. Routes are limited to 12 chips. When the destination runway differs from `plan.runway`, the confirm line gains "change to runway {rwy}" automatically and `plan.runway` is rewritten on transmit. Route preview: `map-route-preview` polyline, hold bars at each pill node. "AUTO" uses `findPath`; a manual route uses `routeVia` (exists) and fails with R15 if `routeVia` returns null. |
| `picker-taxiway` (exits) | Exit candidates for rollout/landing = runway-graph nodes with a taxiway edge, with `distAlong` greater than the aircraft's; label = taxiway name; sub-label = metres ahead; the engine's default exit (nearest node where `speed < 22 kt` will be reached, from `perf.decelerationRateAir`... note: rollout decel is ground — add `perf.rolloutDecelKtS`, default 4) is pre-selected. |
| `picker-gate` | Occupancy = any aircraft with `plan.gateRef === ref && phase ∈ {parked, startup, pushback, arrived}` (`freeGate()` exists in engine — expose `gateOccupant(ref)`). Terminal grouping: by the ref prefix letter; if refs have no prefix, one group "STANDS". The assigned `plan.gateRef` is pre-selected even if occupied (then `○R19` on confirm with the "hold at" suggestion). |
| `picker-position` | No frequency data exists. Add to `ATC_AIRPORTS[icao]`: `positions: { ground: '121.900', tower: '118.500', departure: '120.400', approach: '119.725' }` (EGLL values: Ground 121.905, Tower 118.505/118.705, Departure 121.225/124.475 — use the first), and `telephony: 'Heathrow'`. Next-logical rule: dep ground→tower→departure; arr approach→tower→ground. |
| `picker-vehicle` | Fleet per airport in `ATC_AIRPORTS[icao].vehicles` (default fleet: FIRE 1–3, AMB 1, FOLLOW 1, TUG 1–2, OPS 1, SWEEP 1, BIRD 1); station positions = nearest node to a configured lng/lat, default = airport centre. |
| `picker-aircraft` | Candidates for *behind landing*: `arr_final` / `arr_short_final` on the same runway sorted by distance; for *give way*: ground aircraft within 300 m whose path intersects ours within the next 200 m. |
| `picker-info` | Valid chips by stage: ground → position, POB, fuel, DG, intentions; airborne → heading, altitude, airspeed, POB, fuel, nature, intentions. `altitude` chip is missing from the spec list — add `picker-info-altitude`. |
| `picker-direction` (pushback facing) | Only `N/E/S/W` chips that leave the stand on a taxiway edge are enabled; default = "as required" chip (`picker-dir-any`, **missing id**). |
| `confirm` | Hold-to-confirm progress ring element `confirm-hold-ring`; the aggregated warnings list `confirm-warning-{n}` (each with text) and blocks `confirm-blocked-reason` (first hard block wins; all are listed under it). |

---

## G5. MISSING: engine data and behaviours the UI depends on (extend Appendix A)

1. **Pending queue for all commands.** Today only `heading|altitude|speed` are queued (`types.ts:35`, `engine.ts:341`); every ground verb applies instantly, so the §1.6 undo window does not exist for pushback/taxi/lineup/takeoff/land. Extend `PendingCmd.kind` to a discriminated union of every AST verb; `cmd*` functions become `enqueue(ast)`; `applyAst(a, ast)` runs at `applyAt`. `cmdDisregard(cs)` drops the newest pending command and restores nothing else. "Latest wins per kind" (`engine.ts:343`) stays for heading/altitude/speed; for other kinds the queue is FIFO. During the window the aircraft continues its previous behaviour.
2. **`landingCleared: boolean`** on `AircraftState` (missing from Appendix A). `cmdClearedLand` (`engine.ts:331`, text-only today) sets it; `handleTransitions` executes the automatic go-around at 0.5 NM if false; the panel countdown reads `distToThreshold`.
3. **`needsPushback` per stand**: `OsmGate` has no such field. Rule: `needsPushback = gate ref matches /^[0-9]/ or the node has exactly one edge`; add an override list per airport.
4. **Weather/ATIS model** (nothing exists): `WeatherState { windDirTrue, windKt, gustKt?, visM, cloud: string, qnh, tempC, dewC, atisLetter }`, randomised at load within the start config (or fixed by `home` config), changed only by the runway-config dialog (letter increments). Wind component per runway end = cos/sin of `(windDir − runwayHeading)`. Ground speed vs wind is **not** modelled (say so).
5. **Runway status** `open | closed | sterile | inspection | wet`, per physical runway; `runwayOccupied()` (`engine.ts:483`) must also return true for vehicles on the runway and for `closed`.
6. **Runway intersection table** built from OSM geometry at load (segment intersection of the two runway centre-lines).
7. **Pilot request events** — see G8 for the full catalogue with triggers.
8. **`goAround` flag**, `emergency` object, `handedTo: Position`, `onFrequency: Position` on `AircraftState`; `Position = 'ground'|'tower'|'departure'|'approach'|'external'`.
9. **Rollout/taxi-in ownership.** Today `handleTransitions` auto-taxis the arrival to its gate at < 22 kt (`engine.ts:726-737`). New rule: the pilot vacates at the planned/nearest exit, stops at the exit's first taxiway node, and emits `request taxi` (REQ) unless a conditional taxi-in clearance is pending. Setting `set-auto-taxi-in` (default **off** in Normal, **on** in Tutorial) restores today's behaviour.
10. **AI positions.** `engine.autoTower` (`engine.ts:48`, `LS_KEYS.autoTower`) already exists but the spec never mentions it. Define: Solo mode — the player owns all three positions; `set-ai-assist-{ground|tower|approach}` toggles (default all **off**; `autoTower` key migrates to `ai-assist-tower`). When on for a position, aircraft whose `onFrequency` is that position get the routine clearance 8 s after it becomes valid, logged in grey as `AI TWR ▸ …`; their REQs never count against responsiveness; strips in that position's bays show an `AI` tag; the player can still override.
11. **Departure clearance fields** on the AST/`AircraftState`: `afterDepHdg`, `initialAlt` (default 4000), `autoHandoffAlt`, `immediate`; **LAHSO** `lahsoHoldShortOf`, `exitAt`.
12. **Emergency spawn rules** (missing): probability per hour of sim time in Normal = 0.4 (setting `set-emergency-rate` 0 / 0.4 / 1.2); kinds by stage: `takeoff_roll` → engine_failure (auto-abort if < 80 kt) / bird_strike; `dep_climb` → engine_fire, depressurization (only > FL100), smoke, medical; `arr_*` → fuel (fuelMin 15–40), gear, hydraulic, medical; `taxi_*` → brake_fire, medical. `fuelMin` counts down in sim minutes; at 0 the aircraft is removed with event `fuel_exhaustion` (−2.0 skill). Never more than one active emergency in Normal mode.
13. **STT** does not exist (only `speechSynthesis` in `simStore.ts:48`). Specify: Web Speech API `SpeechRecognition` (Chrome/Edge only); when unavailable, `cmd-ptt` is hidden and Settings shows "Voice input not supported in this browser". Confidence threshold 0.72 from `SpeechRecognitionAlternative.confidence`. Number normalisation table: "two four zero" → 240, "flight level one three zero" → FL130, "niner" → 9, "tree" → 3, "fife" → 5; callsign match by telephony (`Speedbird` → BAW) then digits/letters, requiring a unique match.
14. **Telephony table** for TX/RB (missing): `AIRLINE_TELEPHONY: Record<string,string>` (BAW Speedbird, DLH Lufthansa, AFR Air France, UAE Emirates, …) with a fallback of spelling the ICAO code phonetically; `{cs}` in TX/RB means telephony + flight number; the log shows the ICAO callsign.
15. **FAA variant phrase table**: the spec promises `set-phraseology-{icao|faa}` with no FAA text. Minimum diff list: "line up and wait" (same), "taxi to runway 27L via A, B" (FAA: "runway 27L, taxi via A, B"), "cleared ILS approach runway" (FAA: "cleared ILS runway 27L approach"), "climb and maintain" (same), "descend to 3000" (FAA: "descend and maintain 3000"), altitudes above 18 000 as flight levels (FAA) vs above transition altitude (ICAO), "hold short" (same), wind format "wind 260 at 8" (FAA) vs "wind 260 degrees 8 knots" (ICAO), "expedite" (same), "cancel takeoff clearance" (FAA) vs "cancel takeoff" (ICAO).

---

## G6. WRONG: hotkey collisions

| Conflict | Resolution |
|---|---|
| `F1` = Ground mode **and** Help | Help = `?` only (`Shift+/`), and `H` inside the pause menu. `F1/F2/F3` = modes (call `preventDefault`; Chrome's F1 help is suppressed when focus is in the page). |
| `F5` comm log = browser reload; `F6` ATIS = address-bar focus; `F7` vehicles = caret browsing (Firefox) | Strip bay `F4`; comm log `F8`; ATIS `F9`; vehicles `F10`. Never bind F5/F6/F7/F11/F12. |
| `Ctrl+R` = range rings **and** vehicle recall **and** browser reload | Rings = `Ctrl+Shift+R`? (also reload). Use plain `K` for rings (map focus) and `Ctrl+K` is browser search — final: rings `O` when map focused is taken by takeoff… use **`G` when the map has focus** is taken by go-around. Decision: range rings = **`Alt+R`**; vehicle recall = **`Backspace` with a vehicle selected** (no draft open). Document that all `Ctrl+letter` bindings except `Ctrl+Z`, `Ctrl+Shift+Z`, `Ctrl+Enter` are avoided. |
| `Space` = PTT **and** picker toggle (`picker-vehicle`, `picker-info`) | PTT is `Space` only when no picker has focus; inside pickers `Space` toggles; PTT alternative `Ctrl+Space` always works. |
| `Tab` = next aircraft **and** next picker field / bay column | `Tab` inside a picker moves fields; `Ctrl+Tab`/`Ctrl+Shift+Tab` = next/prev aircraft everywhere (browser tab-switching is not preventable in all browsers — fall back to `]`/`[` …) — **decision**: next/prev aircraft = `PageDown` / `PageUp` when a picker has focus, `Tab`/`Shift+Tab` otherwise. |
| `+` = zoom in **and** add part | Zoom `=`/`-` (map focus); `+` add part (panel focus). Toolbar buttons unaffected. |
| `E` = exit/vacate **and** emergency *stop on runway* | Emergency actions are `M` chords only: `M,A` ack · `M,I` priority · `M,D` dispatch · `M,H` hold all · `M,B` break off · `M,E` stop on runway · `M,R` reopen · `M,X` resume all. |
| `N` = unable **and** north-up | North-up = `Alt+N`. |
| `F` = handoff **and** follow | Focus model (missing): exactly one of `bay`, `panel`, `map`, `log` holds focus, shown by a 2-px ring on the panel frame and stored as `data-focus-region` on `<body>`. Selecting an aircraft moves focus to `panel`. `F` = handoff when focus ∈ {bay, panel}, follow when `map`. Add `Alt+F` = follow always. |
| `[`/`]` = modes **and** used for aircraft cycling above | Modes only. |
| `,` `.` sim rate vs typing in the command line | Hotkeys never fire while `cmd-input` has focus (already stated) — add: `Esc` in `cmd-input` blurs it first, second `Esc` deselects. |
| `Enter` on a REQ band (spec: "runs it with defaults") vs Rule 4 "nothing transmits without Confirm" | `Enter` on a REQ opens the answering action **at the confirm step** with defaults; a second `Enter` transmits. `Ctrl+Enter` does both. Update §1.4 and onboarding step ④. |
| `1–9` runway chips vs `Shift+1–6` presets | No conflict, but note `1–9` must not fire while `picker-heading-input` has focus. |
| `Delete` archive vs `Backspace` back | `Backspace` never archives. |
| `U` undo vs typing a callsign starting with U in the bay search | Bay search is an input; hotkeys off. |

Add a **hotkey ownership table** to §8 Help generated from a single `HOTKEYS` constant `{ key, region, action, when }` so the help tab, badges and handler cannot drift.

---

## G7. MISSING: strip bay mapping and lifecycle

The bay names in §2.2 have no mapping rule. Add:

| kind × stage | GROUND bay | TOWER bay | APPROACH bay |
|---|---|---|---|
| dep parked/startup | PENDING (PUSH·START once P/start-up sent) | — | — |
| dep pushback | PUSH · START | — | — |
| dep taxi_out / hold_short_cross | TAXI OUT | — | — |
| dep hold_short_dep | AT HOLD (Ground, until handed to Tower) | AT HOLD | — |
| dep lineup | — | LINED UP | — |
| dep takeoff_* / dep_climb below `autoHandoffAlt` | — | ROLLING · AIRBORNE | — |
| dep_climb / dep_level after handoff | — | — | CLIMB OUT |
| departed | — | — | HANDED OFF (30 s then archived) |
| arr_inbound | — | — | INBOUND |
| arr_armed | — | — | SEQUENCE |
| arr_established (before handoff) | — | — | ESTABLISHED |
| arr_established/final after handoff to Tower | — | FINAL | TO TOWER (ghost) |
| go_around | — | FINAL (red `GA` chip) until handoff | SEQUENCE after handoff |
| rollout | — | LANDED · ROLLOUT | — |
| arr taxi_in / hold_short_cross | TAXI IN | TO GROUND (ghost) | — |
| arrived | AT STAND (30 s then archived) | — | — |
| emergency (any) | pinned at the top of whichever bay above, red | same | same |
| vehicle | VEHICLES | VEHICLES | — |

Strip counts in the collapsed rail are per bay; the `REQ` dot counts requests in that bay only.

---

## G8. MISSING: pilot request catalogue (triggers, answers, timeouts)

| Request text | Engine trigger | Highlighted answer | Other valid answers | If unanswered |
|---|---|---|---|---|
| request pushback / request start-up | 20–90 s after spawn in `parked` (uniform) | `action-pushback` / `action-startup` | standby, unable(expect delay) | re-call at 45 s; after 5 min −0.1 skill per minute; never auto-pushes |
| ready to taxi | `startup` reached or pushback complete | `action-taxi-runway` | standby | re-call 45 s |
| request cross runway {rwy} | reached a hold-short pill at a runway crossing | `action-cross` | hold position | re-call 45 s; counts delay |
| ready for departure | reached `hold_short_dep` and `onFrequency==='tower'` | `action-takeoff` (or `lineup` if runway occupied) | line up, hold position, standby | re-call 45 s; +delay alert at 10 min |
| with you | 4 s after any handoff completes | none (auto-clears on any command) | — | clears after 60 s |
| request higher | dep_level below `plan.cruiseAlt` for > 60 s | `action-altitude` with default +2000 | unable | re-call 90 s |
| request lower / request descent | arr_inbound at spawn altitude > 8 NM from the FAF and no descent given for 3 min | `action-altitude` | unable | re-call 90 s |
| request direct {fix} | arr_inbound > 6 min in airspace on vectors | `action-direct` prefilled | unable | re-call 120 s |
| request hold / request delay vectors | never engine-initiated; only after a *Standby* > 3 min | — | — | — |
| request taxi (to stand) | rollout vacated, stopped at exit | `action-taxi-stand` | hold position | re-call 45 s |
| say again | see §1.7 | REPEAT | — | re-call 20 s |
| radio check | 1 % of initial calls | `action-report` → "read you five" chip (**missing chip** `picker-report-readyou5`) | — | — |
| cancel mayday | emergency `resolved` by pilot | `emerg-cancel-ack` | — | — |
| request return to stand | departure in `taxi_out` with a spawned "technical" event (2 %) | `action-taxi-stand` | — | re-call 45 s |

Only one REQ per aircraft at a time; a new one replaces the old. Responsiveness score = mean answer time over the session; shown in the score breakdown (G11).

---

## G9. MISSING: undo semantics detail

- Undo restores the **previous targets**, not the previous pending command: if V240 is pending and V250 is sent (latest-wins replaces it), undo of V250 restores the target as it was before V240 too (V240 was already dropped). State this and show the log line for V240 struck through with "superseded".
- Undo of a multi-part command is all-or-nothing; parts cannot be undone individually.
- Undo is unavailable for `Standby`, `Report`, `Say again`, `Wind check`, vehicle dispatch, and runway-status changes (no pilot execution to pre-empt); their log lines show no ring.
- Undo when `PILOT_DELAY_S` = 0 (Settings slider min must be 1 s, not 2 s as listed; `set-pilot-delay` range 1–8 s) — with 1 s the ring is still clamped to 1.5 s real time (G3).
- `Ctrl+Shift+Z` re-send is refused if the aircraft's stage no longer allows the action (toast "No longer valid").

---

## G10. MISSING: mode/position start state and the empty/error states

- Initial mode on entering `/atc` = the `home-position-{ground|tower|approach}` choice (**missing home control**); default Tower. Tutorials fix the mode.
- Airport without airspace data (`spawnArrival` fallback path, `engine.ts:217`): Approach tab is rendered disabled with tooltip "No radar airspace for {icao}"; arrivals spawn on 6 NM final in `arr_final`; `action-ils`, `action-hold-fix`, `action-direct`, `action-expect-runway` are hidden for the whole session.
- Airport with no ILS runway record: the OSM fallback in `cmdILS` (`engine.ts:399-406`) builds one at 3°; the runway chip shows `ILS (est.)`.
- Loading failure: `loading-overlay` gains `loading-error` text and a `loading-retry` button; `brand-home` remains active.
- No aircraft in the sim: strip bay shows `bay-empty-{bay}` "No traffic — next departure in 00:42" (from the spawner) and the panel is closed.
- Nothing selected: the command panel is closed unless pinned; pinned-empty shows the phase→action matrix for the current mode as a cheat sheet (`panel-empty-matrix`).
- Aircraft removed while selected (diversion, fuel exhaustion, archived): panel closes with a toast; a draft in progress is discarded (no "Resume draft").
- Desktop-required screen: `desktop-required` overlay with `desktop-required-continue` ("Continue anyway", stores `skycontrol_allow_narrow`).
- Persistence keys (single table, all prefixed `skycontrol_`): `start_config`, `score`, `tts`, `groundTheme`, `autoTower`→`ai_assist`, `settings` (one JSON blob for every `set-*` toggle), `presets_{icao}_{mode}`, `separators_{icao}`, `filters_{mode}`, `tips_seen`, `allow_narrow`, `hotkey_badges`. Restart clears nothing; "Reset all" in Settings clears everything except `score`.

---

## G11. MISSING: score breakdown content (the popover is listed but empty)

`score-breakdown` rows (`score-row-{key}`): `established` (+0.1×skill each) · `landed` · `departed_handoff` · `emergency_bonus` · `separation_loss` (−0.5) · `ground_conflict` (−0.2) · `runway_incursion` (−1.0) · `diversion` (−0.5) · `fuel_exhaustion` (−2.0) · `unanswered_request` (−0.1/min) · `readback_error_missed` (−0.2) · `sterile_runway_violation` (−0.5) · `frequency_load` (transmissions per aircraft, informational) · `responsiveness` (mean s, informational). Header: current skill, game score (max skill this game), high score. Matches `product_overview.md §12`.

---

## G12. MISSING: interactive elements (add to §10)

Test attributes first — without them the "disabled with reason" and stage rules are untestable:

- Every `action-*`, `picker-*` chip and `confirm-*` button carries `data-state="enabled|disabled|hidden-would-be"`, `data-reason="<canonical string>"` (empty when enabled), `data-hotkey`.
- `strip-{cs}` and `map-target-{cs}` carry `data-stage`, `data-kind`, `data-bay`, `data-req`, `data-alert`, `data-onfreq`, `data-selected`.
- `<body data-mode data-focus-region data-paused data-rate>`.
- `log-line-{key}` carries `data-who="ATC|PILOT|SYS|AI"`, `data-status="pending|executed|undone|unable|mismatch"`.
- Deterministic test API on `window.__atcTest` (dev/test builds only): `seed(n)`, `spawn(kind, stage, opts)`, `tick(simSeconds)`, `setPilotDelay(s)`, `setWeather(w)`, `emergency(cs, kind)`, `request(cs, kind)`, `state(cs)`, `alerts()`.

Missing ids:

| id | Where | Action |
|---|---|---|
| `home-position-{ground\|tower\|approach}` | `/` | Starting position |
| `home-mode-{normal\|custom\|tutorial}` / `home-flow-{dep\|arr}` | `/` | Game mode, custom flow sliders |
| `desktop-required` / `desktop-required-continue` | overlay | see G10 |
| `loading-error` / `loading-retry` | overlay | |
| `sandbox-spawn-dep` / `sandbox-spawn-arr` / `sandbox-spawn-at-hold` | TOP (Custom mode only; today's `+ DEP/+ ARR`) | Spawn |
| `rate-popover` / `rate-hold-ff-ring` / `clock-popover` / `clock-set-time` | TOP | |
| `score-breakdown` / `score-row-{key}` / `score-highscore` | TOP popover | |
| `airport-dialog` / `airport-dialog-close` | TOP | |
| `panel-phase-chip` / `panel-stage` / `panel-kind` / `panel-wake` / `panel-onfreq-note` / `panel-ai-tag` / `panel-empty-matrix` | PANEL | |
| `panel-alert-banner` / `panel-alert-geometry` | PANEL | STCA banner |
| `stepper-{action}` / `step-{n}` / `step-title` / `step-default-chip` | PANEL | stepper container & current step |
| `confirm-summary` / `confirm-warning-{n}` / `confirm-hold-ring` | PANEL | |
| `picker-dir-any` / `picker-info-altitude` / `picker-report-readyou5` / `picker-unable-reason-delay` | PANEL | |
| `picker-route-pill-{n}` / `picker-route-pill-{n}-remove` / `picker-route-dest-runway` / `picker-route-dest-gate` | PANEL | route pills |
| `picker-taxiroute-map-mode` | MAP overlay chip "Route build — tap taxiways · Esc" | |
| `picker-alt-band-msa` / `picker-alt-band-ceiling` / `picker-alt-band-gs` | PANEL | shaded bands (assert presence) |
| `picker-speed-chip-250-note` | PANEL | "<FL100" tag |
| `picker-hold-preview` (map) / `map-hold-preview` | MAP | racetrack |
| `picker-lineup-traffic-final` | PANEL | auto "traffic on N-mile final" toggle |
| `picker-takeoff-after-dep-hdg` / `picker-takeoff-turn-{L\|R}-{deg}` / `picker-takeoff-climb` | PANEL | departure-clearance parts |
| `picker-land-next-exit-{L\|R}` | PANEL | |
| `picker-exit-expedite` | PANEL | rollout expedite chip |
| `picker-cancel-approach-heading` / `-altitude` | PANEL | forced parts |
| `picker-emerg-vehicle-{id}` / `picker-emerg-break-{cs}` | PANEL | |
| `emerg-resume-all` | PANEL | `M,X` |
| `emerg-band-pob` / `emerg-band-fuel` / `emerg-band-status` | PANEL header | fields |
| `strip-{cs}-timer` / `strip-{cs}-phase` / `strip-{cs}-seq` / `strip-{cs}-ai` / `strip-{cs}-ghost` / `strip-{cs}-held` | BAY | |
| `strip-{cs}-arrow` (▲/▼) | BAY | non-colour DEP/ARR channel |
| `bay-empty-{bay}` / `bay-collapse-section-{bay}` / `bay-second-column` | BAY | |
| `map-route-preview` / `map-holdbar-{node}` / `map-turn-predictor` / `map-wake-arc-{cs}` / `map-ring-{n}` / `map-ils-feather-{rwy}` / `map-restricted-{id}` / `map-corridor-{rwy}` | MAP | layers (assert visible per mode) |
| `map-label-{cs}-req` / `map-label-{cs}-em` / `map-label-{cs}-pending` | MAP | data-block badges |
| `map-taxi-bubble-send` | MAP | ground drag release |
| `map-not-on-freq-bubble` | MAP | R13 on drag |
| `runway-bar-{rwy}-state` | MAP | `free\|lined\|occupied\|closed\|emerg` |
| `atis-runway-{rwy}-sterile` / `-wet` | ATIS | status items (spec lists only close/open/inspect) |
| `atis-wind-arrow` | ATIS | |
| `rwycfg-apply-when-clear` / `rwycfg-blocked-reason` | dialog | G3 |
| `alerts-row-{id}-score` / `alerts-row-{id}-state` / `toast-{id}-pair-{cs}` | ALERT | |
| `veh-card-{id}-status` / `veh-card-{id}-eta` / `veh-map-point-marker` / `veh-strip-eta-vs-touchdown` | VEH | |
| `pause-confirm-yes` / `pause-confirm-no` / `home-leave-confirm-yes` / `-no` | PAUSE | |
| `set-ai-assist-{ground\|tower\|approach}` / `set-auto-taxi-in` / `set-emergency-rate` / `set-magnetic-headings` / `set-transition-alt` / `set-vehicle-auto-cross` / `set-reset-all` / `set-close` | SET | new settings from this addendum |
| `settings-modal` | overlay | The spec says "`/settings` modal" but `/root/atc/src/app/settings/page.tsx` is a **route**. Decide: the in-game gear opens a modal that renders the same component; the route stays for the home page. |
| `help-hotkey-row-{key}` / `help-matrix-cell-{stage}-{action}` / `help-phrase-{action}` | HELP | generated rows |
| `tip-next` / `tip-progress-{n}` | onboarding | |
| `cmd-ptt-unsupported` | LOG footer | shown when STT unavailable |
| `cmd-ambiguous-callsign` / `cmd-ambiguous-{cs}` | LOG footer | STT disambiguation |
| `cmd-parse-error-token` / `cmd-parse-suggestion` | LOG footer | §9 error recovery |
| `log-line-{key}-superseded` | LOG | G9 |
| `ai-log-line-{key}` | LOG | grey AI lines |

Right-click quick menu items must be enumerated for stable ids: `ctx-aircraft-{actionId}` uses the same `action-*` suffixes (e.g. `ctx-aircraft-takeoff`).

---

## G13. VAGUE / WRONG: smaller corrections

1. §1.4 `taxi` "Contact tower [F] (outbound, when ≤ 1 hold point from runway)" — also allowed anywhere in `taxi_out` when the route has no more crossings; reason otherwise: "Crossing {rwy} ahead — hand off after".
2. §1.4 `hold_short` "Hold position … `cmdHoldShort`" — `cmdHoldShort` (`engine.ts:293`) sets `holdAt = distAlong + max(20, speed·2)`; at a hold point that is a no-op; the engine hook is `cmdHoldPosition` (NEW) everywhere "hold position" appears.
3. §1.4 `takeoff` "Cancel takeoff → phase `rollout`" — `rollout` is the arrival decel state that auto-taxis to a **gate**; a rejected takeoff must go to `rollout` with `plan.kind==='departure'` and then stop and REQ "request taxi back to holding point / return to stand" (`action-taxi-runway` and `action-taxi-stand` both enabled from rollout for departures — add to G2 column `rollout`).
4. §1.4 `lineup` "Hold in position → no-op + strip note" — must also clear any pending `takeoffCleared` and block the `autoTower` AI from clearing it (`engine.ts:748-757` would otherwise roll it).
5. §1.4 `rollout` "Contact ground … `Soft: still on runway`" — with the new ownership rule (G5.9) the handoff is only meaningful after vacating; make it `○ "Vacate first"` while on the runway.
6. §1.5 Max 4 parts — define what counts: base + up to 3 parts; `wind` and `report established` toggles do not count.
7. §1.5 incompatible part pairs (missing): `then cleared ILS` × `hold`, `then cleared ILS` × `direct` (allowed only if the fix is the IAF), `immediate` × `behind landing`, `LAHSO` × `exit at` on the same runway, `expedite` × `resume normal speed`, `runway heading` × `fly heading`.
8. §1.7 "STT confidence < 0.72 → pilot says 'say again'" contradicts §9 "STT low-confidence never transmits (shows the draft)". Resolution: low confidence never transmits (draft shown); the pilot "say again" branch is only the 2 % bad-radio setting and the invalid-AST case.
9. §2.2 "Aircraft on other positions … selectable" plus §3.3 auto-handoff on by default means most aircraft are "on another position" while you look at one view. With Solo mode (G5.10) all positions are yours, `onFrequency` only affects strict-frequency realism and which bay the strip sits in.
10. §3.1 strip "timer (time since last pilot call)" — define reset events: any pilot line for that callsign (readback, request, with-you). Emergency strips show `fuelMin` countdown instead.
11. §4 "Wheel on selected aircraft (Approach) altitude ±1000" — must build a **draft** (bubble `map-alt-bubble-send` "Descend 4000 ⏎", missing id) unless instant vectors is on; the spec's "middle-click = transmit" then applies.
12. §5.1 STCA "predicted < 3 NM & < 1000 ft within 60 s" — the engine only checks actual loss (`checkSeparation`, `engine.ts:800-812`) using `max(wake, 3 NM)`; the predicted variant must use the same required distance (wake-aware), and the reduced-minima exceptions (`engine.ts:804-806`) apply to prediction too.
13. §5.2 step 5 resolution suggestions — define ranking: prefer the aircraft not established on an ILS; prefer altitude when vertical closure is smaller than lateral; never suggest a descent below MSA or a climb above FL130; max 3 chips.
14. §6 Follow-me "Aircraft's route becomes follow vehicle" — needs engine support (`followVehicleId`); mark **(NEW)** and Phase 2 if not funded.
15. §8 first-run step ④ "you have 3 s to undo" — reads `PILOT_DELAY_S` (3 s today, `engine.ts:21`) — render the live value.
16. §9 "min body 12 px mono" vs the strip callsign at 15 px and the data block — specify data-block font 11 px mono minimum on the map (map is exempt from the 12 px rule; add a `set-label-size` 90–140 %).
17. §10 `strip-{cs}-box-{P|T|W|O|F|I|L|E}` — arrival strips have no `P/T/W/O`; departures no `I/L/E`; a test must assert absence, so say so.
18. `RadarRunway` has `lengthM`; runway chips for emergencies should show length and disable ends shorter than `perf`-based landing distance — `AircraftPerformance` has no landing-distance field; add `landingDistM` (defaults by class L 1200 / M 1800 / H 2500 / S 3000).
19. `WeightClass` is `'L'|'M'|'H'|'S'` (`aircraftDB.ts:10`) while the spec and home page use `J` — unify on `S` in code and display "J" only in the label per `product_overview.md §6`.
