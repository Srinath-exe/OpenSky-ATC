# SkyControl — Realistic ATC Game: FEATURE SPEC (Ground · Tower · Approach)

**Status:** definition of "done" for v1 · **Fidelity target:** Tower! Simulator 3 / Endless ATC / VATSIM procedures, but playable · **Codebase anchors:** `src/lib/sim/engine.ts` (`SimEngine`), `src/lib/sim/types.ts` (`AircraftState`, `FlightPhase`), `src/lib/sim/commands.ts` (parser), `src/lib/sim/aircraftDB.ts` (`AIRCRAFT_DB`, weight classes `L/M/H/S`), `docs/GROUND_MOVEMENT_SPEC.md` (taxi graph, hold lines, pushback), `context/approach_atc.md` (radar loop, ILS capture, separation, skill score).

Sources verified for this spec: FAA JO 7110.65 (Ch.3 §9/§10 runway ops, Ch.4 §6 holding, Ch.5 §9 vectors to final, Ch.7 §4 visual approaches, Ch.10 emergencies), ICAO Doc 4444 PANS-ATM Amdt 9 (wake categories SUPER/HEAVY/MEDIUM/LIGHT, §5.8.3 time-based and §8.7.3.4 distance-based minima), ICAO Annex 14 §9.2 / 14 CFR 139.319(h) (ARFF 3-minute response), AIM 4-3-11 (LAHSO), AIM 5-3-8 (holding speeds), 14 CFR 91.117 (250 kt < 10,000 ft), EUROCONTROL STCA/MSAW guidelines (2-minute look-ahead), FAA Holdover Time tables, ICAO Doc 9432 / CAP 413 aerodrome phraseology, feelThere Tower!SE manual & Tower! Simulator 3 command list (competitive baseline).

---

## 0. Conventions used throughout

| Term | Meaning |
|---|---|
| **Position** | DEL = Clearance Delivery · GND = Ground · TWR = Tower · APP = Approach/Departure (radar). In v1 the player holds all positions; an "Auto-ATC" toggle per position lets the AI run the ones the player is not staffing (existing `autoTower` flag generalises to `autoPositions: Set<Position>`). |
| **Phase** | `FlightPhase` in `types.ts`, extended: `parked → startup → pushback → taxi → hold_short → lineup → takeoff → climb → departed` and `approach → landing → rollout → taxi → parked`, plus `holding`, `goaround`, `emergency` flag (orthogonal), `deice`. |
| **Phraseology** | Controller transmission → pilot readback. `{}` = parameter. Numbers spoken digit-by-digit ("one two zero"), runway "two seven left", altitudes "three thousand" / "flight level one three zero", headings three digits, wind "two seven zero at one zero". |
| **Pilot delay** | Every command enters `pendingCmds` and executes after `PILOT_DELAY_S` (default 3 s air, 4–8 s ground; see Timing Table). Readback TTS plays immediately; execution follows. |
| **Scoring** | Two layers: **Skill** (float, drives traffic density — Endless-ATC style, see §6) and **Session points** (integer ledger, Tower!SE style: +10/movement, −100…−1000/violation). Every feature lists its points effect. |
| **UI affordance** | Every command is issuable three ways: (1) the **command line** (`callsign VERB …`, existing parser), (2) the **context menu** on the target/strip (only phase-valid commands shown), (3) **voice** (STT → same parser). Pilot requests appear as strip badges + radio call + "pending request" queue. |

---

## 1. DELIVERY / GROUND FEATURES

### 1.1 IFR Clearance (DEL)
- **When:** aircraft `parked`, has filed flight plan, first contact ("request clearance"). Precondition for start/pushback (configurable `requireClearanceBeforePush`, default true).
- **Parameters:** destination, SID or "radar vectors {fix}", initial altitude (default 5000 ft; airport config), departure frequency, squawk (random 0100–7477 excluding 7500/7600/7700/1200/2000 and duplicates).
- **ATC:** "{cs}, cleared to {dest} airport via {SID} departure, {fix} transition, then as filed. Climb via SID, initial altitude five thousand. Departure frequency one two five decimal two, squawk four two one seven."
- **Pilot:** "Cleared to {dest} via {SID}, climb via SID initial five thousand, departure one two five decimal two, squawk four two one seven, {cs}." (Readback errors: 3% chance pilot reads back wrong squawk/altitude — the controller must correct with "{cs}, negative, squawk …"; uncorrected wrong readback = −50 pts when detected at departure.)
- **Engine:** sets `plan.sid`, `plan.initialAlt`, `squawk`; strip moves DEL → GND column; pilot calls ground for push after 60–180 s (ready-time distribution).
- **UI:** strip shows route line, SID badge, squawk; "CLR" stamp.
- **Score:** none for correct; **Delivery delay** counts toward average delay if request unanswered >120 s.
- **Edge:** pilot asks "say again" if clearance issued to an aircraft with no flight plan (VFR/GA); amended clearance ("{cs}, amendment to clearance, …") when runway change forces new SID.

### 1.2 Engine Start Approval (DEL/GND)
- **When:** `parked` after IFR clearance; pilot: "{cs}, stand {n}, request start-up, information {ATIS}." Also for stands without pushback (GA, remote/nose-out stands, turboprops) — this replaces pushback approval (TS3 behaviour).
- **Params:** `expectDelayMin` (optional).
- **ATC:** "{cs}, start-up approved, expect runway {rwy}, information {ATIS} correct, QNH {qnh}." · delay variant: "{cs}, expect start-up at {time}" / "start-up at own discretion, expect departure at {time}".
- **Pilot:** "Start-up approved, runway {rwy}, QNH {qnh}, {cs}."
- **Engine:** `phase=startup`; per-type startup duration (APU start 45 s if APU cold + 40–60 s per engine sequentially + after-start checks 30 s): **Light piston 30–60 s; turboprop 90–120 s; medium jet (2 eng) 120–180 s; heavy (2 eng) 150–210 s; 4-engine/super 200–240 s**. If pushback is also approved, engines start *during* push (real-world norm: "start-up during pushback"); startup timer runs in parallel and taxi is blocked until both push complete and `enginesStable`. 4% chance of **start failure** ("{cs}, start aborted, hot start, request 5 minutes") → +300 s.
- **UI:** stand marker pulses amber "STARTING", countdown on strip.
- **Score:** none. Avg-delay stat starts counting from first pilot request.
- **Edge:** startup denied when de-icing queue/airport flow control (`slotDelay`) active — pilot gets "expect start-up at {time}".

### 1.3 Pushback Approval (GND)
- **When:** `parked` (+`startup` allowed concurrently), tug available (see §1.19 vehicles), pushback lane free (no aircraft within 30 m of the push path, GROUND_MOVEMENT_SPEC §5.1).
- **Params:** `face: N|S|E|W|<heading>` or `tailTo: <taxiway>`; optional `expectRunway`.
- **ATC:** "{cs}, pushback approved, face {north}, expect runway {rwy}." · "…tail to taxiway Alpha…" · "…pushback approved, start-up approved…" · conditional: "{cs}, behind the company Airbus passing left to right, pushback approved, behind."
- **Pilot:** "Pushback approved, facing north, runway {rwy}, {cs}." Pilot may reply "{cs}, request facing south due company traffic" (5%).
- **Engine (state machine):** `parked → tug_attach (20–40 s) → pushing (40–90 s at ≤3 kt, curved path: straight 15–25 m, then arc to the requested facing; total 40–80 m) → tug_disconnect (20–30 s: brakes set, bypass pin, tug drives clear) → pushback_complete`. Pilot then calls "{cs}, request taxi" after 5–20 s. Tug entity (§1.19) drives from tug pool to stand before attach (adds travel time at 15 kt). Push aborts if an aircraft enters the 30 m push zone ("{cs}, stopping pushback, traffic behind").
- **UI:** dashed push arc preview when hovering facing options; tug sprite.
- **Score:** −200 **ground collision** if push zone violated by player-issued taxi; +0. Pushing into a taxiing aircraft's path that then stops = "taxi conflict" −20.
- **Edge:** stand type `noseOut` skips tug; tug shortage → "expect two minutes delay, tug unavailable"; pushback across an active taxiway requires `give way` logic — pilot asks "{cs}, request push, traffic on Alpha?" and the controller must sequence.

### 1.4 Taxi to Runway (GND) — incl. progressive taxi
- **When:** `pushback_complete` (engines stable) or `startup` complete at nose-out stand.
- **Params:** `runway` (+ optional `intersection` e.g. "at Charlie"), `via: taxiway[]` (optional → A* default), `holdShort: runway|taxiway` (mandatory if route crosses a runway, per 7110.65 3-7-2: taxi clearance never includes crossing a runway).
- **ATC:** "{cs}, taxi to holding point runway {rwy} via Alpha, Bravo, hold short of runway {xrwy}." · FAA: "{cs}, runway two seven left, taxi via Alpha Bravo, hold short runway two two." · intersection: "…runway two seven left at Charlie…" · progressive: "{cs}, taxi straight ahead, next right on Bravo, then hold short Charlie" (`PROGRESSIVE` mode — controller issues `TURN LEFT/RIGHT NEXT`, `STRAIGHT AHEAD`, `HOLD SHORT`, `CONTINUE`).
- **Pilot:** "Taxi holding point runway {rwy} via Alpha Bravo, hold short runway {xrwy}, {cs}."
- **Engine:** A* route on taxi graph (GROUND_MOVEMENT_SPEC §4); speeds: straight ≤ `maxTaxiSpeed` (15–20 kt, apron 10 kt), turns `taxiTurnSpeed` 8–12 kt, high-speed exits 25–30 kt; accel 1.2 m/s², braking 2.5 m/s². Auto-stops at every runway hold line (`hold_short` phase) unless a `cross` clearance is pre-issued. Auto-stops behind traffic (60 m same direction, 100 m opposing, 100 m behind H/S). If no `via` given the pilot picks shortest route and reads it back; a `via` that does not connect → pilot "{cs}, unable, Bravo doesn't connect to Delta, say again route". Route through a **closed taxiway** → "unable, Bravo closed". Wrong-runway hold-short omission → pilot still stops at the hold line (safety net) but **"incomplete taxi instruction" −25 pts**.
- **UI:** yellow route line + hold-short red ticks + ETA; progressive mode highlights next intersection.
- **Score:** +5 when aircraft reaches the hold point. Taxi conflict stop (two aircraft nose-to-nose >30 s) −20 each; **ground collision** −500 (Tower!SE value) and both aircraft frozen; **runway incursion** (crosses a hold line without clearance because of a bad `via` through an active runway) −500.
- **Edge:** one-way taxiways; `expedite` (§1.10); aircraft too big for taxiway (`maxWingspan` on edge) → "unable, wingspan"; taxi into occupied runway-entry queue → automatic queue ordering (FIFO) with "number two for departure, follow the {type}".

### 1.5 Hold Short (GND/TWR)
- **When:** any taxiing aircraft; target = runway or taxiway intersection ahead on route.
- **ATC:** "{cs}, hold short of runway {rwy}." / "…hold short of taxiway Delta." — **Pilot:** "Hold short runway {rwy}, {cs}." (mandatory readback; missing readback → pilot repeats after 5 s; player scoring unaffected).
- **Engine:** GROUND_MOVEMENT_SPEC §7.3 decel profile (25 m→3 m/s, 15 m→1 m/s, stop <10 m before line); state `hold_short`; taxiway hold uses the intersection node 15 m before centreline crossing. Runway hold lines are **Category III** (mandatory; never crossed without explicit `cross` or `line up`/`takeoff`).
- **Score:** none. Holding aircraft >5 min at a runway hold with no reason → contributes to avg delay.
- **Edge:** if target already behind the aircraft → "unable, already past Delta"; hold-short of the *departure* runway is implicit in every taxi clearance.

### 1.6 Cross Runway (GND with TWR coordination)
- **When:** aircraft `hold_short` at a runway hold line for a runway that is not its departure runway.
- **ATC:** "{cs}, cross runway {rwy}, report vacated." / FAA "cross runway two two at Charlie". Multiple: "{cs}, cross runways two two left and two two right". — **Pilot:** "Cross runway {rwy}, {cs}." … later "{cs}, runway {rwy} vacated."
- **Engine:** Requires **runway crossing lock** from TWR: allowed only if runway `state ∈ {idle, closed}`, no aircraft cleared to land within **2 NM of threshold** and no aircraft `lineup/takeoff` on it (7110.65 3-1-3: "the runway is clear"). When TWR is auto: GND request appears → auto-TWR grants after 2–10 s if safe; if unsafe it replies "unable, {arrival} on 1-mile final" and the player waits. Crossing takes 20–45 s (width 45–60 m + shoulders at 10–15 kt). `runway.state=occupied_crossing` until whole aircraft is past the far hold line.
- **UI:** runway crossing ribbon glows; strip badge "XING 22".
- **Score:** **Runway incursion** −500 when the crossing overlaps a landing/takeoff (7110.65 3-1-3 violation); a *cleared* arrival that must go around because of the crossing → additionally −500 "unhandled go-around" attributed to the player. Efficient crossing (no arrival delay) +5.
- **Edge:** "Expedite crossing" variant (§1.10). Landing aircraft **inside 2 NM**: engine forces `go_around` if crossing aircraft still on the runway when arrival is at 0.5 NM / 200 ft.

### 1.7 Give Way / Follow Traffic (GND)
- **ATC:** "{cs}, give way to the {type} on Bravo from your left, then continue." · "{cs}, follow the company 737 ahead to runway {rwy}." · TS3 "follow company".
- **Pilot:** "Give way to the 737, {cs}." / "Following the company 737, {cs}."
- **Engine:** `giveWayTo=id`: aircraft stops before the next conflicting intersection until the referenced aircraft's tail is 60 m past it, then resumes. `followId`: aircraft copies leader's route, keeps 60 m (100 m behind H/S), stops when leader stops, inherits leader's hold-short points (but not runway/cross clearances — must be re-issued).
- **Score:** resolves intersection conflicts; if not issued and two aircraft arrive simultaneously the engine applies the default rule (first-arrives-first, heavier on tie) and logs −20 "unresolved taxi conflict" if either waits >30 s.
- **Edge:** reference aircraft ambiguous → "{cs}, which aircraft?"; leader turns into a gate → follower stops and requests taxi.

### 1.8 Hold Position / Continue Taxi (GND/TWR)
- **ATC:** "{cs}, hold position." — **Pilot:** "Holding position, {cs}." · "{cs}, continue taxi." / "…continue, hold short of runway {rwy}" — **Pilot:** "Continue taxi, {cs}."
- **Engine:** immediate braking (2.5 m/s²) on `hold position`; on `continue` resumes previous clearance and hold-short points. `HOLD POSITION` given to an aircraft on a runway during takeoff roll below 80 kt = **rejected takeoff** (§2.4).
- **Score:** none; frequent unnecessary holds raise avg delay.

### 1.9 Taxi to Gate / Stand (GND) — arrivals
- **When:** after landing, aircraft has vacated (past the hold line) and contacted ground ("{cs}, runway vacated, taxi to stand").
- **Params:** stand/gate (default = assigned in flight plan, §1.20), `via`, `holdShort`.
- **ATC:** "{cs}, taxi to stand {A12} via Delta, Alpha, hold short of runway {xrwy}." — **Pilot:** "Stand {A12} via Delta Alpha, hold short {xrwy}, {cs}."
- **Engine:** as 1.4, ends with a gate approach at ≤5 kt over the final 30 m, marshaller stop (5 s), then `parked` (engines shut down after 60 s, aircraft despawns 120–300 s later freeing the gate). Occupied gate → pilot "{cs}, stand {A12} is occupied" and the aircraft holds at the nearest apron node; player must reassign ("taxi to stand {B3}") or use TS3-style "your arrival gate is occupied, taxi and hold at the intersection of Alpha and Delta".
- **Score:** **+10 safe landing + parked** (Tower!SE: +10 landing) awarded at `parked`; `skill += 0.1` scaled. Arrival taxi > 12 min → "excess taxi time" (delay stat).

### 1.10 Expedite (GND/TWR)
- **ATC:** "{cs}, expedite taxi, traffic on a two-mile final." / "…expedite crossing…" / "…expedite vacating…" — **Pilot:** "Expediting, {cs}."
- **Engine:** temporary speed cap +30% (max 25 kt straight, 12 kt turns) for 90 s; pilot refuses if wet/contaminated runway (`brakingAction != good`): "unable to expedite". Heavies only +15%.
- **Score:** none directly; over-use (>3 expedites to the same aircraft) → pilot complaint, −10 "unrealistic instruction".

### 1.11 Runway Crossing Coordination (GND↔TWR)
- Modelled explicitly so a single player sees the workload: every crossing needs a **TWR token**. When the player is TWR and GND is auto, auto-GND requests appear as strip badges "REQ XING 22 (AAL123)"; player answers via "cross" (grants) or "hold short" (denies). Token expires 60 s after grant if the crossing hasn't started. Metric: **crossings per hour** and **crossing-induced go-arounds**.

### 1.12 Follow-Me Car Escort (GND)
- **When:** on player command for any taxiing aircraft, or automatically requested by the pilot (8% of GA/unfamiliar-airline arrivals, 100% in LVP RVR < 550 m for arrivals to remote stands, or after a "lost on the airfield" event).
- **ATC:** "{cs}, follow-me car will meet you at Delta, follow the follow-me to stand {A12}." — **Pilot:** "Follow the follow-me, {cs}." Follow-me driver (vehicle callsign "Follow-me 1") on frequency: "Ground, Follow-me 1, request proceed via Delta to meet {cs}."
- **Engine:** vehicle dispatched from the follow-me station; drives (taxiways 30 km/h ≈ 16 kt; runways ≤ 60 km/h for crossings; apron 25 km/h) to a rendezvous 60 m ahead of the aircraft, then leads at ≤ 15 kt; aircraft `followId=vehicle`. At the stand the car peels off and returns to base. Vehicle needs its own runway crossing clearance ("Follow-me 1, cross runway 22").
- **Score:** none; +5 "assisted" if a lost aircraft is escorted before it commits a taxiway violation; ignoring a lost pilot for >90 s → aircraft may take a wrong turn (−20 taxiway deviation; −500 if it wanders onto a runway).

### 1.13 Ground Vehicle Dispatch & Movement (GND)
All vehicles are entities on the taxi graph with their own callsigns, requests and clearances; they obey hold lines exactly like aircraft and count for ground-conflict logic (safety radius 8 m).

| Vehicle | Callsign | Home | Count | Speed (taxiway / runway / apron) | Dispatch trigger | Station & return logic |
|---|---|---|---|---|---|---|
| ARFF fire/rescue truck | Fire 1/2/3 | Fire station | 3 | 80 km/h / 100 km/h / 30 km/h (43 / 54 / 16 kt) | Emergency (§4) "local standby" or "full emergency" | Local standby: 2 trucks to pre-assigned runway standby points abeam the mid-point and the touchdown zone (must arrive ≤ 180 s — ICAO Annex 14 §9.2 / Part 139: 3 min first truck, 4 min all). Full emergency: all 3 + ambulance; after aircraft stops trucks close to 50 m, hold runway 8–20 min, then return. Auto-return 120 s after "stand down". |
| Ambulance | Medic 1 | Fire station | 1 | 60 / 80 / 25 km/h | Medical emergency, full emergency | Waits at gate/standby point; returns after patient transfer (180 s). |
| Follow-me car | Follow-me 1/2 | Ops building | 2 | 50 / 60 / 25 km/h (led speed ≤15 kt) | §1.12, runway checks | Returns to base after each job. |
| Pushback tug | Tug 1–N (N = gates/4) | Tug pool near apron | N | 15 kt empty, 3 kt pushing | §1.3 | Nearest free tug; after disconnect drives to the tug lay-by then pool. |
| Fuel bowser | Fuel 1/2 | Fuel farm | 2 | 30 / — / 20 km/h (never on runways) | Automatically for turnarounds (45% of arrivals), plays visually; no radio unless crossing a taxiway with traffic ("give way") | Serves gate 8–15 min, returns. |
| De-ice rig | Iceman 1/2 | De-ice pad | 2 | 25 / — / 15 km/h | §1.14 | Stays on pad; goes to gate for "gate de-icing" mode. |
| Catering truck | Cater 1/2 | Apron | 2 | apron only 20 km/h | Turnaround visuals | 10–20 min at gate. |
| Baggage tug (train) | Bags 1–4 | Apron | 4 | 15 km/h apron, 25 km/h service roads | Turnaround visuals; may block a pushback lane 3% | — |
| Runway-inspection car | Ops 1 | Ops building | 1 | 60 km/h taxiway, 60–80 km/h on runway during inspection | §2.13 (scheduled every 4 h sim, after emergencies, after bird strike, after suspected FOD) | Requests "enter runway {rwy} for inspection"; inspection takes 3–6 min (full length + back); reports "runway inspection complete, no FOD found" / "FOD found, request 5 more minutes". |
| Bird-scare unit | Bird 1 | Ops | 1 | 40 km/h | §2.14 | Drives to reported bird area (grass strip node), 4–8 min dispersal, reports "birds dispersed". |

- **Vehicle phraseology:** vehicles request: "Ground, Fire 1, request cross runway 27 at Delta" → ATC "Fire 1, cross runway 27 at Delta, report vacated" → "Crossing 27, Fire 1". Emergency vehicles under **full emergency** get "Fire 1, 2 and 3, proceed via Alpha to runway 27, runway is yours" (runway state → `closed_emergency`). ATC can command any vehicle: `HOLD POSITION`, `PROCEED VIA`, `CROSS`, `ENTER RUNWAY`, `VACATE RUNWAY`, `RETURN TO BASE`.
- **Engine:** vehicles use the same path-follower; `isVehicle=true` skips wake/airborne logic; vehicle on an active runway sets `runway.state=occupied_vehicle` → landing/takeoff clearances are refused by the engine ("unable, vehicle on runway") and, if the player insists, an issued clearance is **executed** (pilot doesn't know) → forced go-around when the arrival is at 1 NM (−500 "runway incursion") — this is the primary "trap" mechanic.
- **UI:** vehicle layer toggle; vehicle strips in a separate "Vehicles" panel; ARFF response timer bar during emergencies.
- **Score:** ARFF arrival within 180 s of "full emergency" declaration = +50 "ARFF on time"; slower (player never cleared them across a runway, or routed poorly) = −100 per minute late.

### 1.14 De-icing Pad Procedure (GND)
- **When:** weather `oat ≤ 3 °C` with precipitation, frost, or `deiceRequired` set by ATIS; pilot requests at start-up: "{cs}, request de-icing". Two modes per airport: **gate de-icing** (rig comes to the stand: 6–12 min, then push) or **remote pad** (taxi to pad, queue).
- **ATC (pad):** "{cs}, taxi to de-icing pad {P1} via Alpha, hold short of the pad, contact Iceman on {freq}." Return: "{cs}, de-icing complete, taxi to holding point runway {rwy} via Kilo."
- **Pilot:** "…taxi to de-icing pad {P1}…, {cs}." After: "{cs}, de-icing complete, holdover started {time}, request taxi."
- **Engine:** pad has `bays` (1–3). Treatment time: Type I only 4–7 min (medium), 6–10 min (heavy/super); Type I + Type IV anti-ice +3 min. **Holdover time (HOT)** assigned from a simplified FAA HOT table: frost 45 min (Type IV, upper), light snow 20–45 min, moderate snow 10–20 min, freezing drizzle 15–35 min, light freezing rain 10–25 min; Type I only: 3–15 min. If `now − hotStart > HOT` before takeoff → pilot: "{cs}, holdover time expired, request return to de-icing" (−0 pts but big delay). No HOT for heavy snow/freezing rain → airport suspends departures ("de-icing not effective").
- **UI:** de-ice queue panel with bay status and per-aircraft HOT countdown (turns amber at 25%).
- **Score:** takeoff clearance to an aircraft whose HOT expired → −100 "contaminated aircraft departed" (pilot may refuse: 70%). Avg delay heavily affected in winter scenarios.

### 1.15 Gate Assignment & Occupancy (GND)
- Each stand: `id`, `type` (contact/remote/GA/cargo), `maxWingspanClass`, `pushback: tug|noseOut`, `occupiedBy`, `reservedFor`, `airlinePreference`. Arrivals get a stand at spawn (airline preference, size); the player can reassign at any time ("{cs}, change of stand, taxi to stand {B7}"). Turnaround: an arrival at a gate becomes a departure after `turnaround` 35–90 min (compressed by time accel) — optional "linked flights" mode. Gate conflict resolution: if a departure at the gate hasn't pushed when the arrival reaches the apron, the arrival holds (§1.9). **Metrics:** gate utilisation, average holding-for-gate time. **Score:** arrival waiting >5 min for a gate → −10 per additional 5 min.

---

## 2. TOWER FEATURES

Runway state machine (per runway end pair): `idle | occupied_lineup | occupied_takeoff | occupied_landing | occupied_rollout | occupied_crossing | occupied_vehicle | closed | closed_emergency`. **One aircraft on the runway at a time** is the base rule (7110.65 3-10-3 / 3-9-6); daytime "anticipated separation" allowed only as described in 2.5.

### 2.1 Line Up and Wait (TWR)
- **When:** `hold_short` at the departure runway hold line (full length or intersection), runway `idle` or preceding departure airborne / preceding arrival expected to vacate. **Not** when an arrival is inside **3 NM** on final at night / **2 NM** by day (game rule derived from 3-9-4's "takeoff clearance imminent").
- **ATC:** "{cs}, runway {rwy}, line up and wait." · with traffic: "{cs}, runway {rwy}, line up and wait, traffic a Boeing 737 six-mile final." · intersection: "{cs}, runway {rwy} at Charlie, line up and wait." · conditional (ICAO): "{cs}, behind the landing A320, line up and wait runway {rwy}, behind."
- **Pilot:** "Runway {rwy}, line up and wait, {cs}." (FAA requires runway in readback.)
- **Engine:** taxi onto runway and align: 25–45 s (medium), 35–60 s (heavy), 45–70 s (super) from hold line to aligned & stopped; `runway.state=occupied_lineup`. Aircraft holding on the runway > **90 s** without takeoff clearance → pilot: "{cs}, holding in position, are we cleared?" (−0); > 180 s with an arrival inside 3 NM → engine auto-go-around for the arrival (−500 to player).
- **UI:** runway outline turns amber; strip badge LUAW.
- **Score:** LUAW with an arrival inside the limit = −100 "unsafe line-up" (no incursion if the arrival is later sent around by the player in time).
- **Edge:** two aircraft LUAW on the same runway (different intersections) is prohibited → engine refuses ("unable, runway occupied"). Player may cancel: "{cs}, hold position" (aircraft stays) or "{cs}, vacate runway via Charlie, traffic on short final".

### 2.2 Cleared for Takeoff (TWR)
- **When:** `hold_short` at departure runway (rolling takeoff) or `lineup`. Preconditions checked and **reported** (engine still executes; violations score): runway idle or `occupied_lineup` by this aircraft; preceding departure airborne **and** past the runway end or turned/6000 ft ahead (3-9-6: 6000 ft for Category III jets, 4500 ft Cat II, 3000 ft Cat I); **wake timer** expired (§2.7); no arrival inside 2 NM (day) / 3 NM (night or IMC); no crossing/vehicle on runway; departure release from APP (auto unless `requireRelease`).
- **ATC:** "{cs}, wind two seven zero degrees eight knots, runway {rwy}, cleared for takeoff." · FAA: "{cs}, runway two seven left, cleared for takeoff, wind two seven zero at eight." · with heading: "{cs}, fly runway heading / turn left heading two four zero, runway {rwy}, cleared for takeoff." · immediate: "{cs}, runway {rwy}, cleared for immediate takeoff." · wake advisory: "…caution wake turbulence, departing heavy Boeing 777."
- **Pilot:** "Cleared for takeoff runway {rwy}, {cs}." / "Runway heading, cleared for takeoff runway {rwy}, {cs}."
- **Engine:** from `lineup`: spool-up 8–15 s then roll; from `hold_short` (rolling takeoff): 25–45 s taxi-on + no stop. Takeoff roll: accel to `Vr` (65 kt light / 135–150 kt jets) with a=1.8–2.3 m/s² (light 1.5) → roll 30–45 s, 1500–2500 m; rotation at Vr (nose up 3°/s while the roll continues), wheels off at ~8° pitch ≈ Vr+10 (`airborne`), pitch on to ~13° for the initial climb 2500–3500 ft/min to 1500 ft AGL then type ROC; turns not before 400 ft AGL; accelerate to 250 kt by 3000 ft. `runway.state=occupied_takeoff` until airborne and past runway end. Departure appears on APP scope, auto-handoff at 1000 ft AGL unless `manualHandoff` (§2.15). "Immediate" → pilot skips checks, 4% "unable immediate" (heavy 10%).
- **UI:** runway outline green→pulsing; wind readout auto-inserted; strip flips to TWR-airborne column.
- **Score:** +10 safe takeoff (Tower!SE). Violations: runway occupied by another aircraft/vehicle when roll starts −500 **runway incursion**; wake timer not expired −200 "wake separation" (plus 15% chance pilot refuses "we'll wait for wake turbulence"); arrival inside limit with no separation at threshold crossing −500; wrong runway −100; takeoff with tailwind > 10 kt −25 "performance" (pilot may refuse 30%); crosswind > 35 kt (jets) / 15 kt (light) → pilot refuses.
- **Edge:** takeoff clearance to an aircraft not at the correct runway → "{cs}, we're holding short of runway two two, confirm?" (no execution). Aircraft that were told to `hold position` need an explicit new clearance.

### 2.3 Rolling Takeoff (TWR) — covered in 2.2 (`hold_short` → `takeoff` without stopping). Adds 15–20 s of runway occupancy vs. LUAW; pilots accept only if ≤ 45 s since taxi stopped (else "we need a moment").

### 2.4 Cancel Takeoff Clearance / Abort (TWR)
- **When:** after `cleared takeoff` and before airborne.
- **ATC (before roll):** "{cs}, hold position, cancel takeoff clearance, I say again, cancel takeoff, {reason}." **Pilot:** "Holding position, {cs}." · **ATC (rolling):** "{cs}, stop immediately, {cs} stop immediately, {reason}." **Pilot:** "Stopping, {cs}."
- **Engine:** before roll → returns to `lineup`. Rolling < 80 kt → **rejected takeoff**: decel 3.0 m/s², stops in 10–20 s, then `lineup` (pilot needs 60–120 s brake cooling; 5% "request return to gate for brake check" → taxi back, aircraft removed from sequence). ≥ V1 (`0.9·Vr`) → pilot refuses and continues ("{cs}, unable, continuing takeoff"). High-speed RTO (60–80 kt) → mandatory runway inspection (§2.13) + 10 min brake cooling.
- **Score:** correct cancel that prevents an incursion +50 "good catch"; unnecessary cancel −25; cancel above 80 kt attempts −0 (pilot decides).

### 2.5 Cleared to Land (TWR)
- **When:** arrival in `approach` (established on ILS/visual, inside 10 NM) and on TWR frequency. Preconditions (reported/scored, still executed): runway `idle` or expected to be clear before threshold (anticipated separation: preceding arrival will be ≥ 6000 ft from threshold / vacated for Category III, 7110.65 3-10-3; preceding departure airborne and past runway end); no vehicle; no crossing.
- **ATC:** "{cs}, wind two seven zero degrees one zero knots, runway {rwy}, cleared to land." · FAA: "{cs}, runway two seven left, cleared to land, wind two seven zero at one zero." · with traffic: "…number two, traffic 737 on three-mile final…" · "…caution wake turbulence, heavy 747 departing runway two seven right" · exit: "…vacate via Delta / turn right next taxiway / exit at Charlie" (TS3 `EXIT AT`, `VACATE LEFT/RIGHT ONTO`).
- **Pilot:** "Cleared to land runway {rwy}, {cs}." Inside 4 NM without clearance → pilot: "{cs}, four-mile final, confirm cleared to land?" ; inside 1 NM / 300 ft without clearance → **pilot-initiated go-around** (Tower!SE "UNHANDLED" −500).
- **Engine:** ~2° nose-up on the slope (pitch = flight-path angle + angle of attack), flare at 50 ft (sink eases 700→400 fpm, nose to ~5°); touchdown 300–450 m past threshold at Vapp−5; de-rotation over the first seconds of the roll; rollout decel 1.5–2.5 m/s² (wet 1.0–1.5, contaminated 0.7) → runway occupancy time **45–60 s** medium, 55–75 s heavy/super, 30–40 s light; exit choice: first high-speed exit reachable at ≤ 30 kt (medium) / 25 kt (heavy), otherwise next 90° exit at ≤ 15 kt; ATC-requested exit honoured if decel permits, else "unable Charlie, we'll take Delta". Vacated when tail past hold line → pilot: "{cs}, runway vacated" (if asked) and auto-"contact ground" after `runway vacated`. `runway.state=occupied_landing` from 1 NM (or 2 NM for H/S) until vacated.
- **UI:** landing tick on strip; final-approach ladder shows 10/6/4/2/1 NM with required-clearance zone; runway occupancy timer.
- **Score:** +10 safe landing (awarded at vacate; +10 more at gate per §1.9). Landing on an occupied runway (any other aircraft/vehicle between threshold crossing and exit) −500 **runway incursion**; landing clearance issued with wake below minimum −200; no clearance → −500 unhandled go-around; tailwind >10 kt −25; landing without wind check (config `requireWindOnClearance`) −5.

### 2.6 Go Around (TWR) — ATC- or pilot-initiated
- **ATC-initiated:** any arrival inside 10 NM, before touchdown (after touchdown but before reverse/60 kt: pilot may still go around, "balked landing", 50%).
- **ATC:** "{cs}, go around, I say again, go around, {reason: traffic on the runway}." Then missed approach routing: "{cs}, climb straight ahead / fly runway heading, climb to three thousand, contact approach on {freq}." (or "fly the published missed approach").
- **Pilot:** "Going around, {cs}." then "Runway heading, climbing three thousand, {cs}."
- **Engine:** TOGA: pitch up 2 s, climb 2000–3000 ft/min, gear/flap retraction, IAS 160→200 kt over 60 s; lateral: runway heading unless instructed; default missed approach: climb to `missedApproachAlt` (airport, default 3000 ft) then hold at the missed-approach fix (if no vectors within 3 min, the aircraft enters the published hold). Separation grace: 60 s reduced-minima window vs. the departure ahead (approach_atc §10.2). Aircraft returns to APP control at `missedApproachAlt` or on "contact approach". Re-sequence via §3.
- **Pilot-initiated (random 1.5% of approaches + forced cases):** unstable approach (>2 dots off GS, >IAS+15 at 1000 ft), wind shear alert, runway occupied at 1 NM, no landing clearance at 300 ft, tailwind > 10 kt (50%), RVR below minima (§5). Pilot: "{cs}, going around, {reason}." Controller must acknowledge and route: "{cs}, roger, fly runway heading, climb three thousand."
- **UI:** big "GA" flash on strip and runway; missed-approach track drawn (dashed) on both ground map and radar.
- **Score:** Player-caused go-around (runway occupied/vehicle/LUAW too late/no clearance) −500 (Tower!SE UNHANDLED) plus `skill −0.5`; correctly-ordered go-around that avoids an incursion (traffic still on runway when arrival < 1 NM) +50 "safety go-around"; go-around with no routing given within 30 s → aircraft flies runway heading and climbs to 3000 (safe) but −25 "no missed approach instructions"; departure launched into the go-around's path (<3 NM, <1000 ft) → separation loss −500.
- **Edge:** go-around ordered after touchdown and reversers deployed → "unable, stopping" (rollout continues). Two go-arounds in the same session for the same aircraft → pilot requests diversion (§3.16) or declares minimum fuel.

### 2.7 Wake Turbulence Departure Timers (TWR)
Categories map from `weightClass`: `S→SUPER (J)`, `H→HEAVY`, `M→MEDIUM` (B757 flagged `b757=true` treated as HEAVY-leader for MEDIUM/LIGHT followers per FAA), `L→LIGHT`.

**Time-based (ICAO Doc 4444 §5.8.3, Amdt 9) — departures from the same runway or parallel < 760 m, full length; timer starts at leader's rotation (airborne):**

| Leader → Follower | Full-length | Intermediate / intersection dep. (follower enters downstream) | Opposite direction / displaced threshold crossing paths |
|---|---|---|---|
| SUPER → HEAVY | 2 min (FAA: 3 min) | 3 min | 3 min |
| SUPER → MEDIUM / LIGHT | 3 min | 4 min | 3 min |
| HEAVY → MEDIUM / LIGHT | 2 min | 3 min | 2 min |
| MEDIUM → LIGHT | 2 min | 3 min | 2 min |
| all other pairs | none (runway sep only) | none | none |

**Arrival behind departure / departure behind arrival (crossing paths, displaced threshold):** MEDIUM/LIGHT behind HEAVY 2 min, behind SUPER 3 min. **Non-radar arrival time minima** (used when APP is auto and spacing is time-based): MEDIUM behind HEAVY 2 min; LIGHT behind HEAVY/MEDIUM 3 min; behind SUPER: HEAVY 2, MEDIUM 3, LIGHT 4 min.

- **Engine:** `runway.wakeTimer = {leaderCat, expiresAt}`; takeoff clearance before expiry → executed but scored (−200) and 15% pilot refusal ("we'll wait two minutes for wake turbulence"). A pilot may **waive** wake (real-world: only for intersection/crossing cases, not behind SUPER/HEAVY departures in FAA) — game: pilot request "request early departure, waive wake" appears 10% for MEDIUM behind HEAVY; player may "approve" (no penalty, logged).
- **ATC advisory phraseology:** "{cs}, hold for wake turbulence, heavy 777 departing; expect two minutes." / "{cs}, caution wake turbulence, departing heavy Airbus 380."
- **UI:** countdown ring on the runway entry marker, color by remaining time; strip badge "WT 1:23".
- **Score:** as above; **+5 "efficient launch"** when clearance is issued within 10 s of timer expiry.

### 2.8 Runway Separation Rules (TWR) — engine rule set
1. One aircraft on the runway at a time (base). 2. **Departure–departure**: next departure may start roll when the previous is airborne and (a) has turned ≥ 45° or (b) is ≥ 6000 ft (Cat III), 4500 ft (Cat II: light twins), 3000 ft (Cat I: singles/helis) ahead (7110.65 3-9-6). 3. **Arrival–departure**: departure roll may start when the arrival has vacated (or, daytime, is ≥ 6000 ft down the runway and will vacate — "anticipated separation", config `anticipatedSeparation`, default on). 4. **Arrival–arrival**: arriving aircraft must not cross the threshold until the preceding has vacated (Cat III) or is ≥ 3000/4500 ft down the runway (Cat I/II, daytime). 5. Vehicles/crossings: runway must be clear before the arrival crosses the threshold and before roll starts. Violations are the −500 incursions in 2.2/2.5. **Intersecting runways** (3-10-4): an aircraft may not cross the intersection while the other runway is `occupied_takeoff/landing` and the paths cross; engine treats the intersection box as a shared resource.

### 2.9 Active Runway Selection from Wind (TWR)
- Runway config chosen at session start and re-evaluated every 10 min or on wind change: score = headwind component − 2·|crosswind|·0.1 − (tailwind>0 ? 100 : 0) + noise-preference bonus + parallel-pair bonus; **tailwind ≤ 5 kt preferred, ≤ 10 kt allowed, > 10 kt forbidden**; crosswind > 25 kt prompts change; calm wind (< 5 kt) → airport `preferredCalmConfig`. Engine exposes `suggestedConfig` with a HUD prompt "Wind 090/14 — runway 09 recommended (current 27, tailwind 12)". Player decides (§2.10). Auto-TWR applies it after 5 min.
- **Score:** operating with tailwind > 10 kt for > 10 min → pilots refuse landings/takeoffs (diversions/holds pile up); −10 per minute of pilot refusals.

### 2.10 Runway Change Procedure (TWR + APP + GND)
- **ATC command:** `RUNWAY CHANGE {newConfig}` (config menu). Engine sequence: (1) ATIS regenerates with "runway change in progress, expect runway {new}" (new letter); (2) departures already taxiing keep old clearances; player must re-taxi them ("{cs}, change of runway, taxi to holding point runway {new} via …"); (3) arrivals: those inside 10 NM finish on the old runway (grace 8 min), others get re-vectored by the player/auto-APP with "{cs}, change of runway, expect ILS runway {new}"; (4) old runway → `idle`, new config active when the last old-runway movement completes.
- **Pilot:** "Roger, runway {new}, {cs}." Arrivals inside 5 NM refuse a change ("unable, continuing runway {old}").
- **Score:** +100 "runway change completed" when no go-around/diversion occurs during transition; each arrival holding > 10 min due to the change −10.

### 2.11 LAHSO — Land and Hold Short (TWR, optional, `lahsoEnabled` airports with intersecting runways)
- **When:** VMC (ceiling ≥ 1000 ft, vis ≥ 3 SM — AIM 4-3-11), dry runway, no tailwind, arrival's required landing distance ≤ published ALD for the pair, aircraft type LAHSO-eligible (no wide-bodies/supers by default).
- **ATC:** "{cs}, runway {rwy} cleared to land, hold short of runway {x} for crossing traffic, {5,050} feet available." — **Pilot:** "Cleared to land runway {rwy}, hold short of runway {x}, {cs}." (mandatory) · or "Unable hold short, {cs}" (15%; 40% for heavy-class, 100% wet/tailwind). Traffic info to the other aircraft: "{cs2}, traffic, 737 landing runway {rwy} will hold short of your runway."
- **Engine:** rollout decel 2.5 m/s² targeted to stop ≥ 50 m before the intersection hold line; if `landingDistance > ALD` (wet/fast) → pilot rejects; if the aircraft still overruns (2%) → runway incursion event for the intersection.
- **Score:** valid LAHSO that saves a go-around +30; issued in IMC/wet/tailwind −100 "LAHSO conditions"; overrun −500.

### 2.12 Wind / QNH / ATIS Letter & Content (TWR)
- ATIS regenerates on: hourly, wind change ≥ 30° or ≥ 5 kt, QNH change ≥ 1 hPa, visibility/RVR category change, runway change, runway/taxiway closure, LVP on/off, de-icing status, bird activity. Letter advances Alpha→Zulu, wraps. **Content (ICAO order):** "{Airport} information {Letter}, time {hhmm} zulu. Runway in use {rwy} (landing), {rwy} (departure). Expect ILS approach. Transition level {70}. Wind {270} degrees {10} knots, gusting {18}, variable between {240} and {300}. Visibility {10 km / 4000 m}, RVR runway {27} {1200 m}. {Light rain}. Cloud {scattered 1500 ft, broken 2500 ft} / ceiling {…}. Temperature {12}, dew point {9}. QNH {1013} hectopascals / altimeter {29.92}. {Remarks: LVP in operation · Taxiway Bravo closed between Delta and Echo · De-icing in progress, expect delays · Bird activity reported in the vicinity of runway 27 · Runway 09/27 wet, braking action good}. Acknowledge information {Letter} on first contact."
- **Player use:** on first contact the pilot states the letter; if the pilot has an old letter (ATIS changed while taxiing), the controller must issue "{cs}, information {Letter} now current, QNH {…}". Failure to do so before takeoff/landing clearance → −5 "outdated ATIS" (pilot may query 30%).
- **Engine:** ATIS text stored per letter; `qnh` used by the altitude model (arrivals set QNH on first contact; a 1 hPa error = 27 ft — cosmetic in v1, but a **QNH not given** on an IFR clearance / handoff below transition level costs −5).
- **UI:** ATIS panel with play/TTS, diff highlighting vs. previous letter; wind rose with gust/variable arc; runway-selection recommendation.

### 2.13 Runway Inspection / Closure (TWR)
- **Triggers:** scheduled (every 4 h sim / at session start in some scenarios), after emergencies/RTO/bird strike/suspected FOD (pilot report "possible FOD on runway"), rubber removal/works scenario (planned closure 20–60 min).
- **ATC:** to Ops 1: "Ops 1, enter runway {rwy} via Alpha, runway {rwy} closed, report inspection complete." / "…vacate runway {rwy} at Delta, expedite, traffic three-mile final." Closure: `RUNWAY {rwy} CLOSED` / `RUNWAY {rwy} OPEN` commands (ATIS updates, strips of affected departures flagged).
- **Engine:** inspection = vehicle drives full length and back at 60–80 km/h (3–6 min for a 3–4 km runway); during `closed`, landing/takeoff clearances are refused by the engine; arrivals must be delayed (holds/vectors) or shifted to another runway; pending departures re-taxi.
- **Score:** allowing an inspection that costs zero go-arounds and ≤ 1 hold +30; landing/takeoff clearance on a closed runway (engine refuses; attempt logged) −50; vehicle still on runway when arrival crosses threshold −500.

### 2.14 Bird Activity (TWR)
- Random event (rate by season/time: dawn/dusk ×3): pilot report "{cs}, flock of birds on short final" or ATIS remark. ATC: "{cs}, caution, bird activity reported in the vicinity of runway {rwy}." Dispatch bird-scare unit (§1.13). While `birdRisk=high` on a runway, **bird strike probability** for movements on it ×5 (base 0.3%/movement → 1.5%). Bird strike → emergency §4.6 + runway inspection §2.13.
- **Score:** dispatching bird control within 2 min of a report +10; a bird strike occurring with an un-actioned report for >5 min −50 "unmitigated hazard".

### 2.15 Handoff to Departure / Accept from Approach (TWR)
- **Departures:** after airborne ≥ 400 ft AGL and clear of conflicting traffic: "{cs}, contact departure {freq}." **Pilot:** "Departure {freq}, {cs}, good day." Auto at 1000 ft AGL when `autoHandoff` (default on). Tower!SE penalty for forgetting: −100 after 3 min airborne without handoff (aircraft keeps climbing but stops at 3000 ft, requests "should we contact departure?").
- **Arrivals:** APP hands off at ~10 NM/established: pilot checks in "Tower, {cs}, ILS runway {rwy}, {8} miles." TWR must acknowledge ("{cs}, tower, continue approach, number two, wind…") within 60 s — otherwise pilot repeats; no answer by 4 NM → −25 "unanswered check-in".
- **Engine:** frequency model: each aircraft `freq ∈ {DEL, GND, TWR, APP, DEP, none}`; commands issued on the wrong position are refused ("{cs} not on your frequency") unless single-position mode.

### 2.16 Traffic Advisories (TWR/APP)
- "{cs}, traffic, {clock position/relative}, {distance} miles, {direction}, {type}, {altitude}." e.g. "traffic two o'clock, three miles, northbound, Cessna, two thousand five hundred." **Pilot:** "Looking for traffic, {cs}" / "Traffic in sight, {cs}" (VMC, 70% within 20 s) / "Negative contact, {cs}". Enables **visual separation** (§2.17) and pattern sequencing. Score: issuing an advisory before a VFR/IFR conflict < 1.5 NM/500 ft in the pattern avoids the −500 separation penalty (visual separation applied); none otherwise.

### 2.17 Visual Approach Clearance (TWR/APP) — see §3.12 for APP side
- **When:** ceiling ≥ 500 ft above MVA (game: ≥ 1500 ft) and visibility ≥ 3 SM (7110.65 7-4-3); pilot reports field or preceding traffic in sight.
- **ATC:** "{cs}, report the field in sight" → "Field in sight, {cs}" → "{cs}, cleared visual approach runway {rwy}, contact tower {freq}." Following: "{cs}, traffic twelve o'clock, four miles, 737 on final for runway {rwy}, report in sight" → "Traffic in sight" → "{cs}, follow that traffic, cleared visual approach runway {rwy}, caution wake turbulence."
- **Engine:** aircraft flies a direct/base-leg join at 180→160 kt, self-spaces 3 NM (visual) / wake distance behind the traffic it follows; no ILS geometry rules; night: only if `visualApproachAtNight` config.
- **Score:** visual clearance in IMC −100 (pilot refuses 80%); saves 1–3 min per arrival (delay stat).

### 2.18 Touch-and-Go / Low Approach / Stop-and-Go / The Option (TWR, optional, GA & training traffic)
- "{cs}, runway {rwy}, cleared touch-and-go" / "cleared low approach" / "cleared stop-and-go" / "cleared for the option" / "make left/right closed traffic" / "extend downwind {n} miles" / "enter left base runway {rwy}". **Pilot:** "Cleared touch-and-go runway {rwy}, {cs}." Engine: pattern at 1000 ft AGL, 90–110 kt (light), downwind abeam → base → final; runway occupancy 15–25 s (touch-and-go). Low approach: no touchdown, 200 ft min over the runway (or "altitude restricted low approach, {500} feet"). Wake rules apply (LIGHT behind MEDIUM 2–3 min). Score: +5 per pattern op; runway conflicts as 2.5.

### 2.19 Light-Gun Signals (TWR, optional; used in §4.11 radio failure)
- Commands `LIGHT GUN {cs} STEADY GREEN|FLASHING GREEN|STEADY RED|FLASHING RED|FLASHING WHITE|ALTERNATING RED GREEN`. Meanings (AIM 4-3-13): in flight — steady green = cleared to land, flashing green = return for landing, steady red = give way/continue circling, flashing red = airport unsafe do not land, alternating = extreme caution; on ground — steady green = cleared for takeoff, flashing green = cleared to taxi, steady red = stop, flashing red = taxi clear of runway, flashing white = return to start. **Pilot ack:** wing rock (day) / landing-light flash (night) — shown as an animation. Only NORDO aircraft respond.

---

## 3. APPROACH / DEPARTURE FEATURES (radar)

Radar model per `context/approach_atc.md` (30 NM TMA, 3-line labels, pilot delay, ILS capture rules) with the following extensions. Separation standard **3 NM / 1000 ft** (2.5 NM on final inside 10 NM when `reducedFinalSep` and runway dry — 7110.65 5-5-4(j) analogue; 1000 ft vertical always).

### 3.1 Radar Contact / Identification (APP)
- First call: "Approach, {cs}, {alt} descending {alt}, information {L}." **ATC:** "{cs}, {Airport} approach, radar contact, {position if needed}, descend to {alt}, QNH {qnh}, expect ILS runway {rwy}." **Pilot:** "Radar contact, descend {alt}, QNH {qnh}, ILS {rwy}, {cs}." Engine: `underControl=true`, attention ring stops; if not answered within 60 s the pilot repeats; > 3 min unanswered → aircraft enters the STAR hold at the entry fix (delay). Departure check-in: "Departure, {cs}, passing two thousand climbing five thousand" → "{cs}, radar contact, climb flight level one three zero / climb via SID."
- **Score:** none; unanswered > 3 min → −10 "late identification".

### 3.2 Vectors — Turn Left/Right Heading (APP)
- **ATC:** "{cs}, turn left heading two four zero." / "fly heading …" / "turn right two zero degrees" (relative, TS3) / "…for spacing / for sequencing / vector for ILS approach runway {rwy}" (reason mandatory when vectoring off a procedure). **Pilot:** "Left heading two four zero, {cs}."
- **Engine:** turn rate from bank 25° (`rate = g·tan(bank)/V`), ≈ 3°/s at 180 kt, 2°/s at 250 kt; forced direction allowed >180°; below `MVA` on the sector map → MSAW (§3.14). Heading command cancels `direct/hold/sid` modes and any established localizer (pilot: "{cs}, we're established on the localizer, confirm heading?" — 50% of the time) — vectoring an established aircraft off the LOC without "cancel approach clearance" −25.
- **Score:** none directly; quality metrics (track miles, vectors per arrival) shown in the summary.

### 3.3 Altitude — Climb / Descend / Maintain / Expedite / Pilot's Discretion (APP)
- **ATC:** "{cs}, descend to three thousand, QNH one zero one three." / "climb flight level one three zero" / "maintain five thousand" / "descend to four thousand, expedite until passing six thousand" / "descend at pilot's discretion to three thousand" / "when ready descend …" / "cross {fix} at {alt}". **Pilot:** "Descend three thousand, QNH one zero one three, {cs}."
- **Engine:** vertical rates per `AIRCRAFT_DB` (medium 2500/1500 ft/min, heavy 3000/2000); expedite ×1.4 (pilot refuses if already at max or below 3000 ft AGL: 10%); pilot's discretion → aircraft delays descent to keep a 3°-ish profile (300 ft/NM) to the assigned altitude; altitudes below `MVA` for the sector → pilot: "unable, minimum altitude {MVA}" unless on an approach; below transition altitude altitudes are "thousand feet", above transition level "flight level". 250 kt limit automatically applies < 10,000 ft (14 CFR 91.117).
- **Score:** below MVA (executed if the pilot doesn't catch it — 30%) → MSAW alert; if the aircraft stays below MVA > 30 s −200 "terrain/MSAW".

### 3.4 Speed Control (APP)
- **ATC:** "{cs}, reduce speed to one eight zero knots." / "increase speed to two five zero" / "maintain one six zero knots until four-mile final" / "resume normal speed" / "no speed restrictions" / "reduce to minimum clean speed" / "maintain two one zero or greater". **Pilot:** "Reduce one eight zero knots, {cs}." / "Unable one six zero, minimum clean two one zero, {cs}."
- **Engine:** `minAirspeedTMA`/`maxAirspeedTMA` envelope; accel/decel rates per type (medium 1.6/1.2 kt/s); automatic rules from approach_atc §7.3 (220 kt inside 15 NM, 200 kt at LOC, 160 at 6 NM, Vapp at 4 NM) unless overridden; speeds > 250 kt below 10,000 ft refused; **speed assignments inside 5 NM final are refused** ("unable, five-mile final") except "maintain 160 to 4 DME"; speed + heading + altitude combined commands allowed in one transmission (parser: `AAL123 L240 D3000 S180`).
- **Score:** none; spacing quality metric.

### 3.5 Direct to Fix (APP)
- **ATC:** "{cs}, proceed direct {FIX}." / "…direct {FIX}, then as filed / then fly heading {hdg}". **Pilot:** "Direct {FIX}, {cs}." Engine: `navMode=direct`, `afterFixHeading` optional; unknown fix → "unable, {FIX} not in our database". Reaching the fix with no further instruction → enters a hold at the fix (standard right turns, inbound = arrival course) after 30 s — pilot: "{cs}, over {FIX}, request further".

### 3.6 Hold at Fix (APP)
- **ATC (full):** "{cs}, hold at {FIX}, inbound course two seven zero, left turns, one-minute legs, expect further clearance at {hhmm} / expect {n} minutes delay." · published: "{cs}, hold at {FIX} as published, expect further clearance {hhmm}." · leg length: "five-mile legs". **Pilot:** "Hold at {FIX}, inbound two seven zero, left turns, one-minute legs, EFC {hhmm}, {cs}."
- **Engine:** existing hold state machine (`holdPhase` in `types.ts`); entry type auto (direct/teardrop/parallel) based on the inbound course vs. arrival heading (70°/110° sectors); leg time default 1 min (≤ 14,000 ft) / 1.5 min above; leg length in NM when specified; standard turns right; **holding speeds** (AIM 5-3-8): ≤ 6000 ft 200 kt, 6001–14,000 ft 230 kt, > 14,000 ft 265 kt — aircraft auto-slows before the fix. EFC omitted → pilot asks "{cs}, say expected further clearance" after 60 s (−0, but if radio failure occurs later the aircraft leaves the hold at EFC — realism hook). Exiting: "{cs}, leave the hold heading {hdg} / direct {FIX}, descend …". Stack: multiple aircraft in one hold must be ≥ 1000 ft apart (else separation loss).
- **Score:** holds increase delay; a hold > 20 min → pilot minimum fuel (§4.4) probability rises 5%/min.

### 3.7 ILS Clearance & Localizer Intercept Rules (APP)
- **When:** arrival inside `localizerRangeNM` (25 NM), heading within **30°** of the final approach course (helicopters 45°; game tolerance up to 45° with `arcadeIntercept`), at/below the glideslope altitude at the intercept point and ≥ `minGsInterceptAlt`, intercept point ≥ 2 NM outside the approach gate (≈ 3 NM outside the FAF / ≥ 6–7 NM final).
- **ATC (PTAC):** "{cs}, {six} miles from {FIX/touchdown}, turn right heading two four zero, maintain three thousand until established on the localizer, cleared ILS runway two seven left approach." · already on course: "{cs}, cleared ILS runway {rwy} approach, report established." · LOC only: "…cleared localizer runway {rwy} approach, maintain three thousand" (`llzOnly`). **Pilot:** "Right heading two four zero, three thousand until established, cleared ILS two seven left, {cs}." … "{cs}, established localizer / established ILS two seven left."
- **Engine:** LOC capture cone: within 2.5° of the course and intercept angle ≤ 30° (45° arcade) → captures (turn-on with 25° bank); > limit → overshoots through the localizer and continues on heading (pilot: "{cs}, we've flown through the localizer"); GS capture from below only (`aboveGlideslope` → missed approach at the FAF: "{cs}, unable to capture glideslope, going around" unless re-cleared lower before the FAF); once `gsCaptured` the aircraft follows 3° to 50 ft and auto-handoff to TWR at 10 NM (or player "contact tower {freq}"). Speed logic per 3.4. Two aircraft on parallel localizers ≥ 3400 ft apart (or ≥ 4300 ft without monitor) are considered separated once both established (`reducedMinima` rule 10.2.1); before both are established, 1000 ft vertical or 3 NM required.
- **UI:** blue GS-intercept circles (2000/3000/4000 ft), yellow intercept-guide arrows, "ESTAB" tag; a red flash on the label when a clearance is issued outside the intercept rules (executed anyway — game consequence is the overshoot/missed).
- **Score:** established on ILS → **skill +0.1 × f(skill)** and +10 pts (approach_atc §8); go-around caused by an illegal intercept (too steep/too high) −50 "bad intercept" (+ delay); handoff to TWR after 4 NM −10 "late handoff".

### 3.8 Missed Approach (APP side)
- After a go-around (§2.6) the aircraft checks back in with APP: "Approach, {cs}, going around, runway heading, three thousand." ATC re-vectors: "{cs}, radar contact, turn left heading one eight zero, climb four thousand, vectors for re-sequencing." Engine: 60 s reduced-minima grace vs. the traffic that caused the go-around; the aircraft must be re-established ≥ 6 NM final; missed approaches count for the delay metric (+8 min typical).

### 3.9 Sequencing & Spacing (APP)
- Engine provides a **final approach spacing tool**: for each arrival on/near the localizer show the predicted gap at the threshold versus the required gap = max(3 NM radar [2.5 NM reduced], wake distance table below, runway occupancy time × ground speed). "Number {n}" advisories: "{cs}, number three, follow the 737 on a six-mile final, reduce speed one seven zero." 

**Distance-based wake minima on final (ICAO Doc 4444 §8.7.3.4 Amdt 9; FAA values in brackets where different):** SUPER→HEAVY 5 NM [FAA 6], SUPER→MEDIUM 7, SUPER→LIGHT 8; HEAVY→HEAVY 4, HEAVY→MEDIUM 5, HEAVY→LIGHT 6; MEDIUM→LIGHT 5; B757→MEDIUM/LIGHT 4/5 (FAA); all others 3 NM (radar minimum). Wake minima apply when the follower is within 0.5 NM laterally of the leader's track and ≤ 1000 ft below/at same level, on final or on departure track.
- **Score:** wake infringement on final by > 1 NM → engine forces go-around for the follower (approach_atc §11) and −200 "wake separation"; **3 NM/1000 ft loss** → −500 "separation error" (Tower!SE) and `skill −0.5` (Endless ATC), one per pair per 60 s while the loss persists (+ small duration term −0.01·s).

### 3.10 STCA — Short-Term Conflict Alert (APP)
- Engine predicts every pair (all airborne aircraft) linearly **120 s** ahead (EUROCONTROL: up to 2 min; TMA tuned 60–90 s), with current turn/climb rates; **alert stage 1 (amber)** when predicted separation < 3 NM & < 1000 ft within 60–120 s; **stage 2 (red + audio)** within 30 s or actual infringement. Alerts suppressed for pairs under reduced minima (both on different localizers, < 1600 ft AGL on final, diverging departures ≥ 15°, go-around grace). The label pair blinks; a conflict line joins them with the predicted CPA distance/time. Alarm inhibit while either aircraft is selected (approach_atc §10.1).
- **Score:** none for the alert itself; conflicts resolved before infringement +5 "STCA resolved"; a **safety alert phraseology** must be issued by the controller when red: "{cs}, traffic alert, {position}, {advise you turn left heading …/climb …} immediately." (`TRAFFIC ALERT` command → pilot reacts in 1 s instead of 3).

### 3.11 MSAW — Minimum Safe Altitude Warning (APP)
- Sector MVA polygons per airport (`restrictedAreas`/`minAltitudeFt` in `AirportConfig`); engine projects altitude 60 s ahead; aircraft not on final and predicted below MVA → red "MSAW" on label + audio; controller must issue "{cs}, low altitude alert, check your altitude immediately, the MVA in your area is {alt}, climb {alt}." Score: staying below MVA > 30 s without correction −200; restricted-area penetration below its floor −100 (approach_atc §10/§5.2 `RestrictedArea`).

### 3.12 Visual Approach (APP side) — as §2.17: "{cs}, {airport} at twelve o'clock, one two miles, report in sight" → "cleared visual approach runway {rwy}, contact tower {freq}". Requires reported field/traffic in sight; engine shortens the approach (self-navigation to a 3–5 NM final). Not available if ceiling < 1500 ft or vis < 3 SM (pilot: "negative contact / IMC").

### 3.13 Squawk / Ident (APP)
- "{cs}, squawk {code}." / "squawk ident" / "squawk altitude/Charlie" / "squawk standby". **Pilot:** "Squawk {code}, {cs}." Engine: duplicate code → two labels show the same tag (confusion mechanic); ident → label flashes 10 s; wrong/no code → aircraft displays as an untagged primary target until the controller assigns one. Emergency codes 7500/7600/7700 auto-set by the pilot (§4) and light the label.

### 3.14 Handoff to Tower / Center (APP)
- **Arrivals:** "{cs}, contact tower one one eight decimal seven." at 8–12 NM once established (auto at 10 NM when `autoHandoff`). Not before established → tower will refuse/redirect. **Departures:** "{cs}, contact {Center} one two eight decimal one, good day." when climbing through the sector exit altitude / 25 NM; auto when `autoHandoff`. Leaving the 30 NM boundary without handoff → "unhandled exit" −100 and counts as a diversion for skill (approach_atc §9). Arrival exiting the boundary (vectored out) → diversion −500/`skill −0.5`.

### 3.15 SID / STAR (simplified) (APP)
- Each runway has 1–3 SIDs (waypoint lists with altitude/speed constraints: "at or above 2000 at {fix}", "250 kt") and 1–3 STARs feeding an IAF/downwind. **Departures** spawn in `sid` mode (approach_atc §9): climb via SID to the SID top altitude (default FL130, `SID-off cap FL90`), auto-route to the departure fix; player may "cancel SID, fly heading…" and later "resume own navigation / climb via SID". **Arrivals** enter on a STAR at 10,000–FL130, 250 kt, and self-navigate to the IAF where they need vectors or "cleared ILS via {IAF} transition". "Descend via STAR" honors published constraints. Score: departure leaving the boundary ≤ FL90 or off the SID without reaching its fix → diversion penalty (−500 / `skill −0.5`).

### 3.16 Speed Restrictions, Airspace Exit Criteria, Diversions (APP)
- **Speed:** 250 kt ≤ 10,000 ft (auto), 200 kt in the pattern/Class D-equivalent (< 2500 ft AGL within 4 NM), holding speeds per §3.6; "high speed approved" removes the 250 cap (jets only, no penalty in game but logged).
- **Exit criteria (departures):** through the boundary above FL90 (SID) or the assigned exit altitude on the assigned fix ±5 NM; handoff done. Otherwise diversion.
- **Diversions (arrivals):** pilot-initiated when: holding > 25 min or `fuelMin` reached (spawned with fuel 45–120 min; burn 40 kg/min medium); two go-arounds; runway closed > 20 min with no ETA; weather below minima for > 15 min. Pilot: "{cs}, request diversion to {alternate}, {fuel} minutes remaining." **ATC:** "{cs}, roger, cleared to {alternate} via direct {exit fix}, climb flight level one zero zero, contact center {freq}." Engine: aircraft leaves via the nearest exit fix. Score: each diversion −500 (Tower!SE-scale) and `skill −0.5`; issuing the diversion clearance within 60 s of request +0 but avoids an additional −100 "diversion unhandled" (aircraft self-diverts after 3 min).

---

## 4. EMERGENCIES (random, pilot-declared)

**Spawn model:** per-flight probability drawn at spawn (session difficulty multiplies): base **1 emergency per ~120 movements** (≈0.8%), distributed: engine failure 14%, medical 22%, minimum fuel 12%/fuel emergency 6%, engine fire 6%, gear unsafe 10%, smoke/fire cabin 5%, hydraulic 8%, bird strike 8% (× bird risk), depressurization 4%, radio failure 7600 4%, unlawful interference 7500 1%. Difficulty presets: Off / Rare (½) / Realistic (1×) / Training (4×). Max 1 concurrent emergency (2 on Training).

**Common controller flow ("the emergency checklist" — the UI shows it as a tick-list on the strip, each item worth points):**
1. Acknowledge: "{cs}, roger MAYDAY / PAN PAN, {ATC callsign}." 2. Obtain **nature, intentions, souls on board, fuel remaining in minutes/time** (7110.65 10-2-1: "{cs}, say souls on board and fuel remaining in time"; ICAO: "…report persons on board and endurance") — pilot answers e.g. "one four seven souls, fuel one hour two zero, {cs}". 3. Give priority: clear the runway (hold other departures, break off arrivals), assign the longest suitable runway into wind, "runway {rwy} is yours, no delay". 4. Alert ARFF: `ALERT {LOCAL STANDBY|FULL EMERGENCY}` (= FAA Alert 1/2 → 3 on crash). 5. Ambulance for medical. 6. Vectors/holds as requested (some pilots want to hold to burn fuel/run checklists: "request hold for 15 minutes to run checklists"). 7. After landing: keep the runway closed for ARFF check/tow; runway inspection. 8. Log incident.

**ARFF response model:** "local standby" → 2 trucks to the runway standby points, 60–120 s to roll, arrive ≤ 180 s (ICAO Annex 14 §9.2.21/22 · 14 CFR 139.319(h): first vehicle 3 min, all others 4 min) provided the player grants their runway crossings; "full emergency" → 3 trucks + ambulance, runway state `closed_emergency` after the emergency aircraft stops; trucks follow the aircraft down the runway at 80 km/h and stop 50 m abeam. Stand-down: player `ALERT CANCEL` or automatic 10 min after a safe stop with no fire.

| # | Emergency (squawk) | Pilot declaration & requests | Controller must do (in addition to common flow) | Engine behaviour / timings | Post-landing | Scoring (beyond common: +25 each checklist item ≤ 60 s; −100 each missed) |
|---|---|---|---|---|---|---|
| 4.1 | **Engine fire** (7700, MAYDAY) | "MAYDAY MAYDAY MAYDAY, {cs}, engine fire number two, request immediate return, vectors ILS {rwy}." | Full emergency; nearest runway; clear final; no speed/altitude restrictions; stop departures on all runways crossing its path. | Single-engine climb 800–1200 ft/min, max 210 kt; wants landing within 10–15 min; fire extinguished 60 s (70%) else "fire not out" → wants shortest straight-in, even downwind ≤ 10 kt. | Stops on the runway; evacuation 30% (slides; runway closed 20–40 min); else vacates and is met by ARFF; tow 15 min. | Landed within 15 min of declaration +200; ARFF at the runway before touchdown +100; runway not clear at touchdown −1000 (crash risk: 5% collision → −1000 & session ends). |
| 4.2 | **Engine failure** (7700) | "MAYDAY, {cs}, engine failure, request return, {rwy}." Heavies request fuel dump/hold ("request hold 20 min to dump fuel") 50%. | Local standby → full emergency at 5 NM final; hold area away from traffic if dumping (clear 5 NM / 2000 ft below). | Drift-down; single engine performance; fuel dump 15–25 min (4-engine/heavy). | Vacates slowly (30 kt taxi max, single-engine taxi); ARFF inspection 5 min on the taxiway; may request tow (30 min). | As 4.1 (+150 landing). Vectoring other traffic beneath a dumping aircraft −100. |
| 4.3 | **Medical** (PAN PAN, no squawk change) | "PAN PAN PAN PAN PAN PAN, {cs}, medical emergency, passenger unconscious, request priority landing and medical assistance on arrival." | Priority (not necessarily full emergency); dispatch **ambulance to the gate**; assign nearest gate; expedite taxi; coordinate ARFF local standby optional. | Normal performance; requests direct/short vectors; will refuse holds. | Taxi to the gate; ambulance must be at the gate ≤ 8 min after landing. | Landing ≤ 12 min after declaration +100; ambulance at gate on arrival +50; put in a hold −100. |
| 4.4 | **Minimum fuel** (advisory) → **Fuel emergency** (MAYDAY FUEL, 7700) | "{cs}, minimum fuel." (no priority, no further delay tolerable) → later "MAYDAY MAYDAY MAYDAY, {cs}, MAYDAY FUEL, fuel one five minutes, request immediate landing." | Minimum fuel: acknowledge, avoid *any* extra delay ("{cs}, roger, no delay expected, number two"); fuel emergency: full priority, straight-in, ask fuel in minutes. | `fuelMin` countdown; at 0 → engine flame-out (crash, session incident −1000). Declared when fuel < (distance-to-land time + 30 min reserve). | Normal; ARFF local standby stands down after vacate. | Minimum fuel aircraft delayed (hold/vector > 2 min extra) −100; fuel emergency landed with ≥ 5 min remaining +150; flame-out −1000 + session ends. |
| 4.5 | **Depressurization** (7700) | "MAYDAY, {cs}, emergency descent, depressurization, descending flight level one zero zero / ten thousand, request nearest suitable airport." | Clear the airspace below (all traffic within 5 NM off its track), broadcast "all stations, emergency descent in progress, {position}", vectors to the nearest airport (may be yours). | Emergency descent 6000 ft/min to 10,000 ft (or MSA), speed Vmo; then normal approach; oxygen 15 min limit. | Medical at gate (ear injuries). | Separation losses during the descent are not penalised if within 60 s of declaration (grace); after that normal. +100 if traffic below is moved before the descent passes their altitude. |
| 4.6 | **Bird strike** (PAN PAN or MAYDAY if engine damage) | On takeoff: "{cs}, bird strike on rotation, request return, {rwy}." On approach: "{cs}, bird strike, continuing approach." | Runway inspection after (§2.13); traffic pattern priority; ARFF local standby if engine vibration. | 40% engine damage → §4.2 behaviour; else return in 10 min. | Inspect runway before next movement (2–4 min quick inspection or full). | Next movement on the un-inspected runway −50 (5% FOD ingestion → new emergency). |
| 4.7 | **Gear unsafe / gear-up** (PAN PAN → MAYDAY if partial gear) | "PAN PAN, {cs}, unsafe gear indication, request low approach / fly-by for gear check, then hold for 20 minutes to troubleshoot." → then "MAYDAY, {cs}, nose gear not extended, request foam?/emergency landing, {rwy}, 120 souls." | Approve low approach along the runway at 200–300 ft ("cleared low approach runway {rwy}, tower will observe"); report "gear appears down/nose gear appears up"; then full emergency; longest runway; ARFF pre-positioned along the runway; clear the parallel taxiways. | Fly-by 300 ft, 160 kt; hold 15–25 min; landing: partial-gear → stops on the runway, **runway closed 45–120 min** (recovery/tow). | Aircraft remains on the runway; closure; departures re-routed to other runways or the airport closes for arrivals (diversions, not penalised for the player once the runway is closed by emergency). | +100 fly-by conducted; +200 landing with ARFF in place; runway reopened by a proper inspection before use +50. |
| 4.8 | **Smoke / fire in cabin or cockpit** (7700, MAYDAY) | "MAYDAY, {cs}, smoke in the cabin, request immediate landing, nearest runway, may evacuate on the runway." | Full emergency; nearest runway even with tailwind/crosswind; clear all conflicting traffic; expect evacuation. | Wants to land within 8–12 min; may accept any runway; high speed approach 170 kt. | 60% evacuation on the runway (slides; runway closed 30–60 min; ARFF/ambulances at the aircraft; buses). | Landing ≤ 10 min +250; ARFF at the aircraft ≤ 3 min after stop +100; any other aircraft cleared onto that runway during evacuation −1000. |
| 4.9 | **Hydraulic failure** (PAN PAN) | "PAN PAN, {cs}, hydraulic failure, request longest runway, will need to stop on the runway and tow, request no crossing traffic behind." | Assign longest runway; local standby → full emergency at final; plan for runway closure (tow 20–40 min); no LAHSO; warn "expect to stop on the runway". | Vapp +20 kt, no reversers/limited braking → rollout uses 80–100% of runway length; nose-wheel steering lost → cannot vacate. | Aircraft stops; tug/tow (tow entity from the tug pool, 20–40 min); runway closed. | +150 landing on the longest runway; a shorter runway assigned → 25% overrun (−1000). |
| 4.10 | **Unlawful interference** (7500) | Pilot may say only "{cs}, squawk seven five zero zero" or nothing; code appears on the label. Controller **does not** refer to it on frequency except "{cs}, confirm squawking seven five zero zero" (once). | Confirm code; comply with all pilot requests; do not mention the hijack; clear traffic; assign an isolated parking position (`isolationStand`), inform (button) security/police; ARFF full emergency silent. | Aircraft may request unusual routing or refuse instructions; landing after 10–30 min; taxi to the isolated stand; remains there (gate blocked for the session). | Isolated stand; vehicles kept 200 m away; no other aircraft on that apron. | Discussing the hijack on frequency −200; isolated stand used +100; other aircraft taxied within 200 m −100. |
| 4.11 | **Radio failure** (7600) | Silent; code 7600 on the label. Pilot follows: last assigned clearance/heading/altitude; if on vectors → continues to the expected approach; if in a hold → leaves at EFC; enters the pattern and looks for **light-gun** signals (§2.19). | Recognise; clear the runway/final for the expected time; use light gun for landing/taxi clearances; keep other traffic away; inform TWR. | Aircraft flies the expected route (STAR → ILS for the ATIS runway; departures continue the SID and leave); on final, lands only on **steady green**; without a signal it goes around and re-enters the pattern (max 2 times, then lands anyway). Transmit-blind instructions ("{cs}, if you read, …, acknowledge by ident") work 40% (receiver-only failure). | Taxi via light gun (flashing green); guided to a gate by follow-me (§1.12). | Correct light gun sequence +150; another aircraft cleared into its path −500; unnecessary go-around because no signal given −100. |
| 4.12 | **General emergency** (7700, MAYDAY "unspecified") | "MAYDAY, {cs}, {flight control problem / electrical failure / pressurization controller / cargo smoke warning}, request return/priority." | Common flow; treat as full emergency by default. | Random performance limits (e.g. flaps-up landing Vapp +30 kt, or no autopilot → wider turns). | Depends: 30% stops on the runway. | Common scoring. |

**Emergency scoring summary:** any emergency safely concluded (aircraft stopped, ARFF stood down) → **+300 base** × multiplier for checklist completion; player-attributed crash/collision −1000 and the session ends with an incident report (Tower!SE COLLISION −1000). Souls/fuel query not made within 3 min → −100 ("information requirements"). Emergency aircraft handled with no delay to it while other traffic kept safe is the highlight in the session summary.

---

## 5. WEATHER

- **State:** `wind {dir, speed, gust?, variableFrom?, variableTo?}`, `visibility m`, `rvr per runway m`, `ceiling ft (BKN/OVC)`, `cloud layers`, `qnh hPa`, `temperature °C`, `dewpoint`, `precip {none, rain, drizzle, snow, freezing…, intensity}`, `runwayCondition {dry, wet, contaminated} + brakingAction {good, medium, poor}`, `lvp bool`, `windshearAlert bool`, `thunderstormCells []` (optional v2).
- **Change events:** Markov weather scripts per scenario (calm → building crosswind → frontal passage → post-front) with change every 20–60 min sim; each change ≥ threshold regenerates ATIS (§2.12). "Sudden" events: wind shift (runway change prompt), gust front (+15 kt gusts, 10 min), fog rolling in (vis 8000 → 400 m over 15 min → LVP), snow shower (contaminated runway, de-icing), thunderstorm (departures held 10–20 min; arrivals hold; 30% go-arounds due to wind shear).
- **Effects:**
  - Runway choice: §2.9 (headwind/tailwind/crosswind limits; jets crosswind 35 kt, gust-inclusive; light 15 kt).
  - Takeoff/landing performance: wet → rollout distance ×1.3, ROT +10 s; contaminated ×1.6, expedite refused; tailwind adds 10% distance per 5 kt; gusts > 15 kt → 5% go-around per landing; wind shear alert → 25% go-around and pilots may refuse takeoff ("we'll wait 5 minutes").
  - **ILS category / minima:** CAT I: DH 200 ft, RVR ≥ 550 m; CAT II: DH 100 ft, RVR ≥ 300 m; CAT IIIA: RVR ≥ 175 m; CAT IIIB: RVR ≥ 50 m (ICAO Annex 6/ Doc 9365 values). Each runway has `ilsCat`; each aircraft draws a capability (light: CAT I; medium/heavy: 70% CAT IIIA/B, 25% CAT II, 5% CAT I). If RVR/ceiling below the aircraft's minima at 1000 ft on final → go-around (pilot: "going around, below minima") and after two → diversion. **LVP** when RVR < 550 m or ceiling < 200 ft: ILS critical areas protected → departures must hold at the CAT II/III hold line (further back; 30 s more taxi), arrivals spaced ≥ 6 NM (or 1 landing at a time: next arrival not cleared until the previous has vacated *and* reported vacated), no LAHSO, no visual approaches, follow-me for unfamiliar crews, vehicle movements restricted (crossing takes an extra 30 s clearance). Capacity roughly halves.
  - Visibility < 5 km removes visual approaches (§2.17) and "daylight anticipated separation" (§2.8 → strict one-on-runway).
  - QNH: label altitudes/transition level (TL from QNH: TA 5000 → TL 60 (QNH ≥ 1013) / 70 (< 1013) / 75 (< 978)).
  - Temperature: ≤ 3 °C + moisture → de-icing (§1.14); > 30 °C → heavy departures take 10% longer roll (flavour).
- **UI:** weather bar (wind sock animated, RVR per runway, ceiling, QNH, LVP badge); "weather change incoming" toast 2 min before a scripted event (optional "forecast" difficulty setting).
- **Score:** operating outside limits (tailwind > 10 kt, LAHSO in IMC, visual in IMC, clearing below minima) as listed per feature; correct LVP behaviour (never two aircraft between the CAT II/III hold and the runway) — a CAT III hold-line violation during LVP −50.

---

## 6. GAME META

- **Score & skill:** `sessionPoints` ledger (every event above) and `skill` float (Endless ATC model: +0.1·f per successful movement, −0.5 per separation incident, −0.5 per diversion, −0.25 per player-caused go-around, −0.1 per delayed aircraft > 30 min in airspace). `skill` drives spawn rate (arrivals/hr ≈ 6·skill on a single runway; caps per config) and opens runways. Game score = max skill reached; high score persisted (`localStorage`). Streak bonuses (Tower!SE): 1 h w/o incident +500, 2 h +1000, 5 h +3000, 10 h +5000 (sim time).
- **Movements/hour:** rolling 20-min window, arrivals + departures, per runway; shown vs. the airport's declared capacity (e.g. 38/hr single runway mixed mode).
- **Average delay:** per aircraft `delay = actualTime − unimpededTime` for each phase (clearance wait, start/push wait, taxi-out vs. unimpeded taxi time, holding at the runway, airborne holding/track-mile excess, taxi-in, gate wait). Summary shows average and 95th percentile per phase; delay > 15 min per aircraft triggers a "delay" incident (−10). Airline "complaints" flavour text.
- **Incident log:** every scored event with timestamp, callsign(s), position, rule reference (e.g. "7110.65 3-10-3"), points, and a replay bookmark (state snapshot every 10 s kept in a ring buffer of 30 min for the pause-screen track history and post-session replay).
- **Session summary:** duration, movements, points, skill max, incidents by category, delay stats, ARFF response times, emergencies handled, runway utilisation chart, go-arounds (player-caused vs. pilot-caused), diversions, "best moment"/"worst moment" replays, grade (A–F) = f(points/hour, incidents).
- **Difficulty (traffic density):** presets Light (8 mov/h), Medium (18), Heavy (30), Rush (45, requires two runways), Endless (skill-driven); mix sliders: arrival/departure ratio, heavy %, GA/VFR %, emergency rate (§4), weather script, "pilot error" rate (wrong readbacks/wrong turns: 0/2/5%), "realism" toggles: `requireWindOnClearance`, `requireReadbackCheck`, `frequencies`, `anticipatedSeparation`, `arcadeIntercept`.
- **Time acceleration:** 1×, 2×, 4×, 8×, 16× (hold-key 20× fast-forward); physics sub-steps at 1/30 s (existing `FIXED`, `MAX_SUBSTEPS`); TTS shortened/sped up above 4× (readbacks abbreviated to callsign + key value); emergencies and STCA red force 1× automatically (`autoSlowOnAlert`, default on).
- **Pause:** Esc; pause screen shows track history, strips remain readable, no commands accepted; "pause on new pilot request" accessibility option.
- **Sound / TTS:** Web Speech API pilot voices (per-airline accent variation, 6 voice slots), radio bandpass + squelch via WebAudio; controller side TTS optional (reads what the player typed); alert tones: STCA amber/red, MSAW, runway incursion, pilot request chime, ATIS loop; master/radio/alerts volume; "readback only key items at high speed".
- **Session save:** serialise `SimEngine` state (aircraft, vehicles, runways, weather, ATIS letter, timers, RNG seed, score ledger) to IndexedDB/localStorage (`save slots ×3 + autosave every 5 min`); resume restores the pilot-delay queues and vehicle jobs; scenario files (JSON) define airport, weather script, traffic schedule (deterministic seed) for shareable challenges.

---

## 7. PHRASEOLOGY TABLE (command → controller says → pilot reads back)

Parser tokens (extend `commands.ts`): `PUSH [FACE N|S|E|W|hdg] [TAIL twy]`, `START`, `CLR`, `TAXI {rwy|GATE g|PAD p} [AT int] [VIA a b c] [HS rwy|twy]`, `HS {rwy|twy}`, `CROSS rwy`, `HOLD` (position), `CONT`, `GW cs`, `FOLLOW cs|FM`, `EXP`, `LUAW [AT int]`, `CTO [HDG h] [IMM]`, `CANCEL`, `STOP`, `CTL [EXIT twy|L|R] [LAHSO rwy]`, `GA [HDG h] [ALT a]`, `CT DEP|TWR|GND|APP|CTR`, `TFC …`, `VIS rwy`, `TG|LA|SG|OPT`, `LG color`, `RC` (radar contact), `H/L/R hdg`, `A alt [EXP|PD]`, `S spd|RESUME|MINCLEAN`, `D fix [T hdg]`, `HOLD fix [I course] [L|R] [LEG n MIN|NM] [EFC hhmm]`, `I rwy` / `LOC rwy`, `SQ code|IDENT`, `ALERT LOCAL|FULL|CANCEL`, `SAY SOULS|FUEL`, `RWY rwy CLOSE|OPEN`, `INSPECT rwy`, `BIRDS rwy`, `ATIS` (regenerate), `VEH id PROCEED VIA…|CROSS rwy|HOLD|RTB`.

| Command | Controller says | Pilot readback |
|---|---|---|
| IFR clearance | "{cs}, cleared to {dest} via {SID}, climb via SID initial {alt}, departure {freq}, squawk {code}" | "Cleared to {dest} via {SID}, initial {alt}, {freq}, squawk {code}, {cs}" |
| Start-up | "{cs}, start-up approved, expect runway {rwy}, QNH {qnh}" | "Start-up approved, runway {rwy}, QNH {qnh}, {cs}" |
| Pushback | "{cs}, pushback approved, face {dir} / tail to {twy}, expect runway {rwy}" | "Pushback approved, facing {dir}, {cs}" |
| Taxi to runway | "{cs}, taxi to holding point runway {rwy} [at {int}] via {twys}, hold short of runway {x}" | "Holding point runway {rwy} via {twys}, hold short {x}, {cs}" |
| Progressive | "{cs}, turn left next intersection onto Bravo, then hold short Charlie" | "Left on Bravo, hold short Charlie, {cs}" |
| Hold short | "{cs}, hold short of runway {rwy} / taxiway {twy}" | "Hold short runway {rwy}, {cs}" |
| Cross runway | "{cs}, cross runway {rwy} [at {int}], report vacated" | "Cross runway {rwy}, {cs}" … "Runway {rwy} vacated, {cs}" |
| Give way | "{cs}, give way to the {type} from your left, then continue" | "Give way to the {type}, {cs}" |
| Follow | "{cs}, follow the {company/type} ahead to runway {rwy}" / "follow the follow-me to stand {n}" | "Following the {type}, {cs}" |
| Hold position | "{cs}, hold position" | "Holding position, {cs}" |
| Continue | "{cs}, continue taxi [hold short of {x}]" | "Continue taxi, {cs}" |
| Taxi to stand | "{cs}, taxi to stand {n} via {twys} [hold short {x}]" | "Stand {n} via {twys}, {cs}" |
| Expedite | "{cs}, expedite taxi/crossing/vacating, traffic {reason}" | "Expediting, {cs}" |
| De-icing | "{cs}, taxi to de-icing pad {p} via {twys}, hold short of the pad" | "De-icing pad {p} via {twys}, {cs}" |
| LUAW | "{cs}, runway {rwy} [at {int}], line up and wait [, traffic {type} {n}-mile final]" | "Runway {rwy}, line up and wait, {cs}" |
| Conditional | "{cs}, behind the landing {type}, line up and wait runway {rwy}, behind" | "Behind the landing {type}, line up and wait runway {rwy}, behind, {cs}" |
| Takeoff | "{cs}, wind {dir} degrees {spd} knots, runway {rwy}, cleared for takeoff" | "Cleared for takeoff runway {rwy}, {cs}" |
| Takeoff + heading | "{cs}, fly runway heading / turn {L/R} heading {hdg}, runway {rwy}, cleared for takeoff" | "Runway heading / {L/R} heading {hdg}, cleared for takeoff runway {rwy}, {cs}" |
| Immediate | "{cs}, runway {rwy}, cleared for immediate takeoff" | "Cleared for immediate takeoff runway {rwy}, {cs}" / "Unable immediate, {cs}" |
| Cancel takeoff (not rolling) | "{cs}, hold position, cancel takeoff clearance, I say again cancel takeoff, {reason}" | "Holding position, {cs}" |
| Stop (rolling) | "{cs}, stop immediately, {cs} stop immediately, {reason}" | "Stopping, {cs}" |
| Wake hold | "{cs}, hold for wake turbulence, {type} departing, expect {n} minutes" | "Holding, {cs}" |
| Landing | "{cs}, wind {dir} degrees {spd} knots, runway {rwy}, cleared to land [, vacate via {twy}]" | "Cleared to land runway {rwy}, {cs}" |
| Landing + wake | "…cleared to land, caution wake turbulence, {heavy type} departing runway {x}" | "Cleared to land {rwy}, {cs}" |
| LAHSO | "{cs}, runway {rwy} cleared to land, hold short of runway {x} for crossing traffic, {n} feet available" | "Cleared to land {rwy}, hold short of runway {x}, {cs}" / "Unable hold short, {cs}" |
| Continue approach | "{cs}, continue approach, number {n}, expect late landing clearance" | "Continue approach, {cs}" |
| Go around | "{cs}, go around, I say again, go around, {reason}; fly runway heading, climb {alt}" | "Going around, runway heading, climbing {alt}, {cs}" |
| Pilot GA | — (pilot) "{cs}, going around, {reason}" | ATC: "{cs}, roger, fly runway heading, climb {alt}, contact approach {freq}" |
| Exit runway | "{cs}, vacate left/right via {twy} / take next available exit on the left / exit at {twy}" | "Vacating via {twy}, {cs}" |
| Contact ground | "{cs}, when vacated contact ground {freq}" | "Ground {freq} when vacated, {cs}" |
| Contact departure | "{cs}, contact departure {freq}" | "Departure {freq}, {cs}, good day" |
| Contact tower | "{cs}, contact tower {freq}" | "Tower {freq}, {cs}" |
| Traffic info | "{cs}, traffic {clock} o'clock, {n} miles, {dir}bound, {type}, {alt}" | "Looking for traffic / Traffic in sight / Negative contact, {cs}" |
| Visual approach | "{cs}, cleared visual approach runway {rwy} [, follow the {type}]" | "Cleared visual approach runway {rwy}, {cs}" |
| Touch-and-go | "{cs}, runway {rwy}, cleared touch-and-go, make left traffic" | "Cleared touch-and-go runway {rwy}, left traffic, {cs}" |
| Low approach | "{cs}, runway {rwy}, cleared low approach, [at or above {alt}]" | "Cleared low approach runway {rwy}, {cs}" |
| Light gun | (no voice) steady green / flashing green / steady red / flashing red / flashing white | wing rock / light flash (NORDO) |
| Radar contact | "{cs}, {airport} approach, radar contact, descend {alt}, QNH {qnh}, expect ILS runway {rwy}" | "Radar contact, descend {alt}, QNH {qnh}, {cs}" |
| Heading | "{cs}, turn left/right heading {hdg} [, vector for {reason}]" / "fly heading {hdg}" | "Left/right heading {hdg}, {cs}" |
| Relative turn | "{cs}, turn left {n} degrees" | "Left {n} degrees, {cs}" |
| Altitude | "{cs}, climb/descend to {alt} / flight level {FL}" [+ "expedite until passing {alt}" / "at pilot's discretion" / "cross {fix} at {alt}"] | "Climb/descend {alt}, {cs}" |
| Maintain | "{cs}, maintain {alt}" | "Maintain {alt}, {cs}" |
| Speed | "{cs}, reduce/increase speed to {n} knots" / "maintain {n} knots until {n}-mile final" / "resume normal speed" / "no speed restrictions" / "reduce to minimum clean speed" | "Speed {n} knots, {cs}" / "Unable {n}, minimum clean {m}, {cs}" |
| Direct | "{cs}, proceed direct {fix} [, then fly heading {hdg}]" | "Direct {fix}, {cs}" |
| Hold | "{cs}, hold at {fix}, inbound course {crs}, left/right turns, {n}-minute/mile legs, expect further clearance {hhmm}" / "hold at {fix} as published, EFC {hhmm}" | "Hold at {fix}, inbound {crs}, {turns}, {n}-minute legs, EFC {hhmm}, {cs}" |
| Leave hold | "{cs}, leave the hold, fly heading {hdg}, descend {alt}" | "Leaving hold heading {hdg}, descend {alt}, {cs}" |
| ILS (PTAC) | "{cs}, {n} miles from {fix}, turn left/right heading {hdg}, maintain {alt} until established on the localizer, cleared ILS runway {rwy} approach" | "{L/R} heading {hdg}, {alt} until established, cleared ILS runway {rwy}, {cs}" … "{cs}, established ILS {rwy}" |
| LOC only | "{cs}, cleared localizer runway {rwy} approach, maintain {alt}" | "Cleared localizer {rwy}, maintain {alt}, {cs}" |
| Cancel approach | "{cs}, cancel approach clearance, turn left heading {hdg}, climb {alt}, {reason}" | "Cancel approach, left heading {hdg}, climb {alt}, {cs}" |
| Missed approach | "{cs}, fly the published missed approach / fly runway heading, climb {alt}" | "Runway heading, climb {alt}, {cs}" |
| Squawk | "{cs}, squawk {code}" / "squawk ident" | "Squawk {code}, {cs}" / "Ident, {cs}" |
| Handoff center | "{cs}, contact {center} {freq}, good day" | "{freq}, {cs}, good day" |
| SID/STAR | "{cs}, climb via SID" / "cancel SID, fly heading {hdg}" / "resume own navigation direct {fix}" / "descend via STAR" | "Climb via SID, {cs}" … |
| Traffic alert | "{cs}, traffic alert, {position}, turn left heading {hdg} immediately" | "Left heading {hdg}, {cs}" |
| Low altitude alert | "{cs}, low altitude alert, check your altitude immediately, MVA {alt}, climb {alt}" | "Climbing {alt}, {cs}" |
| Diversion | "{cs}, cleared to {altn} via direct {fix}, climb flight level {FL}, contact center {freq}" | "Cleared to {altn} direct {fix}, climb FL{FL}, {freq}, {cs}" |
| Runway change | "{cs}, change of runway, expect ILS runway {new}" / "…taxi to holding point runway {new} via {twys}" | "Runway {new}, {cs}" / "Unable, continuing runway {old}, {cs}" |
| ATIS update | "{cs}, information {L} now current, QNH {qnh}" | "Information {L}, QNH {qnh}, {cs}" |
| Emergency ack | "{cs}, roger MAYDAY / PAN PAN, {ATC unit}, say intentions" | "{cs}, request …" |
| Souls/fuel | "{cs}, say souls on board and fuel remaining in minutes" (ICAO: "persons on board and endurance") | "{n} souls, fuel {n} minutes, {cs}" |
| Priority | "{cs}, roger, you are number one, runway {rwy}, no delay, emergency services alerted, wind…, cleared to land" | "Cleared to land {rwy}, {cs}" |
| Confirm 7500 | "{cs}, confirm squawking seven five zero zero" | "Affirm, {cs}" / silence |
| Blind (7600) | "{cs}, {unit}, if you read, turn left heading {hdg}, acknowledge by ident" | (ident flash) |
| Vehicle | "Fire 1, cross runway {rwy} at {twy}, report vacated" / "Ops 1, enter runway {rwy}, runway closed, report complete" / "Follow-me 1, proceed via {twys} to stand {n}" | "Crossing {rwy}, Fire 1" / "Entering {rwy}, Ops 1" |
| ARFF alert | (intercom) "Local standby / full emergency, runway {rwy}, {type}, {nature}, {souls} souls, {fuel} fuel, ETA {n} minutes" | "Fire station copies, rolling" |

---

## 8. TIMING & CONSTANTS TABLE (source)

| Constant | Value | Source |
|---|---|---|
| Pilot command delay (air / ground) | 3 s / 4–8 s | approach_atc §7.5 (configurable) |
| Pilot request timeout (repeat / escalate) | 60 s / 180 s | Tower!SE "STANDBY" behaviour, game |
| IFR clearance to "request push" | 60–180 s | typical airline ready time, game |
| APU start (if cold) | 45 s | operator SOP (game) |
| Engine start per engine | 40–60 s (≈60 s starter-to-stable idle on modern turbofan) | AeroInsider engine-start guide; engine stabilisation 30 s–2 min |
| Total start: light / turboprop / med jet / heavy / 4-eng | 30–60 / 90–120 / 120–180 / 150–210 / 200–240 s | derived, user requirement 90–240 s |
| Start failure (hot start) | 4 %, +300 s | game |
| Tug travel to stand | 15 kt from pool | game |
| Tug attach / push / disconnect | 20–40 s / 40–90 s / 20–30 s | user requirement; real-world 2–5/1–2/1–2 min compressed |
| Pushback speed / distance | ≤ 3 kt (1.5 m/s) / 40–80 m | GROUND_MOVEMENT_SPEC §6 (3 m/s max) |
| Request taxi after push | 5–20 s | game |
| Taxi speed straight / turn / apron / high-speed exit | 15–20 kt / 8–12 kt / 10 kt / 25–30 kt | phase1_simulation_spec §2, GROUND_MOVEMENT_SPEC §3.2 |
| Taxi accel / brake / emergency brake | 1.2 / 2.5 / 3.0 m/s² | GROUND_MOVEMENT_SPEC §3.2 |
| Hold-line decel profile | 25 m→3 m/s, 15 m→1 m/s, stop <10 m | GROUND_MOVEMENT_SPEC §7.3 |
| Ground separation same-dir / opposite / behind H·S / push zone / gate | 60 / 100 / 100 / 30 / 20 m | GROUND_MOVEMENT_SPEC §5.1 |
| Vehicle safety radius | 8 m | game |
| Runway crossing duration | 20–45 s | 45–60 m width at 10–15 kt |
| Crossing lock: no arrival inside | 2 NM (3 NM night/IMC) | 7110.65 3-1-3 "runway clear", game tolerance |
| Line-up from hold line (M / H / S) | 25–45 / 35–60 / 45–70 s | game (observed ops) |
| LUAW patience: pilot query / forced GA of arrival | 90 s / 180 s | game |
| Spool-up from lineup | 8–15 s | game |
| Takeoff roll (jets) | 30–45 s, 1500–2500 m, a = 1.8–2.3 m/s² | derived from Vr 135–150 kt |
| Vr per type | AIRCRAFT_DB `takeoffRotationSpeed` | aircraftDB.ts |
| Initial climb / turn not below | 2500–3500 ft/min to 1500 ft AGL / 400 ft AGL | ICAO PANS-OPS / airline SOP |
| Departure handoff auto | 1000 ft AGL | game (Tower!SE −100 if never sent) |
| Same-runway departure separation | airborne + 6000 ft (Cat III) / 4500 (Cat II) / 3000 (Cat I) or turned 45° | 7110.65 3-9-6 |
| Arrival threshold vs preceding arrival | vacated (Cat III) / ≥ 3000–4500 ft down runway daytime (Cat I/II) | 7110.65 3-10-3 |
| Wake departure timers full length | SUPER→H 2 min (FAA 3), SUPER→M/L 3, H→M/L 2, M→L 2 | ICAO Doc 4444 §5.8.3 (Amdt 9); FAA 7110.65 3-9-6 |
| Wake intersection departure | +1 min (3 / 4 / 3 / 3 min) | ICAO Doc 4444 §5.8.3; FAA 3-9-7 (3 min small behind B757/large at intersection) |
| Wake arrival time minima (non-radar) | M←H 2, L←H 3, L←M 3, H←J 2, M←J 3, L←J 4 min | ICAO Doc 4444 §5.8.3 |
| Wake distance on final | J→H 5 [FAA 6], J→M 7, J→L 8, H→H 4, H→M 5, H→L 6, M→L 5, others 3 NM | ICAO Doc 4444 §8.7.3.4; FAA 7110.65 5-5-4 |
| B757 special | treated as HEAVY leader for M/L followers | FAA 7110.65 |
| Weight class thresholds | L ≤ 7 t; M 7–136 t; H ≥ 136 t; J = A380 (aircraftDB `S`) | ICAO Doc 4444 / Doc 8643 |
| Radar separation | 3 NM & 1000 ft (2.5 NM inside 10 NM final, dry runway) | ICAO Doc 4444 §8.7.3 / FAA 5-5-4 |
| Reduced-minima cases | both on different LOCs; < 1600 ft; diverging deps ≥ 15°; 60 s GA grace | approach_atc §10.2 |
| ILS intercept angle | ≤ 30° (heli 45°; arcade 45–60°) | 7110.65 5-9-1 |
| Intercept point | ≥ 2 NM outside approach gate (≈ 3 NM outside FAF) | 7110.65 5-9-1 |
| GS intercept | at/below GS, ≥ min GS intercept alt; 300 ft/NM rule | 7110.65 5-9-2 |
| LOC / GS range | 25 NM / 10–12 NM | approach_atc §17 |
| Auto speed schedule | 220 kt <15 NM; 200 at LOC; 160 at 6 NM; Vapp at 4 NM | approach_atc §7.3 |
| Speed limits | 250 kt < 10,000 ft; 200 kt in pattern | 14 CFR 91.117 |
| Holding speeds | ≤ 6000 ft 200 kt; 6001–14,000 230 kt; > 14,000 265 kt | AIM 5-3-8 |
| Holding legs | 1 min ≤ 14,000 ft, 1.5 min above; right turns standard | ICAO Doc 8168 / AIM 5-3-8 |
| Turn rate | bank 25° → ≈3°/s @180 kt, 2°/s @250 kt | approach_atc §7.1 |
| Climb / descent rates | AIRCRAFT_DB (M 2500/1500, H 3000/2000, L 700/500 ft/min); expedite ×1.4 | aircraftDB.ts |
| Emergency descent | 6000 ft/min to 10,000 ft | airline QRH |
| Go-around: climb / grace / default alt | 2000–3000 ft/min / 60 s / 3000 ft (airport) | approach_atc §8; game |
| Pilot GA triggers | no clearance by 300 ft; occupied at 1 NM; unstable 1000 ft; tailwind >10 kt 50 % | airline stabilised-approach SOP; game |
| Landing: flare / touchdown zone / ROT (L/M/H) | 50 ft / 300–450 m / 30–40, 45–60, 55–75 s | ICAO ROT studies (typ. 45–60 s) |
| Rollout decel dry / wet / contaminated | 1.5–2.5 / 1.0–1.5 / 0.7 m/s² | game |
| Tower check-in unanswered | 60 s repeat, −25 at 4 NM | game |
| Tower handoff from APP | 8–12 NM (auto 10 NM) | game |
| Visual approach minima | ceiling ≥ 500 ft above MVA (game 1500 ft), vis ≥ 3 SM | 7110.65 7-4-3 |
| LAHSO minima | ceiling ≥ 1000 ft, vis ≥ 3 SM, dry, no tailwind, ALD check, mandatory readback | AIM 4-3-11 |
| Runway selection | tailwind ≤ 5 preferred, ≤ 10 allowed; crosswind 35 kt jets / 15 kt light | ICAO Annex 14 / operator limits |
| Runway change transition | 8 min grace for arrivals inside 10 NM; ATIS letter advance | game |
| ATIS regen triggers | hourly; wind Δ ≥ 30°/5 kt; QNH Δ ≥ 1 hPa; vis/RVR category; runway/closure/LVP/de-ice/birds | ICAO Annex 11 §4.3.7 (ATIS) practice |
| Transition level from QNH | TA 5000: TL 60 ≥1013 / 70 <1013 / 75 <978 | ICAO Doc 8168 practice |
| ILS minima | CAT I DH 200 ft RVR 550 m; CAT II DH 100 ft RVR 300 m; CAT IIIA RVR 175 m; CAT IIIB RVR 50 m | ICAO Annex 6 / Doc 9365 |
| LVP trigger | RVR < 550 m or ceiling < 200 ft | ICAO Doc 9365 / EASA practice |
| LVP spacing | one arrival at a time (report vacated) / ≥ 6 NM | LVP local procedures (game) |
| ARFF response | first vehicle ≤ 3 min to any point of runway (ICAO) / midpoint of farthest runway (FAA); all vehicles ≤ 4 min | ICAO Annex 14 §9.2.21–9.2.23; 14 CFR 139.319(h) |
| ARFF roll-out delay | 60–120 s | game |
| ARFF speeds (taxiway / runway / apron) | 80 / 100 / 30 km/h | FAA AC 150/5210 vehicle performance (game) |
| Alert levels | Local standby = Alert 1–2; Full emergency = Alert 2–3 | FAA AC 150/5210-7 |
| Runway closure after emergency | evacuation 20–60 min; gear collapse 45–120 min; stop-on-runway tow 15–40 min | game |
| Post-emergency inspection | quick 2–4 min / full 3–6 min | game |
| Follow-me / vehicle speeds | taxiway 30–50 km/h, runway ≤ 60 km/h, apron 25 km/h; leading ≤ 15 kt | ICAO 30 km/h taxiway recommendation; IVAO follow-me policy |
| Runway inspection frequency | every 4 h sim (twice daily real) + after events | ICAO Annex 14 / PANS-Aerodromes |
| Bird strike probability | 0.3 %/movement, ×5 when activity reported | game |
| De-icing treatment | Type I 4–7 min (M) / 6–10 (H,S); + Type IV +3 min | airline practice |
| Holdover times (Type IV upper/lower) | frost 45 / light snow 20–45 / moderate snow 10–20 / freezing drizzle 15–35 / light freezing rain 10–25 min; Type I 3–15 min; none for heavy snow / mod-heavy freezing rain | FAA Holdover Time Guidelines 2025-26 |
| STCA look-ahead / red | 120 s (TMA 60–90) / 30 s | EUROCONTROL STCA guidelines (up to 2 min) |
| MSAW look-ahead | 60 s | EUROCONTROL / FAA MSAW |
| Emergency rate | 1 per ~120 movements (Realistic) | game |
| Fuel at spawn / burn | 45–120 min / 40 kg·min⁻¹ (M) | game |
| Diversion triggers | hold > 25 min; fuel; 2 GAs; runway closed > 20 min; wx < minima 15 min | game |
| Delay threshold penalties | > 15 min/aircraft −10; > 30 min airborne skill −0.1 | approach_atc §12; game |
| Points | takeoff +10, landing +10 (+10 parked), streaks +500/1000/3000/5000; incursion −500, separation −500, collision −1000, ground collision −500, no departure handoff −100, unhandled GA −500 | feelThere Tower!SE manual (profile scoring) |
| Skill | +0.1·f(skill)/success; −0.5 separation; −0.5 diversion; −0.25 player GA | approach_atc §12 |
| Time acceleration | 1/2/4/8/16×, hold 20×; auto 1× on red alert | approach_atc §3; game |
| Sim step | 1/30 s fixed, ≤ 6 substeps | engine.ts `FIXED`, `MAX_SUBSTEPS` |
| Autosave | every 5 min; 3 slots; 30-min replay ring buffer @ 10 s | game |

---

## 9. Definition of Done (acceptance)

1. Every feature in §1–§5 is issuable via command line, context menu and voice, produces the listed pilot readback via TTS, and is executed by `SimEngine` with the listed timings (unit tests per constant in §8).
2. All scoring events in the tables fire exactly once per incident with the listed points and appear in the incident log with a rule reference and replay bookmark.
3. A 60-minute "Heavy" session at the reference airport runs at 60 fps with ≥ 25 aircraft + 15 vehicles; ARFF reaches the runway within 180 s in a scripted full-emergency test when crossings are granted promptly.
4. The runway state machine never allows two aircraft/vehicles in `occupied_*` states simultaneously without generating an incursion incident; forced go-arounds occur at the specified distances.
5. Wake timers, runway separation, ILS intercept rules, STCA/MSAW, LVP and LAHSO behave per §8 values, with the arcade toggles documented.
6. All 12 emergency types can be triggered from a debug menu and complete end-to-end (declaration → ARFF → landing → runway closure/inspection → reopen) with the checklist UI scoring each step.
7. Weather scripts regenerate ATIS letters correctly and the ATIS text matches the ICAO element order in §2.12.
8. Session summary, save/resume and difficulty presets work; high score persists.

---
# CRITIC ADDENDUM
# ADDENDUM — SkyControl Feature Spec: Corrections, Contradictions, Missing Content

Numbering: **A** = wrong (must be corrected), **B** = internal contradictions (resolution given), **C** = missing ground/delivery commands, **D** = missing tower commands & edge cases, **E** = missing approach commands & edge cases, **F** = missing emergencies/abnormals, **G** = missing systems, **H** = missing timing constants, **I** = additions to Definition of Done. Each item is written as spec text, ready to paste.

---

## A. WRONG — corrections

### A1. FAA taxi / runway-crossing rule (§1.4, §1.6) is misstated
The spec says "taxi clearance never includes crossing a runway (7110.65 3-7-2)". Wrong. 7110.65 3-7-2 requires an **explicit** crossing instruction for every runway crossed; that instruction **may be part of the taxi clearance** ("runway two seven left, taxi via Alpha, **cross runway two two at Alpha**"). Restriction: one runway crossing per clearance, **except** when the centrelines of two runways are < 1,000 ft apart (then both may be crossed on one instruction). ICAO (Doc 4444 §7.x, Doc 9432): a taxi clearance to a holding point implicitly includes hold short of every runway on the route; crossing is a separate instruction unless explicitly included.

Replace with:
- **Params (1.4):** `cross: rwy[]` (FAA: max 1 unless `centrelineSpacing < 1000 ft`), `holdShort: rwy|twy`. If a route crosses a runway with neither `cross` nor `holdShort`, engine inserts implicit hold-short (safety net) and scores **−25 "incomplete taxi instruction"** (FAA airports only; ICAO airports: implicit hold-short is correct, no penalty).
- **ATC (FAA):** "{cs}, runway two seven left, taxi via Alpha, cross runway two two at Alpha." · with two close parallels: "…cross runways two two left and two two right…" · **Pilot:** "Runway two seven left via Alpha, cross runway two two at Alpha, {cs}."
- **Engine:** each `cross` entry needs the TWR crossing token (§1.11) **at the moment the aircraft reaches that hold line**, not at issue time; if the token is not valid then, the aircraft stops (hold_short) and the pilot calls "{cs}, holding short of two two, confirm cross?" (no penalty — real-world ambiguity is resolved by the pilot stopping).

### A2. B747-8 is HEAVY, not SUPER (§2.7, `aircraftDB.ts` B748 `weightClass:'S'`)
ICAO Doc 8643: only A388 (and A225/ROC Stratolaunch) are **J/SUPER**. B748 is **H**. FAA CWT: A388 = A, B748 = B (upper heavy).
- Change `B748.weightClass` → `'H'`, `wakeTurbulenceRequiredCategory` → `'heavy'`.
- Add to DB (needed by §2.7/§3.9): `B744` (H, 195 t, Vr 150, Vapp 150), `B752`/`B753` (M, `b757: true`), `A346` (H), `MD11` (H), `B763` (H), `DH8D`, `AT76` (M turboprops, start 90–120 s), `CRJ9`/`E175` (M regional).
- Add DB fields the spec relies on but that do not exist: `spokenType` ("Boeing seven three seven"), `engines: 2|4`, `apu: bool`, `runwaySepCategory: 'I'|'II'|'III'` (A4), `tora_m` (required takeoff run, C2), `ld_m` (dry landing distance, D6), `ilsCapability: 'CAT1'|'CAT2'|'CAT3A'|'CAT3B'`, `b757: bool`, `lahsoEligible: bool`, `minTurnaroundMin`.

### A3. FAA wake references are legacy
7110.65 5-5-4 (arrivals) and 3-9-6/3-9-7 (departures) now use **Consolidated Wake Turbulence (CWT) categories A–I**, not SUPER/HEAVY/B757/LARGE/SMALL. The bracketed "FAA" values in §2.7/§3.9 are pre-2019. Acceptable for v1 as an **approximation** but must be labelled so; reserve `wakeScheme: 'ICAO4' | 'FAA_LEGACY' | 'FAA_CWT'` in `AirportConfig`, ship `ICAO4` + `FAA_LEGACY`, and load a data-driven matrix (`wake/{scheme}.json` with `departureTimeS[leader][follower][fullLength|intersection|crossing]` and `finalNM[leader][follower]`) so CWT can be added without code changes.

### A4. Same-runway separation (§2.5, §2.8) conflates two concepts and has wrong values
"Anticipated separation" (7110.65 3-10-3 / 3-9-6 notes) = issuing the clearance **before** the runway is clear when it is reasonable to expect it will be clear at the threshold/roll — it never reduces the separation itself. The reduced-distance minima are a separate rule set. Correct rule set (replace §2.8 rules 2–4):

| Pair | FAA 7110.65 (day only for distance options; night = runway clear) | ICAO Doc 4444 §7.11 RRSM (day, vis ≥ 5 km, tailwind ≤ 5 kt, dry, local approval) |
|---|---|---|
| Departure behind departure (3-9-6) | preceding **airborne and** (crossed runway end **or** turned ≥ 45° to avert conflict), **or** airborne and ≥ 3,000 ft (Cat I follower behind Cat I/II) / 4,500 ft (Cat II behind Cat I/II) / **6,000 ft (either is Cat III)** ahead | preceding airborne and past a point ≥ 2,400 m (Cat 3 = jets) / 1,500 m (Cat 2) / 600 m (Cat 1) from threshold |
| Arrival behind arrival (3-10-3) | preceding has landed **and exited**, **or** (sunrise–sunset, distance determinable) preceding ≥ 3,000 ft (Cat I behind Cat I/II) / 4,500 ft (Cat II behind Cat I/II) / **6,000 ft (either Cat III)** from threshold **and in motion, expected to exit** | preceding landed, past ≥ 2,400 m / 1,500 m / 600 m, in motion, will vacate without backtrack |
| Arrival behind departure (3-10-3) | departure airborne and crossed runway end / turned, **or** airborne and 3,000/4,500/**6,000 ft** from threshold | departure airborne and past 2,400 m / 1,500 m / 600 m |
| **Departure behind arrival** (3-9-6 a) | **preceding landing aircraft has taxied off the runway — no distance alternative** | not covered by RRSM → runway vacated |

- **Category definitions (FAA 3-9-6 note):** Cat I = small single-engine propeller ≤ 12,500 lb + all helicopters; Cat II = small twin-engine propeller ≤ 12,500 lb; Cat III = all others. Store as `runwaySepCategory` per type; ICAO Cat 1/2/3 mapped from MTOW (≤ 2 t / 2–7 t / > 7 t).
- Spec §2.8 rule 3 ("departure roll may start when the arrival is ≥ 6,000 ft down the runway") is **not a real rule**. Keep it only behind `arcadeRunwaySep: true` (default **off**), labelled "arcade".
- `AirportConfig.runwaySepScheme: 'FAA' | 'ICAO_RRSM' | 'strict'`; "strict" = runway clear for every pair (LVP, night, vis < 5 km, wet automatically force strict).

### A5. ARFF alert levels (§1.13, §8) are wrong
FAA AC 150/5210-7: **Alert I** = aircraft with minor difficulty (local standby), **Alert II** = major difficulty (full emergency), **Alert III** = accident occurred / imminent. Map: `ALERT LOCAL` = Alert I, `ALERT FULL` = Alert II, engine auto-escalates to Alert III on crash/evacuation. Remove "Alert 1–2 / 2–3".

### A6. Parallel-approach spacing (§3.7) numbers are wrong
"≥ 3,400 ft (or ≥ 4,300 ft without monitor)" mixes ICAO and FAA. Correct:

| Centreline spacing | Operation |
|---|---|
| < 760 m (2,500 ft) | same runway for wake and runway separation (§2.7) |
| 760–915 m | treated as one runway for runway/wake sep; radar 3 NM in trail across both |
| 915–1,035 m (ICAO) / 2,500–4,300 ft (FAA) | **dependent** parallel approaches: 3 NM in trail on the same localizer, **2 NM diagonal (ICAO 6.7.3.3)** / **1.5 NM diagonal (FAA 5-9-8)** between aircraft on adjacent localizers |
| ≥ 1,035 m (ICAO) / ≥ 4,300 ft (FAA) **with** NTZ monitor | **independent**: no spacing required once both established; NTZ 610 m wide; deviation into NTZ → break-out instruction ("{cs}, traffic alert, turn left immediately heading …, climb …") |
| ≥ 9,000 ft (FAA) | independent without monitor |

`AirportConfig.parallelPairs: {a, b, spacing_m, mode: 'dependent'|'independent'|'single'}`.

### A7. Squawk exclusions (§1.1) incomplete
Exclude also **0000, 1000 (Mode S conspicuity), 1202 (glider US), 7000 (VFR Europe), 7001 (military low-level UK), 7400 (UAS lost link), 7777 (military interceptor)** and any code ending in `00` at FAA airports if `discreteOnly`. Codes are octal (digits 0–7 only) — the parser must reject "4289".

### A8. Rejected-takeoff bands (§2.4) miss 80 kt–V1
Replace: **< 80 kt** → pilot rejects for any ATC "stop" (decel 3.0 m/s²). **80 kt–V1** → "high-speed regime": pilot rejects **only** if the reason transmitted is a runway obstruction/incursion (`STOP … TRAFFIC ON RUNWAY`) or the pilot sees it (obstacle within 1,500 m ahead); otherwise "unable, continuing". High-speed reject: decel 3.5 m/s², **brake cooling 30 min** (Boeing max brake energy chart; overheat → 10% brake fire → F2), mandatory runway inspection. **≥ V1** → always continues. V1 per type = `AIRCRAFT_DB.v1` (add field; default `0.92·Vr` jets, `0.85·Vr` props) — not `0.9·Vr` hard-coded.

### A9. `PendingCmd` (§0 "every command enters pendingCmds")
`types.ts` `PendingCmd.kind` is `'heading'|'altitude'|'speed'` only; the parser in `commands.ts` calls `cmdPushback/cmdTakeoff/...` **immediately**. To implement the 4–8 s ground delay the engine needs `PendingCmd = { kind: CommandKind; args; applyAt; readbackText; cancellable: boolean }` for **all** verbs, with `DISREGARD` (C11) able to remove the newest pending item before `applyAt`.

### A10. `FlightPhase` (§0)
`types.ts` lacks `startup`, `pushback_complete`, `deice`, `holding`, `goaround`, `stopped_on_runway`, `towed`, `evacuating`. Add them, plus `emergency?: EmergencyState` and `isVehicle`. `'arrived'` in the current enum should become `'parked'` to match the spec.

### A11. Wake-timer reference point (§2.7) is under-specified
"Timer starts at leader's rotation" is ICAO practice (between *take-offs*). FAA texts for several cases count from the leader's **start of takeoff roll** (e.g., 3-9-7 intersection departures) and for arrival-crossing cases from the leader **passing the intersection / touchdown**. Define `wakeTimerRef: 'airborne' | 'startRoll'` per scheme (`ICAO4 → airborne`, `FAA_LEGACY → startRoll`) and for "departure behind arrival, crossing paths": ref = leader crossing the departure's rotation point (engine: leader touchdown position + 0 s).

### A12. §2.9 runway-choice formula is malformed
`headwind − 2·|crosswind|·0.1 − …` — replace: `score = headwind − 0.25·|crosswind| − (tailwind > 5 ? 40 : 0) − (tailwind > 10 ? 1e6 : 0) + noisePref (0–15) + calmPref (if wind < 5 kt: +50 for preferredCalmConfig) + hysteresis (+20 for current config so the prompt doesn't flap)`. Re-evaluate on every ATIS wind trigger, not only every 10 min.

### A13. Runway state (§2) cannot be a single enum
Real runways carry several occupants at once (two vehicles crossing at different intersections while an aircraft lines up is legal in FAA when the crossings are ahead of the departure? — no, but two simultaneous crossings at different points are). Replace with `runway.occupants: Occupant[] = { id, kind: lineup|takeoff|landing|rollout|crossing|vehicle|stopped|inspection, from_m, to_m (position along runway), since }` plus `runway.closure?: { reason, until? }`. Derived `state` for UI. Rules operate on **segment overlap + kind** (e.g., LUAW forbidden while any `crossing` occupant exists; two `crossing` occupants allowed if ≥ 300 m apart; `stopped` anywhere blocks landing/takeoff).

### A14. LUAW/arrival-distance rule (§2.1) is inverted in one clause
"> 180 s with an arrival inside 3 NM → auto-go-around" mixes two timers. Correct: an aircraft in `lineup` blocks the runway; the arrival's forced go-around is governed only by the **unified forced-GA table (B1)**, not by how long the LUAW aircraft has been there. The 180 s value becomes: pilot on the runway > 180 s with **no** arrival → "{cs}, we're going to need to vacate for fuel/brakes" and taxis off via the next exit (removed from sequence, −10 "wasted line-up").

---

## B. CONTRADICTIONS — resolutions

### B1. Forced go-around trigger point (four different values)
§1.6: 0.5 NM/200 ft · §2.5: 1 NM/300 ft · §1.13: 1 NM · §2.1: 180 s. Single table (`FORCED_GA`):

| Cause | Arrival triggers pilot GA when | Player attribution |
|---|---|---|
| No landing clearance | 1.0 NM **or** 300 ft AGL, whichever first (pilot query at 4 NM) | −500 unhandled |
| Runway occupied: aircraft on runway (lineup/takeoff/rollout/stopped) not expected to clear | 1.0 NM | −500 incursion (player) |
| Runway occupied: crossing aircraft/vehicle still on runway | 0.7 NM (crossings are quick; gives the player a last chance) | −500 |
| Preceding arrival still on runway and rollout prediction says it will **not** vacate before threshold | 0.5 NM (pilot judges) | −500 if the player had the info ≥ 20 s (ladder was red) else −100 "compression" |
| Vehicle/inspection on runway | 1.0 NM | −500 |
| Runway `closed` | 3 NM (pilot knows from ATIS/NOTAM) | −50 (clearance refused anyway) |
| Windshear alert on that runway | at alert time if inside 3 NM (pilot GA 25%) | none |
| Below minima (RVR/ceiling) | 1,000 ft AGL | none |
| Unstable | 1,000 ft AGL / 500 ft VMC | none |
The UI "final ladder" turns amber when a forced-GA condition is *predicted* (rollout ETA to exit > arrival ETA to threshold − 5 s) and red when it is *certain*, so the player can act first.

### B2. Points and skill duplicates
- Ground collision: §1.3 −200 vs §1.4/§8 −500 → **−500** everywhere; "push zone violated without contact" is the −20 taxi conflict.
- Player-caused go-around skill: §2.6 −0.5 vs §6/§8 −0.25 → **−0.25** (§6 is authoritative); separation loss −0.5.
- Landing scored twice (+10 vacate, +10 parked) — keep, but the summary shows "+20/arrival, +10/departure" so movement counts are not misread.
- Rule: **one incident per (code, primary callsign, secondary callsign) per 60 s** (`dedupeWindowS`); a forced GA never scores both "incursion" and "unhandled GA" — precedence: `collision > incursion > unhandled_GA > separation > wake > procedure`. Incident codes in G7.

### B3. Initial altitude vs "climb via SID"
§1.1 says "climb via SID, initial altitude five thousand"; §3.15 says departures climb via SID to FL130. Resolution: `sid.topAlt` (published, e.g., FL130 or 6,000) and `plan.initialAlt` (clearance). "Climb via SID" alone → climb to `sid.topAlt` honouring constraints. "Climb via SID **except maintain 5,000**" → stop at 5,000 (FAA phraseology; ICAO: "climb via SID to 5,000 ft"). Departure check-in with APP is then "climb via SID" (release to top) or an explicit altitude. Default airport config: `initialAlt = 5000`, `sid.topAlt = FL130`, boundary exit rule "≥ FL90 or assigned".

### B4. Refuse vs execute policy (inconsistent across §1.6, §1.13, §2.13, §2.2)
Single policy, `CommandOutcome = refused | queried | executed_scored | executed`:
- **Refused (engine, no pilot delay, no score):** target not on your frequency (multi-position mode only), unknown taxiway/fix/runway, aircraft not at the referenced runway, taxi route that does not connect, LUAW/takeoff/cross when another aircraft is already `lineup` on that runway (7110.65 3-9-4 forbids), commands that the phase makes meaningless (land a parked aircraft).
- **Queried (pilot asks, no execution, no score):** clearance to the wrong runway ("confirm runway two two?"), "already past Delta", conditional clearance whose reference aircraft is ambiguous, HOT expired.
- **Executed & scored:** every safety violation: takeoff/landing with runway occupied by anything, wake early, crossing under an arrival, closed-runway clearance **(executed — pilot does not know it is closed unless ATIS said so; if ATIS says so pilot queries 70%)**, LAHSO in IMC, visual in IMC, below MVA. This is the core "trap" mechanic and must be uniform. Remove "engine refuses landing on closed runway" from §2.13 (replace with pilot query 70% / executed 30%).

### B5. Crossing-lock and "vehicle on runway" rules
§1.6 refuses the crossing when unsafe (auto-TWR) but §1.13 executes a landing clearance over a vehicle. Both are right for different positions: **GND-side requests are gated by TWR** (auto-TWR refuses); **TWR-side clearances are never gated** (executed & scored). When the player is TWR and GND is auto, the auto-GND request badge waits for the player; if the player crosses under an arrival inside the lock, executed & scored.

### B6. Frequency refusal vs single player
§2.15 "commands issued on the wrong position are refused" conflicts with §0 "player holds all positions". Rule: `frequencies: true` (realism toggle) → refusal applies **only** to positions marked auto; the player's own set of positions is one combined frequency. `frequencies: false` → no refusal, aircraft still display their current position for the strip columns.

---

## C. MISSING — Ground / Delivery commands

### C1. Ground → Tower handoff and "ready for departure" (missing from §1.4/§2.1 — the departure flow currently has no transition)
- **When:** aircraft within 200 m of / at the hold line, or number ≤ 3 in the queue.
- **ATC (GND):** "{cs}, holding point runway {rwy}, contact tower {freq}." · FAA: "{cs}, monitor tower one one eight decimal seven" (`MONITOR` = pilot switches but does not call). **Pilot:** "Tower {freq}, {cs}." Then on TWR: "Tower, {cs}, holding point {A1} runway {rwy}, **ready for departure**" (ICAO) / "…holding short runway two seven left, ready" (FAA). With `MONITOR` the pilot stays silent until TWR calls.
- **Engine:** `freq=TWR` after 5–15 s (H1); `readyForDeparture=true` when: hold_short reached **and** engines stable ≥ 60 s **and** HOT valid **and** ≥ 45 s since stop (§2.3). Pilot may report "ready, request intersection {C}" (C2) or "not ready, request 3 minutes for checklist" (5%).
- **Auto-GND** hands off when the aircraft is ≤ 2 in the queue. Forgotten handoff: pilot calls GND after 120 s at the hold line "{cs}, holding short {rwy}, are we cleared to tower?" (−10 "late handoff" at 180 s).
- **Parser:** `CT TWR|MON TWR`, `REPORT READY`.

### C2. Intersection departure request & TORA check
- Pilot (20% of M jets, 60% turboprops, 90% GA; never H/S): "{cs}, request intersection departure {C}." ATC: "{cs}, approved, taxi to holding point {C} runway {rwy}" / "unable, full length only".
- Controller-initiated: "{cs}, can you accept intersection {C}, {n} metres/feet available?" Pilot: "affirm/negative". Engine: accept iff `tora_m(intersection) ≥ AIRCRAFT_DB.tora_m × (wet ? 1.15 : 1) × (tailwind > 0 ? 1 + 0.1·tw/5 : 1) × (OAT > 30 ? 1.05 : 1)`. Default `tora_m`: L 500 · turboprop 1,200 · M 2,000 · H 2,800 · S 3,200 m.
- FAA: distance-remaining must be stated on pilot request ("{n} feet available from {C}"). Score: takeoff clearance from an intersection with insufficient TORA (pilot refuses 90%; 10% executes → 30% overrun −1000).

### C3. Backtrack / taxi via runway
- **ATC:** "{cs}, backtrack runway {rwy}, line up and wait" / "…backtrack and vacate via {B}" / "taxi via runway {33} (inactive), hold short of runway {27}". **Pilot:** "Backtrack runway {rwy}, line up, {cs}."
- **Engine:** aircraft enters the runway at the intersection, taxis along the centreline at ≤ 25 kt, turns in the turn pad (45–90 s for M, 90–150 s for H/S; `turnPad: bool` per runway end else "unable, no turn pad"). Runway occupant `kind=backtrack` blocks all landings; crossing lock as a landing would. Inactive runway used as taxiway → runway `closed_taxi` and crossing rules apply to intersecting runways.

### C4. Conditional clearances (extend §1.3/§2.1 to crossing and taxi)
- **ATC:** "{cs}, behind the landing Airbus 320, cross runway {rwy}, behind." · "…behind the departing 737, cross runway…" (allowed only after the departure has **passed** the crossing point and is airborne; `crossBehindDeparture` default on for FAA, off for ICAO strict).
- **Rules (ICAO 12.3.4.x):** only one condition; the referenced traffic must be visible to the pilot and be the **next** movement on that runway; readback must repeat the condition; if another movement intervenes, the clearance is void and the pilot stops ("{cs}, holding short, the 320 has landed, confirm we cross behind the second one?").
- **Score:** conditional clearance referencing the wrong/ambiguous traffic (two similar types on final) −25 "ambiguous conditional" and the pilot queries.

### C5. Vacating between parallels / "hold short of runway 27R"
Default arrival behaviour after vacating when a parallel/intersecting runway lies between the exit and the apron: aircraft automatically stops at that hold line (`hold_short`). Clearance must include it: "{cs}, vacate right via {D}, **hold short of runway two seven right**, contact ground {freq}." Missing hold-short → aircraft still stops (safety net) but **−25 "incomplete exit instruction"**; missing "contact ground" → pilot asks after 60 s.

### C6. Mid-taxi reroute, head-on deadlock, "turn around"
- `TAXI … VIA …` on an aircraft already taxiing **re-plans from the current node** (the engine currently only accepts a route at start). If the aircraft cannot turn onto the new first taxiway (already past it) → pilot "unable, already past Bravo".
- **Deadlock detection:** graph of "waiting-for" edges among ground entities; a cycle or a head-on pair (opposing, < 100 m, both stopped ≥ 15 s) raises a **DEADLOCK** strip alert. Aircraft cannot reverse. Player must reroute one into a side taxiway / run-up bay / bypass ("{cs}, turn right onto Charlie, hold position, give way to the opposite 737"). If unresolved 120 s → −50 "ground deadlock" per pair, then auto-GND resolves it (the lighter aircraft is rerouted, +2 min delay).
- **Score:** −20 head-on stop (existing) is kept; deadlock replaces it after 120 s.

### C7. Departure queue reordering at the hold
- Multiple holding points per runway end (`runwayEntries[]: {twy, tora_m, capacityAircraft}`); each entry keeps a FIFO. Commands: "{cs2}, line up and wait runway {rwy} at {B}, ahead of the 737 at {A}" → `LUAW AT B` naturally leapfrogs; "{cs}, hold position, number two, the A320 at Charlie goes first" (`SEQ cs n` sets `departureSequence`). Auto-TWR sequences by: emergency > CTOT window closing > wake-optimal order (M-M-H batches) > FIFO.
- Score: departure delayed > 10 min at the hold while others launch −10 "sequence fairness" (once per aircraft).

### C8. Return to stand / departure abort on the ground
- Pilot request (2% of departures; triggered also by HOT expiry, brake check, "passenger issue", "technical problem"): "{cs}, request return to stand, technical problem." ATC: "{cs}, taxi to stand {A12} via …" (if the stand is now occupied → "expect stand {B7}"). Engine: aircraft leaves the departure sequence, `plan.kind` stays departure, ready again after 20–40 min or removed (50%).

### C9. Tow operations (missing vehicle type, needed by §4.2/4.7/4.9 "tow 15–40 min")
| Vehicle | Callsign | Speed | Behaviour |
|---|---|---|---|
| Tow tug (with aircraft) | "Tug {n} with {cs} in tow" | 8 kt towing, 15 kt empty | Needs taxi clearance like an aircraft ("Tug 3, tow the 737 from stand A12 to the hangar via Alpha, hold short runway 22"); crossing tokens apply; safety radius = towed aircraft's. Towed aircraft `phase=towed`, no radio (tug talks). Tow from runway after emergency: attach 10–20 min after ARFF release, tow at 8 kt, runway occupant `kind=stopped` until fully clear. |

### C10. Taxiway/stand closures & NOTAM feed
Commands `TWY {B} CLOSE [BETWEEN D AND E]` / `TWY {B} OPEN`, `STAND {A12} CLOSE|OPEN`, `RWY {rwy} CLOSE|OPEN [REASON]`. Effects: A* edge cost = ∞, pilots refuse routes through closed edges ("unable, Bravo closed"), ATIS remark added, strips of aircraft whose route uses the closed edge flagged "REROUTE". Scenario JSON `notams[]` (G8) pre-applies closures. Score: taxi clearance via a closed taxiway (pilot refuses 90%; 10% executes → −25 "closed taxiway").

### C11. Meta transmissions (missing everywhere; needed by the readback mechanic)
| Command | Controller says | Effect |
|---|---|---|
| `STANDBY cs` | "{cs}, standby" | pilot request timer reset to 120 s (no repeat); no other effect |
| `DISREGARD cs` | "{cs}, disregard" | removes the newest **pending** command (before `applyAt`); if already executing → pilot "already turning/taxiing, confirm?" |
| `CORRECTION` (inline) | "{cs}, correction, heading two **five** zero" | replaces the value of the last command for that cs, restarts pilot delay |
| `NEGATIVE cs …` | "{cs}, negative, squawk four two **one** seven" | readback-error correction (G4); clears the pending wrong value |
| `SAY AGAIN cs` | "{cs}, say again" | pilot repeats last transmission |
| `CONFIRM cs {item}` | "{cs}, confirm heading two four zero" | pilot replies with current value |
| `READBACK CORRECT cs` | "{cs}, readback correct" | required after IFR clearance when `requireReadbackCheck` (FAA practice); omission −0 but pilot waits 30 s before requesting push |
| `ROGER cs` | "{cs}, roger" | acknowledges a pilot report (needed to stop "did you copy?" repeats for reports like "runway vacated", "going around", "bird strike") |
| `BROADCAST text` | "All stations, {unit}, {text}" | e.g., "emergency descent in progress", "runway two seven closed", "stop transmitting, MAYDAY" — no readback |
| `WIND cs` / `SAY WIND` | "{cs}, wind two seven zero degrees one two knots, gusting two zero" | pilot "roger"; used on pilot "request wind check" |
| `TIME cs` | "{cs}, time one four two zero" | flavour |

### C12. Stop bars (LVP, §5)
Runway hold lines have `stopBar: bool` (CAT II/III holds always). During LVP: red stop bar lit by default; **a clearance to line up/cross/enter switches it off for 90 s**; the pilot **never** crosses a lit bar even with a spoken clearance (ICAO): "{cs}, stop bar is lit, confirm?" Player command `STOPBAR {holdId} OFF|ON` (auto with the clearance; manual override for failures). Crossing a lit bar cannot happen (safety), but issuing a clearance without the bar going out (failure event 2%) delays the movement 30–60 s. Score: stop-bar lit and clearance issued 3× without resolution → −25 "LVP procedure".

### C13. Departure flow: CTOT / EDCT, ground stop, MDI, release
- Scenario/random: **CTOT** (EUROCONTROL) / **EDCT** (FAA) on 15% of departures in "Flow" scenarios: window **−5 / +10 min** around the slot; strip shows the slot and a colour (green in window, amber < 5 min to open, red missed). Missed slot → pilot "request new slot", +20–40 min delay, −10 "slot missed" if the aircraft was ready in time but not launched.
- **Ground stop** event (destination weather): "all departures to {dest} hold at the gate for {20–45} min"; affected strips flagged; startup/push denied ("expect start-up at {time}").
- **Minimum departure interval (MDI)** per SID/fix: default 2 min same fix (non-radar) or 3 NM radar (D9).
- **Departure release** (`requireRelease`): TWR asks APP "release {cs}?" → auto-APP grants in 5–30 s ("released, void time +3 min") or "hold for release, {n} minutes" when the departure fix is congested (> 3 departures to the same fix in 5 min). Takeoff before release −50 "no release".

### C14. Pilot-request catalogue (ground) with timeouts
| Request | Prob. | Phrase | Repeat / escalate | Player answer |
|---|---|---|---|---|
| Clearance | 100% dep | "request clearance" | 60 s / 180 s | `CLR` |
| Start / push | 100% | "request start-up / pushback" | 60 s / 180 s | `START`, `PUSH` |
| Different facing | 5% | "request facing south due company traffic" | — | `PUSH FACE S` |
| Taxi | 100% | "request taxi" | 60 s / 180 s | `TAXI` |
| Intersection | C2 | | | `TAXI rwy AT C` |
| Full length (after being given an intersection) | 30% of H | "request full length" | | |
| Different runway | 5% | "request runway {27R} for performance" | | `TAXI 27R` / "unable" |
| Return to stand | C8 | | | |
| De-icing | §1.14 | | | |
| Wind check | 10% at hold | "request wind check" | | `WIND cs` |
| Ready | C1 | | 120 s | `LUAW`/`CTO` |
| Expect delay | if hold > 5 min | "say expected departure time" | | `EXPECT cs n MIN` |
Unanswered after the escalate timeout → pilot "{cs}, standing by" and the request goes to the **red** list; every 120 s thereafter +1 to "ignored requests" (delay metric). No points, but avg-delay balloons.

---

## D. MISSING — Tower commands & edge cases

### D1. Continue approach / expect late landing clearance (in §7 table but no feature)
- **ATC:** "{cs}, continue approach, number two, expect late landing clearance, traffic vacating." **Pilot:** "Continue approach, {cs}." Engine: suppresses the 4 NM "confirm cleared to land?" query; the pilot continues to the **B1 no-clearance point (1 NM / 300 ft)**, then goes around. UI: the strip shows "CONT" and a countdown to the go-around point. Score: none; a landing clearance issued after 1 NM but before touchdown is accepted 100% if the runway is clear (−0), but "late clearance" is logged for the summary.

### D2. Multiple landing clearances (FAA only, 7110.65 3-10-6 practice)
FAA airports may clear a second arrival to land behind the first with traffic information: "{cs}, number two following a 737 two-mile final, runway {rwy}, cleared to land." ICAO airports (`phraseologyRegion: 'ICAO'`): only one aircraft may hold a landing clearance per runway; a second `CTL` is **refused** with "{cs2} already cleared to land" and the correct phrase is "continue approach" (D1). Engine: `runway.landingClearances: cs[]` (FAA max 3, ICAO max 1); anticipated separation still checked at the threshold.

### D3. Traffic information to the LUAW aircraft (FAA 3-9-4 e)
When issuing LUAW with any arrival inside 6 NM on the same/intersecting runway, the transmission **must** include the traffic ("traffic, 737, four-mile final") — the pilot readback echoes it. Omission −10 "LUAW without traffic". At night or vis < 3 SM FAA prohibits LUAW at an intersection when an arrival is inside 6 NM? — game rule: LUAW at an **intersection** with an arrival inside 6 NM (night/IMC) → pilot refuses 50% and −25.

### D4. Wind change mid-approach (explicitly missing)
State: `runway.currentWind` (10-s average, sampled each second; gust = 10-min max) vs `atis.wind`.
- **Controller obligations:** (a) wind must be transmitted with every takeoff/landing clearance (already); (b) when the **current** wind differs from the last wind given to an aircraft on final by ≥ 10 kt or ≥ 30° and gusts ≥ 15 kt, the controller should issue "{cs}, wind check, two nine zero degrees one eight knots gusting two eight" (`WIND cs`); omission before touchdown −5 "wind not updated" (only when `requireWindOnClearance`).
- **Windshear / microburst (LLWAS model):** `windshearAlert {runway, type: 'WS'|'MB', gain/loss kt}` — triggered by weather script (thunderstorm 40%/10 min, gust front 20%) or random 0.5%/h in rain. ATC broadcast phrase mandatory within 30 s: "**{cs}, windshear alert, runway {rwy} arrival, {20}-knot loss, two-mile final**" / "**microburst alert, runway {rwy} departure, {40}-knot loss, one-mile final**". Pilot reaction: arrival inside 3 NM → GA 25% (WS) / 80% (MB); pilot on final receiving the alert late (> 30 s after activation) → GA 60% and −25 "late windshear alert"; departures refuse takeoff for 5 min on MB ("we'll wait"). Alerts expire after 5–15 min. Pilot PIREP "{cs}, windshear on final, plus/minus 15 knots at 500 ft" must be **relayed** to the next 3 arrivals and departures ("caution, windshear reported by a 737 on final, plus/minus 15 knots at 500 ft") — omission −10 each.
- **Limits during final:** at 1,000 ft AGL the pilot re-evaluates: tailwind component > 10 kt → GA 50% (existing); crosswind (incl. gust) > type limit (jets 35 kt, turboprop 30, light 15) → GA 80%; > limit + 5 kt → 100%. After GA the pilot requests "the other runway" if a better runway exists.
- **Runway change with arrivals on final:** if the player changes runway config while an arrival is inside 10 NM, the arrival keeps the old runway (8-min grace) and the *old* runway state remains active for it; departures on the new runway must respect the old runway's intersection box. UI: "transition" ribbon lists aircraft still using the old runway.
- **Wind shift after takeoff clearance:** if the wind becomes a > 10 kt tailwind between clearance and roll start, pilot refuses 30% ("{cs}, request wind check… we'll hold for the other runway").

### D5. Go-around with traffic behind / departure just launched / parallel (explicitly missing)
Rules the engine applies and the player must handle:
1. **GA vs trailing arrival on the same ILS** (follower 3–6 NM behind, descending): the go-around climbs on runway heading; the pair is under **reduced minima** while: GA altitude ≥ follower altitude + 500 ft **or** GA has turned ≥ 30° off the final course. If neither is achieved within **60 s** of the GA (approach_atc §10.2 grace), the pair becomes a normal 3 NM/1000 ft pair → likely separation loss. Therefore the controller's missed-approach instruction should include a **divergent heading** (≥ 30° from final) at/after 400 ft AGL, or the follower must be broken off ("{cs2}, go around/turn left heading 180, climb 3000"). UI: the GA's strip shows "TRAFFIC BEHIND 3.2 NM ↓2000" in amber; STCA counts from the moment the GA is declared.
2. **GA vs departure just launched from the same runway** (departure airborne < 3 NM ahead, same track): under 60-s grace only if courses diverge ≥ 15° or 1,000 ft exists; controller should turn one of them immediately (departure gets its SID turn first; if the SID is straight ahead, turn the GA 30° opposite). Pilot on the GA calls "{cs}, going around, traffic ahead" and slows to 160 kt on their own (no closure > 20 kt).
3. **GA vs parallel-runway arrival** (independent parallels): missed approach must not turn toward the parallel; default missed = straight ahead; instruction "turn left heading 240" toward the parallel while the parallel arrival is inside 5 NM → refused by pilot? No — executed & scored (−500 if < 3 NM/1000 ft; the parallel pair loses reduced minima once the GA leaves its localizer).
4. **GA vs aircraft lined up on the same runway:** the departure on the runway is told "hold position" automatically by auto-TWR; if the player is TWR, launching it while the GA is < 3 NM ahead and < 1,000 ft → −500.
5. **GA vs crossing aircraft:** crossing continues (GA passes overhead); no penalty beyond the incursion that caused it.
6. **Wake on GA:** GA behind a H/S departure that just rotated → pilot climbs above the leader's path (no penalty), advisory "caution wake turbulence" expected (−0).
Auto-instruction if the player stays silent 30 s: "fly runway heading, climb {missedApproachAlt}" + auto-turn 30° away from any conflicting traffic at 1,500 ft (engine safety net; −25 as already specified).

### D6. Runway blocked by a disabled aircraft (non-emergency event)
Rate 1/300 movements: blown tyre on landing, "unable to vacate, nose-wheel steering", brake overheat stop. Pilot: "{cs}, we're unable to vacate, request tow." Runway occupant `kind=stopped` (indefinite). Player must: go-around / break off arrivals, divert departures to another runway, dispatch tow (C9) + ARFF local standby (brake fire risk 10%), runway inspection after tow. Duration 15–40 min. Landing-distance model needed for this and LAHSO: `LD = ld_m × (wet 1.3 | contaminated 1.6) × (1 + 0.1·tailwind/5) × (1 + 0.02·max(0, Vapp_actual − Vref))`; `ld_m` defaults L 600 · turboprop 1,000 · M 1,600 · H 2,000 · S 2,300 m; overrun when `LD > runway length − touchdown point`.

### D7. Pattern / VFR commands (extend §2.18)
`ORBIT L|R` ("orbit left for spacing" ICAO / "make a left 360" FAA), `EXTEND DOWNWIND [n NM | I'LL CALL YOUR BASE]`, `TURN BASE` ("turn base now"), `SHORT APPROACH` ("make short approach"), `ENTER DOWNWIND|BASE|STRAIGHT-IN L|R rwy`, `REPORT DOWNWIND|BASE|FINAL|2 MILE FINAL`, `NUMBER n FOLLOW type ON base|final`, `S-TURNS` ("make S-turns for spacing"), `SQUARE YOUR BASE`? (omit), `CLEARED TO LAND, TRAFFIC HOLDING IN POSITION`, `GO AROUND, ENTER LEFT DOWNWIND` (pattern GA), `MAKE FULL STOP`, `REMAIN IN THE PATTERN`, `DEPART THE PATTERN STRAIGHT OUT|LEFT CROSSWIND`. VFR arrivals check in 10 NM out: "Tower, {cs}, Cessna 172, ten miles south, inbound landing with information {L}." ATC: "{cs}, enter left downwind runway {rwy}, report downwind." Engine: pattern altitude 1,000 ft AGL (1,500 for M turboprops), downwind 1 NM abeam, base at 45° from threshold; orbit = 360° at rate-1 (2 min); extend = continue downwind until `TURN BASE`; VFR pilot deviation rate 5% (wrong pattern side). Score: +5 per pattern op; VFR/IFR pattern conflict < 1.5 NM/500 ft without traffic info −100 (not −500: visual environment).

### D8. Wind check & "say" family (D4 + C11) — done above.

### D9. Successive departure interval (tower needs a rule, §2.8 lacks it)
Radar: next departure on the **same** SID/track needs 3 NM at the boundary → with typical speed profiles a launch interval of **≥ 90 s** (M behind M), **≥ 120 s** slow-leader/fast-follower (turboprop ahead of jet: 180 s), **60 s** if courses diverge ≥ 15° immediately after takeoff (FAA 5-8-3: 1 NM diverging rule), **≥ 2 min** non-radar same fix. Engine: `nextDepartureOkAt = max(wakeTimer, runwaySep, sidInterval)` shown as one countdown on the runway; auto-APP complains "{cs2} is 2 NM behind {cs1}, same SID" if violated and the resulting separation loss is scored −500 to the tower launch, not the APP.

### D10. Parallel & intersecting runway operations modes
`AirportConfig.runwayConfigs[]: { name, landing: rwy[], departing: rwy[], mode: 'mixed'|'segregated', lahso: bool, intersectionBoxes: [{rwyA, rwyB, fromA_m, toA_m, fromB_m, toB_m}] }`. Intersection box rule (7110.65 3-10-4 / 3-9-8): a landing/departing aircraft may not be cleared if the other runway's occupant will be in the box at the same time; arrival on 27 behind departure on 22: departure must have **passed the intersection** or be airborne and turned/1 NM beyond before the arrival crosses the threshold; converging non-intersecting runways ("flight paths cross") use the same rule with the projected crossing point. Prediction: `timeToBox(occupant)` from speed; ladder shows both runways' arrivals.

### D11. Day / night (used by LUAW, anticipated separation, visual approaches, bird rates, but never defined)
Scenario `startTimeZ`, airport lat/lon → sunrise/sunset (NOAA algorithm) → `isNight = now < sunrise or > sunset`; "day" for 7110.65 purposes = sunrise to sunset. Night: distance-based runway separation options off (runway must be clear); LUAW rules per §2.1; visual approaches only with `visualApproachAtNight`; bird rate ×0.3 (except dawn/dusk ±45 min ×3); light-gun pilot ack = light flash. UI: ambient colour and lighting on the 3D/ground view.

### D12. Time-based crossing lock (replace fixed 2 NM in §1.6)
`crossAllowed = timeToThreshold(nearestArrival) > pilotDelayGround + crossingDuration(aircraft) + 20 s buffer` and `nearestDeparture` not `takeoff`; `crossingDuration` = (runway width + 2 × 60 m shoulders + aircraft length) / crossing speed (10–15 kt; H/S 8–10 kt; vehicles per table). Typical result: 2 NM for a M behind a 140-kt arrival, ~3 NM for an S. Night/IMC: +30 s buffer. Display the computed value on the crossing ribbon ("XING OK for 0:38").

### D13. Departure "cleared for takeoff" edge cases missing
- Aircraft cleared for takeoff but a **preceding rolling-takeoff aircraft aborted** (RTO ahead): the follower's clearance is auto-cancelled by the engine ("{cs}, holding position, RTO ahead"), no penalty; the player must issue `STOP` only if the follower already started rolling (< 10 s window) — failure → −500 incursion.
- **Takeoff clearance while an arrival is on a 1-NM final of an intersecting runway** → intersection box rule (D10).
- **Departure not yet at Vr when the wind shifts to tailwind** → continues (no rule).
- **Departure heading conflicts with the missed approach of an arrival on final** (< 4 NM): auto-TWR withholds; player launching → D5 rule 2 applies.

### D14. Runway exit instructions vs geometry
`runway.exits[]: {twy, dist_m, angle, highSpeed: bool, maxSpeedKt}`; the pilot's exit choice model uses the rollout ETA; ATC-requested exit that requires > 2.5 m/s² decel (dry) → "unable {C}, we'll take {D}"; requested exit **before** the aircraft's minimum rollout (e.g., first exit at 600 m for an H) → refused with the same phrase. "Take next available exit" → nearest exit ahead reachable ≤ 30 kt. Runway occupancy time is reported to the delay metric.

---

## E. MISSING — Approach commands & edge cases

### E1. Non-ILS approaches (the spec assumes every runway has an ILS)
`runway.approaches[]: {type: 'ILS'|'LOC'|'RNAV'|'VOR'|'NDB'|'VISUAL', cat?, minimaDA_ft, minimaRVR_m | vis_m, iaf[], faf, mapt, missed}`. Phrases: "{cs}, cleared RNAV runway {rwy} approach via {IAF}" (aircraft self-navigates IAF→IF→FAF, 3° from FAF; LNAV minima DA 400–500 ft / vis 1,600 m; LPV 250 ft/800 m), "cleared VOR runway {rwy} approach" (step-down descent 500 ft/NM, MDA 600 ft, requires "report field in sight" at MDA else missed). Aircraft draw `rnavCapable` (95% jets, 60% GA). Runway without ILS + weather below the best non-ILS minima → diversions unless another runway serves. Parser: `RNAV rwy [VIA iaf]`, `VOR rwy`.

### E2. Join / intercept localizer without approach clearance (FAA 5-9-2)
"{cs}, turn left heading 240, **join the localizer** runway 27, maintain 3,000" → aircraft tracks the LOC at the assigned altitude and **does not descend on the GS** until "cleared ILS"; at the FAF without clearance → "{cs}, at {FAF}, request approach clearance" and after 30 s levels off/goes missed. Needed for parallel-approach sequencing and spacing behind slower traffic. Parser `JOIN LOC rwy`. Score: −0; forgetting the clearance costs a missed approach (+8 min delay).

### E3. TCAS RA (missing entirely — mandatory realism item)
Trigger: any airborne pair predicted < 0.5 NM & < 600 ft within 25 s (i.e., after STCA red is ignored) → both aircraft execute an RA: climb/descend 1,500–2,500 ft/min opposite sense for 20–40 s, ignoring ATC vertical instructions. Pilot: "{cs}, TCAS RA." Controller must **not** issue vertical instructions until "{cs}, clear of conflict, returning to {alt}" (ICAO Doc 4444 15.7.3): any altitude command during an RA → refused by the pilot ("unable, TCAS RA") and −50 "instruction during RA". Correct response: "{cs}, roger" (`ROGER`). Separation loss scored once (−500); RA itself +0. `autoSlowOnAlert` forces 1×.

### E4. Weather deviation requests (thunderstorm cells promoted from "v2 optional" to v1-minimal)
`thunderstormCells[]: {center, radius_nm, top_ft, movement}` rendered on the radar (weather returns). Pilots inside 10 NM of a cell request "{cs}, request deviate {20} degrees left for weather" (100% for cells ahead within 5 NM; they refuse vectors into a cell: "unable, weather"). ATC: "{cs}, deviation left approved, when able proceed direct {fix}" (`DEV L|R n [WHEN ABLE DCT fix]`). Unanswered 30 s → pilot deviates anyway (−0, but the deviation may cause a separation loss attributed to the player if not re-planned). Vectoring an aircraft through a cell → pilot refuses (no execution).

### E5. Holding-stack management
`DESCEND IN HOLD cs alt` ("{cs}, descend in the hold to 4,000"), `EFC cs hhmm` ("{cs}, revised EFC 1425"), `HOLD cs … EXPECT n MIN DELAY`. Stack rule: aircraft may only descend to a level vacated by the aircraft below (engine refuses ("{cs}, unable, traffic below") if another holder is within 1,000 ft below). Stack order for approach: lowest first; instructing a higher aircraft out first with a lower one still holding → allowed but the lower one's pilot asks "we were first?" (−0, delay fairness stat). Hold > 20 min without an EFC update → pilot "{cs}, request revised EFC and expected delay" (−0).

### E6. Query family (`SAY`)
`SAY cs ALT|HDG|SPD|FUEL|SOULS|INTENTIONS|POB|TYPE` → pilot answers ("passing 4,300 for 3,000", "heading 240", "one eight zero knots", "fuel 55 minutes", "one two three persons on board"). `VERIFY cs ALT` ("verify altitude") for Mode-C mismatch events (2%: label shows ±300 ft from actual for 60 s; controller must verify; separating on a wrong readout is the player's risk).

### E7. Center coordination (arrival inbound, departure outbound)
- Arrivals: 3 min before entry the strip appears in the "inbound" column with ETA/fix/level; auto-Center offers "{cs}, {fix} at {time}, FL130, information {L}"; player may **refuse/delay inbound** (`HOLD INBOUND cs n MIN` → Center holds it outside; +n min delay, no points) to manage the flow — this is the only flow tool APP has.
- Departures: handoff to Center (§3.14) requires climb ≥ FL90 or assigned exit level; Center may impose "**{fix} closed, expect vectors**" events (5%) → departure must be held at ≤ FL90 inside the TMA (hold at the exit fix) until reopened (5–10 min).
- **Point-out**: aircraft entering the neighbour's airspace briefly (vectors beyond the boundary) → `POINT OUT cs` reduces the "unhandled exit" −100 to 0 (Center approves 90%).

### E8. Delay vectors / orbit in the TMA
`ORBIT cs L|R`, `DELAY VECTORS cs` (pilot: "roger, delay vectors"), `EXPECT cs n MIN DELAY`. Orbit adds ~2 min per 360°. Orbiting below MVA/near a cell → refused.

### E9. Final-approach compression (spacing tool §3.9 must model it)
Predicted threshold gap must use each aircraft's **speed profile**, not the current speed: `Vapp` differs (E190 130 kt, B738 145, A388 140, C172 70, DH8D 115). A 3 NM gap at 10 NM between a 160-kt jet behind a 110-kt turboprop closes to ~1.5 NM at the threshold. The tool shows `gapAtThreshold` and colours red < required; the controller's tools are speed control (`S`), "maintain 160 to 4 DME" (also for the leader), and vectors. Auto-APP applies speed control before vectors. Score: gap violations at the threshold are the wake/separation events already listed.

### E10. Similar callsigns (missing mechanic, `pilotErrorRate`)
When two aircraft on the same frequency have callsigns sharing airline + 2 of 3 digits (AAL123 / AAL132), `pilotErrorRate`% chance the **wrong** aircraft takes the command: the readback comes from the wrong callsign ("left heading 240, American one three two") — the player must catch it (`NEGATIVE AAL132 …` / `DISREGARD AAL132`, then re-issue) within 10 s or the wrong aircraft executes. Controller may pre-empt: `SIMILAR cs1 cs2` → "American 123 and American 132, similar callsigns on frequency, use caution" (halves the error rate). Traffic generator (G2) avoids > 1 similar pair per session unless "pilot error" ≥ 5%.

### E11. Departures: "turn before 400 ft" & SID conflicts
Heading issued with takeoff clearance executes at **400 ft AGL** (already); heading issued **after** airborne executes immediately. SID crossing a STAR (airspace design) is the auto-APP's problem only when APP is auto; when the player is APP, departures on the SID climbing through arrival levels are a normal separation task — the spec should say the reference airport's SID/STAR must have **procedural deconfliction** (SID altitude ≤ STAR altitude −1,000 at crossings) so that Auto-ATC runs conflict-free at Light/Medium density.

---

## F. MISSING — Emergencies & abnormals (add to §4 table; same columns)

| # | Event (squawk) | Pilot declaration | Controller must | Engine | Post | Score |
|---|---|---|---|---|---|---|
| 4.13 | **Hot brakes / brake fire after landing or RTO** (PAN → MAYDAY if fire) | "{cs}, hot brakes, request to hold on the taxiway for cooling, request fire service check" / "brake fire, evacuating" | Hold the aircraft on a taxiway clear of runways/stands; ARFF local standby to it; keep other traffic 100 m away; no towing until cooled | after any RTO > 80 kt or landing with `LD/available > 0.9`: 30% hot brakes (cooling 30–45 min), of which 15% brake fire (ARFF extinguishes 5 min; wheel-well fire → evacuation 40%) | tow if fire; else taxi at 10 kt to a remote stand | ARFF at the aircraft ≤ 3 min +50; taxi to a stand with hot brakes (player insists, pilot refuses 70%) −50; other traffic routed within 100 m −25 |
| 4.14 | **Blown tyre on takeoff / landing** (PAN) | "{cs}, blown tyre on rotation, request low approach for gear inspection then landing on the longest runway" | Fly-by (as 4.7), longest runway, local standby, runway inspection for **debris** before the next movement | tyre debris on runway 100% → runway closed until inspected (3–6 min) | after landing stops on runway 40% (tow) | next movement on un-inspected runway −50 (10% FOD → new emergency) |
| 4.15 | **Flap/slat failure** (PAN) | "{cs}, flap problem, request longest runway, approach speed one seven five knots, we'll need extended final" | Longest runway, ≥ 10 NM final, no speed control below 175 kt, extra spacing behind (fast follower), local standby | Vapp +30 kt; LD ×1.6; no LAHSO | may stop on runway 20% | as hydraulic (4.9) |
| 4.16 | **Pilot incapacitation** (MAYDAY) | "MAYDAY, {cs}, captain incapacitated, single pilot, request vectors ILS {rwy}, minimal instructions" | Full priority, **short and few instructions** (max 2 items per transmission), no speed control, ambulance at the gate, follow-me | pilot delay ×2, refuses combined commands ("say again, one at a time") | gate + ambulance | > 2 items in one transmission −25 each; ambulance +50 |
| 4.17 | **Fuel leak / imbalance** (PAN → MAYDAY) | "{cs}, fuel leak, request immediate return" | Full emergency (fire risk), no holding, shortest routing | fuel countdown ×3; fire on landing 5% | ARFF check on taxiway 5 min | delay > 2 min −100 |
| 4.18 | **Lightning strike** (PAN) | "{cs}, lightning strike, systems checking, request return" | Priority (not emergency unless systems fail 20%), inspection after landing | comms may degrade (readbacks 20% garbled → "say again") | gate | — |
| 4.19 | **Severe turbulence injuries** (PAN, medical) | "{cs}, several passengers injured, request ambulances at the gate" | as 4.3 (two ambulances if `Medic 2` exists) | | | as 4.3 |
| 4.20 | **Disruptive passenger** (no squawk) | dep: "{cs}, request return to stand, disruptive passenger, request police at the gate" / arr: "request police on arrival" | Taxi to stand (C8) or assign a remote stand; police via button (`POLICE stand`) | departure aborted | — | police at gate within 10 min +25 |
| 4.21 | **Laser illumination** (report) | "{cs}, laser illumination from the {SE} at 1,500 ft on final" | Acknowledge, relay to following arrivals for 20 min ("caution, laser reported…"), log (`POLICE` button) | 5% pilot GA (dazzled) | — | relay omitted −10 per following arrival |
| 4.22 | **Drone / UAS sighting** (report) | "{cs}, drone sighted at 1,000 ft, two-mile final" | Suspend arrivals on that runway for **20–30 min** (holds/diversions), departures continue if the sighting is on final; runway change if available | random 1/500 movements | resume after police report | operating the affected final within 5 min of the report −100 "hazard ignored" |
| 4.23 | **Bomb threat / security** (no squawk, via "phone" event) | none from pilot; event card | Isolated stand, no crossing traffic within 200 m, police; as 4.10 without radio silence | aircraft lands normally | isolated stand for the session | as 4.10 |
| 4.24 | **Fuel spill at stand** (ground) | Fuel 1: "Ground, Fuel 1, fuel spill at stand A12" | Close stand + 2 adjacent (30–45 min), ARFF one truck, reassign arrivals | random 1/200 turnarounds | reopen | pushback/taxi within 50 m of an unresolved spill −50 |
| 4.25 | **Apron collision / vehicle strike** (ground) | "{cs}, we've been struck by a catering truck, request engineer / cancel departure" | Return to stand / stand blocked 60 min | random 1/400 pushbacks (3% when a baggage tug blocks the lane and the player pushes anyway) | — | player-issued push into a blocked lane −500 ground collision (existing) |
| 4.26 | **Taxiway excursion (stuck in mud / off pavement)** (ground) | "{cs}, we've left the pavement, request tow" | Close the taxiway segment, tow (C9), reroute traffic | 0.2% of turns > 90° at > 12 kt, ×5 on contaminated | 30–60 min | expedite issued to that aircraft on contaminated surface earlier −25 "cause" |
| 4.27 | **Engine fire on start / tail-pipe fire at stand** (ground) | "{cs}, engine fire on start, ARFF to stand A12" | ARFF full to the stand (apron speeds), evacuation 30%, close adjacent stands | 0.3% of starts | stand closed 60 min | ARFF at stand ≤ 3 min +50 |
| 4.28 | **Runway excursion / overrun** (landing/RTO) | "{cs}, we've overrun / left the runway" | Alert III; runway closed 60–180 min; all arrivals divert or use another runway | from D6 LD model or contaminated (1%) | recovery | not player-attributed unless caused by a scored decision (LAHSO/tailwind/wet expedite): then −1000 |
| 4.29 | **Tail strike / hard landing** (report) | "{cs}, possible tail strike, request runway inspection" | Runway inspection (2–4 min), aircraft to stand | 0.2% landings, ×3 gusts > 20 kt | — | next movement on un-inspected runway −50 |
| 4.30 | **Wildlife on runway (deer/dogs)** | Ops/pilot report | as birds: Ops 1 clears (5–10 min), runway closed meanwhile | rate by scenario | — | movement while animals reported on the runway −100 |
| 4.31 | **ILS failure / runway lighting failure / radar failure / frequency failure** (airport systems) | ATIS event card | ILS out: switch to RNAV/visual or other runway; lights out at night: runway closed; radar out: no radar services — 10 NM procedural (game: time-based 3-min longitudinal, "radar service terminated", separation display off, 10–20 min); freq out: pilots on backup freq (all calls prefixed "on guard"), 5–10 min | 1 per 3 h on "Hard" | — | landing clearance on an unlit runway at night −100 |
| 4.32 | **Stuck microphone** | frequency blocked 20–60 s | Cannot transmit; pilots continue last clearance; when it clears: "all stations, {unit}, transmitting blind, frequency was blocked" | rate 1/2 h | — | none (delay only); STCA/forced GA still apply |
| 4.33 | **Slow depressurisation** (PAN) | "{cs}, request descent to 10,000 due pressurisation, no emergency at this time" | Normal descent clearance promptly | descent 3,000 ft/min | — | delay > 60 s −25 |

Emergency **broadcast** and **priority routing** get their own commands: `BROADCAST` (C11), `PRIORITY cs` (marks the strip; auto-APP/TWR give it number one). Also missing: the **souls/fuel query auto-answer** may be included in the MAYDAY call ("…147 souls, fuel 1 hour 20") — the checklist item is then auto-ticked (real-world practice).

---

## G. MISSING — Systems

### G1. Auto-ATC behaviour specification (currently one sentence — the biggest engineering gap)
Each unstaffed position runs an AI with **reaction time** (normal 5–15 s per request, Training 3 s), **quality** (`autoAtcQuality: 0.6–1.0`; errors: late crossing grants, LUAW too early = incursion risk at low quality — but AI errors are never scored against the player), and **explicit decision rules**:
- **Auto-DEL:** clearance within 10 s of request; squawk unique; SID by runway config; amended clearance on runway change.
- **Auto-GND:** push when the lane is clear and ≤ 3 aircraft taxiing to that runway (else "expect 3 minutes"); A* route; hold-short + crossing requests to TWR; give-way by first-come; deice routing; handoff to TWR at ≤ 2 in queue; arrivals to assigned stands; deadlock resolution by rerouting the lighter aircraft.
- **Auto-TWR:** LUAW when arrival > 4 NM; takeoff when all §2.2 preconditions hold (never violates); landing clearance at 5 NM if runway predicted clear; go-around at B1 points **minus 0.5 NM** (conservative); crossing tokens per D12; runway change 5 min after `suggestedConfig`; wind/wake/traffic phrases always included; wake-optimal sequencing.
- **Auto-APP:** downwind/base vectoring to a 8–10 NM final with speed schedule §7.3; target gap = required + 0.3 NM; holds at the IAF stack when > 6 arrivals inside 25 NM; departures "climb via SID" at check-in, handoff at FL90; emergency priority handling per §4 (breaks off arrivals ≥ 6 NM, holds the rest); never below MVA; TCAS/RA rules.
- **Auto ⇄ player interface:** requests appear as strip badges with a countdown; the player answers with the normal command; the AI's transmissions are heard on frequency (TTS) so the player can follow.
- Auto positions produce **frequency load** (G6) like a human.

### G2. Traffic generator (density is defined; the generator is not)
- **Airline / callsign table** per airport (`airlines[]: {icao, telephony, share, types[], stands[]}`); GA share; cargo share; flight-number generation with the similar-callsign limit (E10).
- **Arrivals:** spawn at STAR entry fixes at FL100–FL130, 250–280 kt, with ≥ 5 NM/1,000 ft between successive spawns on the same STAR, ETA jitter ±3 min vs schedule, fuel 45–120 min, `ilsCapability`, stand assignment, gate turnaround link (optional).
- **Departures:** spawn `parked` at stands 10–25 min before scheduled off-block; request clearance at spawn+1–3 min; destination = exit fix; SID by config; CTOT on 15% in Flow scenarios.
- **Schedule shape:** Poisson with hourly rate = preset; "bank" mode (hub waves: 20-min peaks ×2 rate) selectable.
- **Deterministic seed** for scenario sharing; all random draws from a seeded PRNG stream per subsystem (weather, traffic, pilots, emergencies) so replays match.

### G3. Frequency channel model (missing; needed for realism and for TTS scheduling)
Each position has one channel; only one transmission at a time; transmission duration = TTS length (or `0.45 s × words` when muted). Pilot calls queue; a pilot who cannot get in retries after 3–8 s; **player commands are queued behind the current transmission** (up to 4 s) — issuing while a pilot transmits shows "STEPPED ON" 5% of the time (both lost; pilot "say again"). Frequency occupancy % is a HUD gauge; > 80% for 5 min → pilot calls get delayed (avg delay ↑). Toggle `radioRealism: off|on` (off = instant).

### G4. Readback / hearback mechanic (referenced by `requireReadbackCheck` but undefined)
Error rate = `pilotErrorRate` (0/2/5%). Error types: wrong runway (taxi/LUAW/takeoff/landing), wrong altitude (±1,000), wrong heading (transposed digits), wrong squawk, wrong frequency, wrong taxiway, missing hold-short in the readback. The readback text is shown on the strip for 15 s with the changed token **not** highlighted (the player must listen/read). Correction window **15 s** via `NEGATIVE`/`CORRECTION`; after that the pilot executes the wrong value: wrong runway → taxis to/lines up on it (incursion risk), wrong altitude → level bust (−100 "altitude deviation" if it causes < 1,000 ft with traffic, else −25), wrong heading → track deviation, wrong frequency → aircraft "lost" (calls back after 60–120 s). Missing hold-short readback → pilot does not stop (real 7110.65 requirement: hold-short readback mandatory) unless the safety net toggle is on (`holdShortSafetyNet` default on in Light/Medium, off in Heavy/Rush).

### G5. Telephony / spoken forms
`airlines.telephony` (AAL → "American", BAW → "Speedbird", DLH → "Lufthansa", UAL → "United", RYR → "Ryanair", …, GA N-numbers → "November one two three alpha bravo", shortened after first contact); **heavy/super suffix** on first contact with each position ("United 123 heavy"); FAA group form for numbers ("American twelve twenty-three") vs ICAO digit form — governed by `phraseologyRegion`; "niner", "tree", "fife" pronunciation toggle; "decimal" (ICAO) vs "point" (FAA); "hectopascals" vs "altimeter two niner niner two" (inHg, QNH conversion 1 hPa = 0.02953 inHg); "holding point" vs "hold short"; "line up and wait" (both); "descend to" (ICAO) vs "descend and maintain" (FAA); "taxi to holding point runway 27 via A" vs "runway 27, taxi via A". Provide a phraseology template table keyed by `{region}` for every §7 row (two columns).

### G6. Voice / STT grammar (§0 "voice → same parser" is not enough)
Normaliser before the parser: number words → digits ("one two zero" → 120, "flight level one three zero" → FL130, "three thousand five hundred" → 3500, "two seven left" → 27L, "one one eight decimal seven" → 118.7), phonetic alphabet → letters, "left/right heading" → `L/R`, callsign telephony → ICAO code, "heavy" ignored, "cleared for takeoff" → `CTO`, homophones ("to"/"two" handled by grammar position: "climb to two thousand"). Confidence < 0.7 → show the parse for confirmation (Enter) instead of executing; wrong parse executed and scored is the player's problem only if confidence ≥ 0.9 (else free `DISREGARD`).

### G7. Incident code table (needed by DoD #2)
| Code | Points | Skill | Ref |
|---|---|---|---|
| COLLISION_AIR / COLLISION_GND | −1000 / −500 | end / −1.0 | — |
| RWY_INCURSION (sub: takeoff_occupied, landing_occupied, crossing_under_arrival, vehicle, luaw_crossing, stopbar) | −500 | −0.5 | 7110.65 3-1-3, 3-9-4, 3-10-3 |
| SEPARATION_LOSS (radar) | −500 | −0.5 | Doc 4444 8.7.3 |
| WAKE_DEP / WAKE_FINAL | −200 | −0.25 | Doc 4444 5.8.3 / 8.7.3.4 |
| GA_UNHANDLED (player) | −500 | −0.25 | game |
| MSAW_PERSIST / RESTRICTED_AREA | −200 / −100 | −0.25 | 7110.65 5-15 |
| LUAW_UNSAFE / LUAW_NO_TRAFFIC_INFO | −100 / −10 | — | 3-9-4 |
| TAXI_INCOMPLETE / EXIT_INCOMPLETE | −25 | — | 3-7-2 |
| TAXI_CONFLICT / DEADLOCK | −20 / −50 | — | game |
| LAHSO_CONDITIONS / VISUAL_IMC | −100 | — | AIM 4-3-11 / 7-4-3 |
| PERFORMANCE_TAILWIND / CROSSWIND_REFUSAL | −25 / −10/min | — | game |
| ATIS_OUTDATED / QNH_MISSING / WIND_MISSING | −5 | — | Annex 11 |
| HANDOFF_LATE (dep 3 min / twr 4 NM / gnd 180 s) | −100 / −25 / −10 | — | game |
| DIVERSION / DIVERSION_UNHANDLED | −500 / −100 | −0.5 | game |
| EMERGENCY_CHECKLIST_MISS / RA_INSTRUCTION / HIJACK_MENTION | −100 / −50 / −200 | — | 7110.65 10-2-1, Doc 4444 15.7.3 |
| DELAY_15 / DELAY_30 | −10 / skill −0.1 | | |
| Positives: MOVEMENT (+10), PARKED (+10), HOLD_POINT (+5), WAKE_EFFICIENT (+5), GOOD_CATCH (+50), SAFETY_GA (+50), STCA_RESOLVED (+5), ARFF_ON_TIME (+50), EMERGENCY_DONE (+300×), RWY_CHANGE_DONE (+100), LAHSO_SAVE (+30), INSPECTION_CLEAN (+30), BIRDS_ACTIONED (+10), STREAK_1H/2H/5H/10H (+500/1000/3000/5000) |
Every event carries `{code, t, primary, secondary?, rwy?, pos, ref, points, skillDelta, snapshotId}`; dedupe per B2.

### G8. Scenario JSON schema (referenced, never defined)
```
{ "id", "airport": "EGLL", "seed": 12345, "startTimeZ": "2026-01-14T06:30Z", "durationMin": 60|null,
  "positions": ["GND","TWR"], "autoAtcQuality": 0.9,
  "traffic": { "preset": "Heavy"|{ "movPerHour": 30, "arrDepRatio": 0.5, "heavyPct": 0.2, "gaPct": 0.05, "bankMode": false }, "schedule": [ {"cs","type","kind","time","stand","fix"} ]? },
  "weather": { "initial": {...WeatherState}, "script": [ {"atMin": 20, "event": "gustFront"|"fog"|"windShift"|..., "params": {...}} ] },
  "events": [ {"atMin": 35, "type": "emergency", "kind": "engine_fire", "cs"?: "BAW117"}, {"atMin": 5, "type": "notam", "closeTwy": "B", "between": ["D","E"], "durationMin": 40}, {"atMin": 50, "type": "drone", "rwy": "27L"} ],
  "toggles": { "requireWindOnClearance": true, "requireReadbackCheck": false, "frequencies": true, "anticipatedSeparation": true, "arcadeIntercept": false, "arcadeRunwaySep": false, "phraseologyRegion": "ICAO"|"FAA", "runwaySepScheme": "ICAO_RRSM", "wakeScheme": "ICAO4", "lahsoEnabled": false, "visualApproachAtNight": false, "radioRealism": true, "pilotErrorRate": 0.02, "emergencyRate": "Realistic" },
  "startState": { "aircraft": [...], "atisLetter": "K", "runwayConfig": "27L/27R" } }
```

### G9. Airport data checklist (the spec's features silently require all of these; `context/airport_data_model.md` covers only part)
Per runway: length, width, TORA per intersection, displaced threshold, exits (D14), hold lines with CAT I / CAT II-III positions and stop bars, ILS cat + approach list (E1), missed approach (`missedApproachAlt`, fix, hold), turn pad, ARFF standby points (2 per runway end: touchdown zone + midpoint), intersection boxes (D10), parallel pair spacing (A6), LAHSO ALD pairs, noise preference, calm-wind config. Per taxiway edge: one-way, `maxWingspan`, closed flag, high-speed flag, run-up bays. Stands: §1.15 fields + `pushPath`, isolation stand, remote stands, de-ice pad bays + `Iceman` freq. Vehicle bases: fire station, ops building, tug pool + lay-by, fuel farm, follow-me base, bird areas (grass nodes). Airspace: 30 NM boundary, MVA polygons, restricted areas, SID/STAR fixes with constraints, IAFs, exit fixes with directions, alternates, transition altitude, frequencies (DEL/GND/TWR/APP/DEP/ATIS/Center), lat/lon for sunrise, magnetic variation (headings are magnetic — the engine's projection must apply `magVar` to runway headings and vectors).

### G10. Collision, crash and session-end definitions (missing)
- Ground collision: convex hulls (aircraftShapes) overlap, or centre distance < `safetyRadius_a + safetyRadius_b` at > 5 kt relative speed → COLLISION_GND, both frozen, taxiway closed 60 min, session continues (−500) unless on a runway with an arrival inside 2 NM (then forced GA).
- Airborne collision: < 0.1 NM and < 200 ft → session ends (−1000, incident report).
- Landing on an occupied runway with the occupant inside the touchdown zone ±500 m: 5% collision (session ends), else incursion.
- Flame-out (§4.4), overrun (4.28) with fatalities (10%) → session ends.
- Session end otherwise: `durationMin` reached, or player ends; Endless mode ends only on a session-ending incident.

### G11. Unimpeded time & f(skill) (both used, neither defined)
`unimpeded`: clearance wait 0; start 0; push 60 s; taxi = A* length / 15 kt + 15 s per 90° turn + 30 s per runway crossing; hold at runway 0; airborne = great-circle STAR-entry→threshold at 250/200/160 kt schedule + 0; taxi-in as taxi-out; gate wait 0. `f(skill) = clamp(1 / (1 + skill/5), 0.1, 1)` (so +0.1 per movement at skill 0, +0.017 at skill 25); spawn rate `arr/h = min(cap, 6 + 6·skill/10)`.

### G12. Units
Internal: metres, m/s, radians, seconds, hPa, °C; magnetic headings for display; conversions at the UI/phrase boundary only (kt = 0.5144 m/s, NM = 1852 m, ft = 0.3048 m, km/h = 0.2778 m/s). The spec mixes km/h (vehicles) and kt — keep both in text but store m/s.

---

## H. MISSING timing constants (append to §8)

| Constant | Value | Source |
|---|---|---|
| Frequency change → check-in | 5–15 s (`MONITOR`: no check-in) | game |
| Pilot transmission duration | TTS length; ≈ 0.45 s/word | game |
| Stepped-on probability / retry | 5% / 3–8 s | game |
| `STANDBY` request suppression | 120 s | game |
| `DISREGARD` window | until `applyAt` (3 s air / 4–8 s ground) | A9 |
| Readback-error correction window | 15 s | G4 |
| Similar-callsign wrong-aircraft rate | = pilotErrorRate; ×0.5 after `SIMILAR` | E10 |
| Ready-for-departure conditions | engines stable ≥ 60 s; ≥ 45 s since stop; HOT valid | C1 |
| GND→TWR handoff: pilot query / penalty | 120 s / 180 s | C1 |
| TORA required (L/TP/M/H/S) | 500 / 1,200 / 2,000 / 2,800 / 3,200 m (×1.15 wet, +10 %/5 kt tailwind, ×1.05 > 30 °C) | C2 |
| Landing distance dry (L/TP/M/H/S) | 600 / 1,000 / 1,600 / 2,000 / 2,300 m (×1.3 wet, ×1.6 contaminated, +10 %/5 kt tailwind, +2 %/kt above Vref) | D6 |
| V1 | `AIRCRAFT_DB.v1` (default 0.92·Vr jets, 0.85·Vr props) | A8 |
| RTO decel < 80 kt / high-speed | 3.0 / 3.5 m/s² | A8 |
| Brake cooling after RTO < 80 kt / 80 kt–V1 / hot brakes | 2 / 30 / 30–45 min | Boeing brake-energy practice (game) |
| Backtrack speed / turn-pad time (M / H·S) | ≤ 25 kt / 45–90 / 90–150 s | game |
| Tow speed / attach | 8 kt / 10–20 min | game |
| Deadlock: detect / penalty / auto-resolve | 15 s stopped head-on / 120 s / 120 s | C6 |
| Successive departures same SID (M-M / TP-jet / diverging ≥ 15° / non-radar) | 90 / 180 / 60 s / 2 min | D9; 7110.65 5-8-3 |
| Departure release void time | 3 min | 7110.65 4-3-4 practice |
| CTOT/EDCT window | −5 / +10 min | EUROCONTROL / FAA |
| Ground stop duration | 20–45 min | game |
| Stop-bar off after clearance | 90 s | ICAO Annex 14 5.3.19 practice |
| Multiple landing clearances (FAA / ICAO) | max 3 / 1 | 7110.65 3-10-6 / Doc 4444 |
| Continue-approach GA point | 1.0 NM / 300 ft | B1 |
| Forced-GA points | table B1 | |
| Crossing lock | time-based: `TTT > pilotDelay + crossingDuration + 20 s` (+30 s night/IMC) | D12 |
| Wind-check obligation on final | Δ ≥ 10 kt or ≥ 30°, gust ≥ 15 kt | D4 |
| Windshear alert: broadcast deadline / pilot GA (WS / MB) / expiry | 30 s / 25 % / 80 % / 5–15 min | D4 |
| PIREP relay obligation | next 3 arrivals & departures | D4 |
| Crosswind GA at 1,000 ft (> limit / > limit+5) | 80 % / 100 % | D4 |
| GA vs trailing arrival grace | 60 s or ≥ 500 ft above follower or ≥ 30° divergence | D5 |
| Pattern: altitude / downwind offset / orbit time | 1,000 ft AGL (1,500 TP) / 1 NM / 2 min | AIM 4-3-3; rate-1 turn |
| Sunrise/sunset | NOAA solar algorithm from airport lat/lon | D11 |
| TCAS RA: trigger / duration / no-instruction period | < 0.5 NM & < 600 ft in 25 s / 20–40 s / until "clear of conflict" | ICAO Doc 4444 15.7.3; ACAS II |
| Weather deviation: request distance / self-deviate timeout | cell within 5 NM ahead / 30 s | E4 |
| Hold-stack descent | only into a vacated level; ≥ 1,000 ft | E5 |
| EFC update request | hold > 20 min without update | E5 |
| Center "fix closed" | 5 % departures, 5–10 min | E7 |
| Inbound delay tool | `HOLD INBOUND n MIN` | E7 |
| Mode-C mismatch event | 2 %, ±300 ft, 60 s | E6 |
| Auto-ATC reaction time (normal / Training) | 5–15 s / 3 s | G1 |
| Auto-TWR GA margin | B1 point + 0.5 NM | G1 |
| Traffic spawn: arrivals same STAR / departures ready | ≥ 5 NM & 1,000 ft / 10–25 min before off-block | G2 |
| Hot brakes / brake fire after high-energy stop | 30 % / 15 % of those | F 4.13 |
| Blown-tyre debris closure | until inspection (3–6 min) | F 4.14 |
| Drone suspension | 20–30 min | UK CAA practice |
| Fuel spill closure | 30–45 min, stand ± 2 | F 4.24 |
| Taxiway excursion closure | 30–60 min | F 4.26 |
| Engine fire on start rate | 0.3 % | game |
| Runway excursion closure | 60–180 min | game |
| Radar failure / frequency failure duration | 10–20 / 5–10 min | game |
| Stuck mic | 20–60 s, 1 per 2 h | game |
| Pilot-incapacitation instruction limit | 2 items / transmission; delay ×2 | F 4.16 |
| Turnaround by type (L/TP/M/H/S) | 20 / 30 / 35–50 / 60–90 / 90–120 min | airline practice |
| Gate: engines off / despawn | 60 s / 120–300 s (existing) | |
| Ground collision definition | hull overlap or `r_a + r_b` at > 5 kt relative | G10 |
| Airborne collision | < 0.1 NM & < 200 ft | G10 |
| Mag variation | per airport; runway numbers magnetic | G9 |
| Squawk validity | octal digits; exclusions A7 | ICAO Annex 10 |

---

## I. Additions to Definition of Done

9. A5/A4 corrections are implemented: no code path applies a distance-based alternative to "departure behind arrival"; the FAA distance table applies only between sunrise and sunset; ICAO RRSM only when `runwaySepScheme='ICAO_RRSM'` and conditions hold.
10. Forced go-arounds occur only at the B1 points (unit test per row); an incident is never double-counted (B2 dedupe test).
11. Every §C/§D/§E command has parser, context-menu and STT-normaliser coverage (C11 meta commands included) and a pilot readback; `DISREGARD` cancels any pending ground command within the delay window.
12. Wind-change test script: wind 270/8 → 290/22G30 while an arrival is at 5 NM produces the wind-check obligation, the crosswind GA probability, the ATIS regen, and the runway-change prompt in that order.
13. Go-around test scripts: (a) trailing arrival 3 NM behind, (b) departure just launched, (c) parallel arrival, (d) aircraft lined up — each verifies the 60-s grace, the divergence rule, and the attribution.
14. Deadlock test: two aircraft head-on on a single taxiway raise the DEADLOCK alert at 15 s, penalise at 120 s, and are auto-resolved when GND is auto.
15. TCAS RA test: an ignored red STCA leads to an RA; an altitude instruction during the RA is refused and scored; "clear of conflict" restores control.
16. All 33 emergency/abnormal types (4.1–4.33) run end-to-end from the debug menu.
17. Auto-ATC at "Medium" runs 60 sim-minutes with zero incidents at the reference airport with the player staffing no position (proves procedural deconfliction of SID/STAR and the AI rule set).
18. A 30-minute session on `phraseologyRegion: 'FAA'` and one on `'ICAO'` produce the region-correct wording for every §7 row (snapshot test on the TTS strings).
19. Scenario JSON (G8) round-trips through save/resume with identical RNG streams: replaying the same seed produces the same traffic, weather, and emergencies.
