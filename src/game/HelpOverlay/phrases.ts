/* Static phraseology reference (03-ATC-FEATURE-SPEC §7, ICAO column) keyed by the command-tree action where one exists,
   plus the alert catalogue and glossary shown in the help overlay (UX 04 §8). */
import type { ActionId } from '@/lib/sim/commandTree'
import type { AlertKind } from '@/lib/sim/types'

export interface PhraseRow {
  /** `help-phrase-{id}`: the action id when the row maps to a command-panel action, else a stable slug. */
  id: ActionId | string
  action: string
  atc: string
  pilot: string
  when: string
  group: 'Ground' | 'Tower' | 'Approach' | 'Meta' | 'Emergency' | 'Vehicles'
}

export const PHRASES: PhraseRow[] = [
  { id: 'action-startup', group: 'Ground', action: 'Start-up', atc: '{cs}, start-up approved, expect runway {rwy}, QNH {qnh}', pilot: 'Start-up approved, runway {rwy}, QNH {qnh}, {cs}', when: 'Parked, engines off' },
  { id: 'action-pushback', group: 'Ground', action: 'Pushback', atc: '{cs}, pushback approved, face {dir} / tail to {twy}, expect runway {rwy}', pilot: 'Pushback approved, facing {dir}, {cs}', when: 'Parked on a stand that needs a push' },
  { id: 'action-taxi-runway', group: 'Ground', action: 'Taxi to runway', atc: '{cs}, taxi to holding point runway {rwy} [at {int}] via {twys}, hold short of runway {x}', pilot: 'Holding point runway {rwy} via {twys}, hold short {x}, {cs}', when: 'Engines running, pushback complete' },
  { id: 'action-taxi-stand', group: 'Ground', action: 'Taxi to stand', atc: '{cs}, taxi to stand {n} via {twys} [hold short {x}]', pilot: 'Stand {n} via {twys}, {cs}', when: 'Runway vacated or returning departure' },
  { id: 'action-amend-route', group: 'Ground', action: 'Progressive taxi', atc: '{cs}, turn left next intersection onto Bravo, then hold short Charlie', pilot: 'Left on Bravo, hold short Charlie, {cs}', when: 'Taxiing' },
  { id: 'action-hold-short', group: 'Ground', action: 'Hold short', atc: '{cs}, hold short of runway {rwy} / taxiway {twy}', pilot: 'Hold short runway {rwy}, {cs}', when: 'Taxiing towards a crossing' },
  { id: 'action-cross', group: 'Ground', action: 'Cross runway', atc: '{cs}, cross runway {rwy} [at {int}], report vacated', pilot: 'Cross runway {rwy}, {cs} … Runway {rwy} vacated, {cs}', when: 'Holding short of a runway, runway clear' },
  { id: 'action-giveway', group: 'Ground', action: 'Give way / follow', atc: '{cs}, give way to the {type} from your left, then continue', pilot: 'Give way to the {type}, {cs}', when: 'Converging ground traffic' },
  { id: 'action-hold-position', group: 'Ground', action: 'Hold position', atc: '{cs}, hold position', pilot: 'Holding position, {cs}', when: 'Any ground movement' },
  { id: 'action-continue', group: 'Ground', action: 'Continue', atc: '{cs}, continue taxi [hold short of {x}]', pilot: 'Continue taxi, {cs}', when: 'Holding on a taxiway' },
  { id: 'action-expedite', group: 'Ground', action: 'Expedite', atc: '{cs}, expedite taxi / crossing / vacating, traffic {reason}', pilot: 'Expediting, {cs}', when: 'Traffic pressure' },
  { id: 'action-lineup', group: 'Tower', action: 'Line up and wait', atc: '{cs}, runway {rwy} [at {int}], line up and wait [, traffic {type} {n}-mile final]', pilot: 'Runway {rwy}, line up and wait, {cs}', when: 'At the holding point, runway free' },
  { id: 'lineup-conditional', group: 'Tower', action: 'Conditional line-up', atc: '{cs}, behind the landing {type}, line up and wait runway {rwy}, behind', pilot: 'Behind the landing {type}, line up and wait runway {rwy}, behind, {cs}', when: 'Arrival on short final' },
  { id: 'action-takeoff', group: 'Tower', action: 'Takeoff', atc: '{cs}, wind {dir} degrees {spd} knots, runway {rwy}, cleared for takeoff', pilot: 'Cleared for takeoff runway {rwy}, {cs}', when: 'Lined up or at the hold, runway free, wake timer clear' },
  { id: 'takeoff-heading', group: 'Tower', action: 'Takeoff with heading', atc: '{cs}, fly runway heading / turn {L/R} heading {hdg}, runway {rwy}, cleared for takeoff', pilot: 'Runway heading / {L/R} heading {hdg}, cleared for takeoff runway {rwy}, {cs}', when: 'As takeoff' },
  { id: 'takeoff-immediate', group: 'Tower', action: 'Immediate takeoff', atc: '{cs}, runway {rwy}, cleared for immediate takeoff', pilot: 'Cleared for immediate takeoff runway {rwy}, {cs} / Unable immediate, {cs}', when: 'Arrival 2–4 NM' },
  { id: 'action-cancel-takeoff', group: 'Tower', action: 'Cancel takeoff', atc: '{cs}, hold position, cancel takeoff clearance, I say again cancel takeoff, {reason}', pilot: 'Holding position, {cs}', when: 'Cleared, not yet rolling' },
  { id: 'stop-rolling', group: 'Tower', action: 'Stop (rolling)', atc: '{cs}, stop immediately, {cs} stop immediately, {reason}', pilot: 'Stopping, {cs}', when: 'Rolling below 80 kt' },
  { id: 'wake-hold', group: 'Tower', action: 'Wake hold', atc: '{cs}, hold for wake turbulence, {type} departing, expect {n} minutes', pilot: 'Holding, {cs}', when: 'Heavy just departed' },
  { id: 'action-land', group: 'Tower', action: 'Landing', atc: '{cs}, wind {dir} degrees {spd} knots, runway {rwy}, cleared to land [, vacate via {twy}]', pilot: 'Cleared to land runway {rwy}, {cs}', when: 'Established on final, runway free' },
  { id: 'land-lahso', group: 'Tower', action: 'LAHSO', atc: '{cs}, runway {rwy} cleared to land, hold short of runway {x} for crossing traffic, {n} feet available', pilot: 'Cleared to land {rwy}, hold short of runway {x}, {cs} / Unable hold short, {cs}', when: 'Crossing runway in use' },
  { id: 'continue-approach', group: 'Tower', action: 'Continue approach', atc: '{cs}, continue approach, number {n}, expect late landing clearance', pilot: 'Continue approach, {cs}', when: 'Runway still occupied at 4 NM' },
  { id: 'action-goaround', group: 'Tower', action: 'Go around', atc: '{cs}, go around, I say again, go around, {reason}; fly runway heading, climb {alt}', pilot: 'Going around, runway heading, climbing {alt}, {cs}', when: 'Any point on final' },
  { id: 'action-exit', group: 'Tower', action: 'Exit runway', atc: '{cs}, vacate left / right via {twy} / take next available exit on the left', pilot: 'Vacating via {twy}, {cs}', when: 'Rolling out' },
  { id: 'contact-ground', group: 'Tower', action: 'Contact ground', atc: '{cs}, when vacated contact ground {freq}', pilot: 'Ground {freq} when vacated, {cs}', when: 'Rollout' },
  { id: 'action-wind-check', group: 'Tower', action: 'Wind check', atc: '{cs}, wind {dir} degrees {spd} knots', pilot: '{cs}', when: 'Any time' },
  { id: 'radar-contact', group: 'Approach', action: 'Radar contact', atc: '{cs}, {airport} approach, radar contact, descend {alt}, QNH {qnh}, expect ILS runway {rwy}', pilot: 'Radar contact, descend {alt}, QNH {qnh}, {cs}', when: 'Arrival checks in' },
  { id: 'action-heading', group: 'Approach', action: 'Heading', atc: '{cs}, turn left / right heading {hdg} [, vector for {reason}] / fly heading {hdg}', pilot: 'Left / right heading {hdg}, {cs}', when: 'Airborne under control' },
  { id: 'action-altitude', group: 'Approach', action: 'Altitude', atc: '{cs}, climb / descend to {alt} / flight level {FL} [expedite until passing {alt}]', pilot: 'Climb / descend {alt}, {cs}', when: 'Airborne; never below MSA' },
  { id: 'action-speed', group: 'Approach', action: 'Speed', atc: '{cs}, reduce / increase speed to {n} knots / maintain {n} knots until {n}-mile final / resume normal speed', pilot: 'Speed {n} knots, {cs} / Unable {n}, minimum clean {m}, {cs}', when: 'Airborne, inside the envelope' },
  { id: 'action-direct', group: 'Approach', action: 'Direct', atc: '{cs}, proceed direct {fix} [, then fly heading {hdg}]', pilot: 'Direct {fix}, {cs}', when: 'Airborne with a fix ahead' },
  { id: 'action-hold-fix', group: 'Approach', action: 'Hold', atc: '{cs}, hold at {fix}, inbound course {crs}, left / right turns, {n}-minute legs, expect further clearance {hhmm}', pilot: 'Hold at {fix}, inbound {crs}, {turns}, {n}-minute legs, EFC {hhmm}, {cs}', when: 'Inbound, sequence full' },
  { id: 'leave-hold', group: 'Approach', action: 'Leave hold', atc: '{cs}, leave the hold, fly heading {hdg}, descend {alt}', pilot: 'Leaving hold heading {hdg}, descend {alt}, {cs}', when: 'Holding' },
  { id: 'action-ils', group: 'Approach', action: 'ILS (PTAC)', atc: '{cs}, {n} miles from {fix}, turn left / right heading {hdg}, maintain {alt} until established on the localizer, cleared ILS runway {rwy} approach', pilot: '{L/R} heading {hdg}, {alt} until established, cleared ILS runway {rwy}, {cs} … established ILS {rwy}', when: 'Below the glideslope, intercept ≤ 30°' },
  { id: 'loc-only', group: 'Approach', action: 'LOC only', atc: '{cs}, cleared localizer runway {rwy} approach, maintain {alt}', pilot: 'Cleared localizer {rwy}, maintain {alt}, {cs}', when: 'Glideslope unusable' },
  { id: 'action-cancel-approach', group: 'Approach', action: 'Cancel approach', atc: '{cs}, cancel approach clearance, turn left heading {hdg}, climb {alt}, {reason}', pilot: 'Cancel approach, left heading {hdg}, climb {alt}, {cs}', when: 'Cleared for an approach' },
  { id: 'action-expect-runway', group: 'Approach', action: 'Runway change', atc: '{cs}, change of runway, expect ILS runway {new}', pilot: 'Runway {new}, {cs} / Unable, continuing runway {old}, {cs}', when: 'Wind shift, before established' },
  { id: 'action-resume-sid', group: 'Approach', action: 'SID / STAR', atc: '{cs}, climb via SID / cancel SID, fly heading {hdg} / resume own navigation direct {fix}', pilot: 'Climb via SID, {cs}', when: 'Departure climbing' },
  { id: 'squawk', group: 'Approach', action: 'Squawk', atc: '{cs}, squawk {code} / squawk ident', pilot: 'Squawk {code}, {cs} / Ident, {cs}', when: 'Any airborne aircraft' },
  { id: 'action-handoff', group: 'Meta', action: 'Handoff', atc: '{cs}, contact tower / departure / approach {freq}', pilot: 'Tower {freq}, {cs} / Departure {freq}, {cs}, good day', when: 'Leaving your airspace or runway' },
  { id: 'action-report', group: 'Meta', action: 'Report', atc: '{cs}, report heading / position / airspeed / persons on board', pilot: '{value}, {cs}', when: 'Any time' },
  { id: 'action-say-again', group: 'Meta', action: 'Say again', atc: '{cs}, say again', pilot: '(repeats the last call), {cs}', when: 'Garbled call' },
  { id: 'action-correction', group: 'Meta', action: 'Correction', atc: '{cs}, correction, {corrected instruction}', pilot: '{corrected readback}, {cs}', when: 'Readback mismatch' },
  { id: 'action-standby', group: 'Meta', action: 'Standby', atc: '{cs}, standby', pilot: 'Standing by, {cs}', when: 'Open request you cannot answer yet' },
  { id: 'action-unable', group: 'Meta', action: 'Unable', atc: '{cs}, unable, {reason}', pilot: 'Roger, {cs}', when: 'Open request' },
  { id: 'atis-update', group: 'Meta', action: 'ATIS update', atc: '{cs}, information {L} now current, QNH {qnh}', pilot: 'Information {L}, QNH {qnh}, {cs}', when: 'ATIS letter changed' },
  { id: 'traffic-info', group: 'Meta', action: 'Traffic information', atc: "{cs}, traffic {clock} o'clock, {n} miles, {dir}bound, {type}, {alt}", pilot: 'Looking for traffic / Traffic in sight / Negative contact, {cs}', when: 'Converging traffic' },
  { id: 'emerg-ack', group: 'Emergency', action: 'Emergency acknowledgement', atc: '{cs}, roger MAYDAY / PAN PAN, {unit}, say intentions', pilot: '{cs}, request …', when: 'MAYDAY or PAN PAN received' },
  { id: 'souls-fuel', group: 'Emergency', action: 'Souls and fuel', atc: '{cs}, say persons on board and endurance', pilot: '{n} persons, fuel {n} minutes, {cs}', when: 'After the acknowledgement' },
  { id: 'emerg-priority', group: 'Emergency', action: 'Priority', atc: '{cs}, roger, you are number one, runway {rwy}, no delay, emergency services alerted, wind {dir} {spd}, cleared to land', pilot: 'Cleared to land {rwy}, {cs}', when: 'Emergency inbound' },
  { id: 'emerg-dispatch', group: 'Emergency', action: 'Dispatch services', atc: 'Fire 1, 2, 3, {level} standby runway {rwy}, {type}, {nature}, {n} souls, fuel {n} minutes', pilot: 'Fire 1, 2, 3 responding runway {rwy}', when: 'Emergency declared' },
  { id: 'emerg-hold-all', group: 'Emergency', action: 'Hold all traffic', atc: 'All stations, hold position, emergency in progress', pilot: 'Holding, {cs}', when: 'Runway needed for the emergency' },
  { id: 'emerg-reopen', group: 'Emergency', action: 'Reopen runway', atc: 'Ops 1, inspect runway {rwy}, report complete', pilot: 'Runway {rwy} inspection complete, runway clean, Ops 1', when: 'Emergency aircraft towed clear' },
  { id: 'emerg-cancel-ack', group: 'Emergency', action: 'Mayday cancelled', atc: '{cs}, roger, mayday cancelled', pilot: '{cs}', when: 'Pilot cancels the emergency' },
  { id: 'confirm-7500', group: 'Emergency', action: 'Confirm 7500', atc: '{cs}, confirm squawking seven five zero zero', pilot: 'Affirm, {cs} / silence', when: 'Unlawful interference' },
  { id: 'blind-7600', group: 'Emergency', action: 'Blind (7600)', atc: '{cs}, {unit}, if you read, turn left heading {hdg}, acknowledge by ident', pilot: '(ident flash)', when: 'Radio failure' },
  { id: 'vehicle-cross', group: 'Vehicles', action: 'Vehicle crossing', atc: 'Fire 1, cross runway {rwy} at {twy}, report vacated', pilot: 'Crossing {rwy}, Fire 1', when: 'Vehicle holding short' },
  { id: 'vehicle-enter', group: 'Vehicles', action: 'Vehicle enter runway', atc: 'Ops 1, enter runway {rwy}, runway closed, report complete', pilot: 'Entering {rwy}, Ops 1', when: 'Inspection or FOD sweep' },
  { id: 'vehicle-followme', group: 'Vehicles', action: 'Follow-me', atc: 'Follow-me 1, proceed via {twys} to stand {n}', pilot: 'Proceeding via {twys}, Follow-me 1', when: 'Arrival unfamiliar with the field' },
]

export interface AlertHelp { kind: AlertKind; title: string; meaning: string; fix: string }

export const ALERT_HELP: AlertHelp[] = [
  { kind: 'stca', title: 'STCA — short-term conflict alert', meaning: 'Two aircraft are predicted to lose radar separation (3 NM / 1000 ft, wake-aware) within 60 s.', fix: 'Acknowledge, then turn or climb the aircraft not established on the ILS; the alert offers up to three resolution chips.' },
  { kind: 'msaw', title: 'MSAW — minimum safe altitude warning', meaning: 'An aircraft under your control is below the minimum vectoring altitude or descending towards it.', fix: 'Climb it immediately ("low altitude alert, climb {alt}") and keep the ladder above the red band.' },
  { kind: 'runway_incursion', title: 'Runway incursion', meaning: 'An aircraft or vehicle is on or crossing an active runway without a clearance while it is in use.', fix: 'Stop or hold the intruder, cancel or go around the conflicting clearance, then reissue the crossing when clear.' },
  { kind: 'occupied_runway_clearance', title: 'Occupied-runway clearance', meaning: 'A takeoff or landing clearance was issued while the runway was occupied.', fix: 'Cancel the clearance (cancel takeoff / go around) and clear the runway first.' },
  { kind: 'ground_conflict', title: 'Ground conflict', meaning: 'Two ground movements are closing on the same taxiway segment or intersection.', fix: 'Hold one aircraft, give way, or amend a route.' },
  { kind: 'wake', title: 'Wake turbulence', meaning: 'A departure or arrival would follow a heavier aircraft inside the wake separation.', fix: 'Wait for the wake timer on the runway strip, or increase spacing on final.' },
  { kind: 'go_around', title: 'Go-around', meaning: 'An arrival abandoned its approach — no landing clearance, an occupied runway, unstable or wind.', fix: 'Give it runway heading and 3000 ft, then hand it to approach for re-sequencing.' },
  { kind: 'emergency', title: 'Emergency', meaning: 'A pilot declared MAYDAY or PAN PAN.', fix: 'Acknowledge (M,A), assign a priority runway (M,I), dispatch services (M,D), hold other traffic if needed and clear it to land.' },
  { kind: 'diversion_risk', title: 'Diversion risk', meaning: 'An arrival is running out of fuel or drifting to the airspace boundary without instructions.', fix: 'Vector it towards the approach and descend it; answer its requests.' },
  { kind: 'delay', title: 'Delay', meaning: 'An aircraft has waited more than ten minutes for a clearance.', fix: 'Answer its open request; check the runway occupancy bar.' },
  { kind: 'request', title: 'Request', meaning: 'A pilot is waiting for an answer (pushback, taxi, crossing, ready for departure).', fix: 'Select the strip and press Enter to open the highlighted answer.' },
  { kind: 'handoff', title: 'Handoff', meaning: 'An aircraft changed frequency and is calling you.', fix: 'Any instruction clears the "with you" call.' },
  { kind: 'runway_status', title: 'Runway status', meaning: 'A runway was closed, made sterile or suggested for a change after a wind shift.', fix: 'Open the ATIS panel and apply or dismiss the suggestion.' },
  { kind: 'deadlock', title: 'Deadlock', meaning: 'Ground traffic is blocked head-on and nobody can move.', fix: 'Give way, amend a route or push one aircraft back the way it came.' },
]

export const GLOSSARY: Array<{ term: string; text: string }> = [
  { term: 'ATIS', text: 'Automatic terminal information service — the broadcast letter with wind, QNH, active runways and remarks.' },
  { term: 'CTOT / slot', text: 'Calculated takeoff time; departures try to leave inside their window.' },
  { term: 'EFC', text: 'Expect further clearance time given with a hold.' },
  { term: 'FAF', text: 'Final approach fix — where the glideslope is intercepted.' },
  { term: 'Hold short', text: 'Stop before the hold line of a runway or taxiway; a place on the taxiway graph, not a phase.' },
  { term: 'ILS / LOC', text: 'Instrument landing system: localizer (lateral) and glideslope (vertical). LOC-only approaches keep an altitude.' },
  { term: 'LAHSO', text: 'Land and hold short operations — land on one runway and stop before the crossing runway.' },
  { term: 'LUAW', text: 'Line up and wait — enter the runway and hold for the takeoff clearance.' },
  { term: 'MSA / MVA', text: 'Minimum safe / vectoring altitude — never clear an aircraft below it.' },
  { term: 'PTAC', text: 'Position, turn, altitude, clearance — the ILS clearance format.' },
  { term: 'QNH', text: 'Altimeter setting in hectopascals.' },
  { term: 'STCA', text: 'Short-term conflict alert — predicted separation loss.' },
  { term: 'Sterile runway', text: 'A runway reserved for one emergency aircraft; nothing else may use it.' },
  { term: 'Wake category', text: 'L light · M medium · H heavy · J super. The matrix sets the spacing behind a heavier leader.' },
  { term: 'Readback', text: 'The pilot repeats the clearance; a mismatch needs a correction before it counts.' },
  { term: 'Handoff', text: 'Transfer of an aircraft to the next frequency: ground → tower → departure/approach → centre.' },
]
