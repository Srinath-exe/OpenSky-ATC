# 09 — Traffic: airlines, fleets, parked population

`src/lib/sim/airlines.ts` is the single source for who flies what, where.

## Airlines and fleets
`AIRLINES[]`: ICAO / IATA code, name, and a weighted `fleet` of aircraft-database types (BA: A320 family, 787/A350/777,
A380; Emirates: A380 + 777; IndiGo: A320neo family + ATR; SkyWest: E175/CRJ …). `pickType(carrier, r, { weights, stand })`
draws from the fleet filtered by the runway's weight classes and the stand's ICAO size letter (`sizeOfType` from the
wingspan: A < 15 m … F < 80 m). Telephony for every carrier lives in `phraseology.ts` (`AIRLINE_TELEPHONY`); liveries in
`WorldMap/models.ts`.

## Airport profiles
`TRAFFIC_PROFILES[icao]`: weighted home carriers (65 % of new flights, the rest from the world pool — `pickCarrier`),
stand `occupancy` at the start of a shift (gate / open stand / remote share), and `busy` (spawn cadence multiplier: a hub
turns traffic faster than the difficulty default; `SPAWN_TUNING` interval ÷ busy).

## Parked population (`engine.parked`)
When a live game loads (not in test mode), `populateParked()` fills stands per the profile from its own RNG stream:
carrier by profile, type by fleet **and stand size** (a code-C stand never gets a 777; a home carrier that does not fit is
retried home-first), unique callsign, heading = the stand's heading-in. Cap 180 airframes.
* `freeStand()` skips parked stands; a scripted `spawnAt({ gate })` evicts the airframe on that stand.
* `spawnDeparture()` without an explicit identity wakes a parked airframe 80 % of the time: the flight gets that
  airframe's stand, type and callsign (so departures come from what is already on the apron).
* An arrival that has sat at its stand until its despawn time retires into the population (new flight number, same
  stand) — gates stay occupied instead of emptying out.
* Test mode never populates, and scripted spawns read the same seeded stream as before (two identity draws always).

## Rendering
`WorldMap.tsx` draws the population as two instanced meshes (silhouettes + shadows, one draw call each) and lazily
instantiates the detailed liveried model for airframes within 60 % of the tier's model distance from the camera, three per
frame. No labels, lights, strips or comms — they are scenery until woken.

Tests: `tests/engine/parked.test.ts` (population per airport, size fit, home share, waking, retiring).
