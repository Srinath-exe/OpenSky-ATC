# Pilots against a careless controller: the self-play scoreboard

Status: results, 11 November 2026. EGLL runways 27R,27L; EGLL runway 27L: 9 sessions of 45 simulated minutes, each played twice: once with only the game's AI controllers, once with an adversary adding mistakes. CPU only, 20 minutes. Run it again with `bash ml/selfplay/run.sh`.

## What was built today

Four ideas from the pilot-brain pitch are in the game now. None of them uses a trained model yet: they are rules read from the simulator's state, so they are exact and testable, and they produce the labelled data the learned pilot will train on.

| idea | what the pilots do now | where |
|---|---|---|
| Looking ahead | A crew cleared to land works out whether the runway will be clear when they get there. If not, they ask, at the clearance or on short final, before it becomes a go-around. A descent below the minimum safe altitude away from the field is questioned. | `src/lib/sim/pilotmind.ts` |
| Party line | Pilots hear the other clearances on their frequency and quote them: "we heard Speedbird 1 cleared to line up, confirm cleared to land?" A go-around for wind makes the next aircraft on that approach ask for a wind check. A line-up or a crossing in front of traffic on short final is questioned. Converging traffic is reported by the aircraft that has it ahead. | `src/lib/sim/pilotmind.ts` |
| Personalities | Every callsign has a crew for the whole flight: long-haul captain, line crew, new first officer, crew new to the airport, student pilot. It sets how fast they answer, how often they read back wrong, how many instructions they take in at once before "say again, slowly", hesitation in the wording and the pace of the voice. Stress (an emergency, go-arounds, low fuel, waiting) sharpens a captain and slows the others. | `src/lib/sim/persona.ts` |
| Self-play with an adversary | The AI controllers run the airport; an adversary makes a controller's mistakes on the same frequencies. Each mistake is a labelled example, and the run scores the pilots. | `ml/selfplay/` |

## The scoreboard

The adversary made **628** mistakes of 12 kinds; the pilots caught **627** (99.8 %). "Caught" means the pilot questioned or refused the instruction and nothing was executed.

Read the number with care: the adversary's mistakes and the pilots' rules were written by the same hand, so this measures that the rules work inside a busy, running airport and do not misfire. It does not measure mistakes nobody has thought of yet; those come from new mistake kinds and, later, from real players.

| the controller's mistake | made | caught | rate | caught by |
|---|---|---|---|---|
| level reversed | 96 | 96 | 100 % | memory (ledger) |
| heading reversed | 86 | 86 | 100 % | memory (ledger) |
| line up, traffic on short final | 6 | 6 | 100 % | look-ahead + party line |
| cross, traffic on short final | 0 | 0 | – | look-ahead + party line |
| cross, departure rolling | 0 | 0 | – | look-ahead + party line |
| cleared to land, runway occupied | 0 | 0 | – | look-ahead + party line |
| cleared to land, wrong runway | 23 | 23 | 100 % | aircraft state |
| takeoff, traffic on short final | 11 | 11 | 100 % | aircraft state |
| instruction for the wrong aircraft | 146 | 146 | 100 % | aircraft state |
| descent below a safe level | 88 | 88 | 100 % | look-ahead (added after run 1) |
| speed below what the aircraft can fly | 66 | 65 | 98.5 % | aircraft state |
| sent to the ground frequency in the air | 106 | 106 | 100 % | look-ahead (added after run 1) |

Not seen in this run (the situation did not come up while the adversary was looking): cross, traffic on short final; cross, departure rolling; cleared to land, runway occupied. They are covered by scripted story tests.

## Do the pilots talk too much?

With only the AI controllers working (6.8 hours, 134 movements, 7106 radio lines), every call the pilots made on their own initiative is a possible false alarm:

| call | count | per hour |
|---|---|---|
| "confirm cleared to land?" (runway not clear on arrival) | 0 | 0.0 |
| converging traffic | 0 | 0.0 |
| wind check after a go-around ahead | 0 | 0.0 |

Go-arounds: 4 with the good controller, 1 with the adversary (125 movements).

## Examples from the run

**level reversed** (visitor crew; the pilot knew: climb, 8400 ft, runway 27R | told: level FL110)

```
controller: AAL791 Altitude 6000
pilot:      American seven niner one, previously cleared to climb FL110, confirm now 6000?
```

**heading reversed** (line crew; the pilot knew: cruise, 7000 ft, runway 27R | told: heading 196)

```
controller: BAW401 Fly heading 016
pilot:      Speedbird four zero one, previously heading 196, confirm now heading 016?
```

**line up, traffic on short final** (line crew; the pilot knew: hold_short, holding short 27L, runway 27L)

```
controller: JBU892 Line up 27L
pilot:      JetBlue eight niner two, traffic on 2 mile final, confirm line up runway 27L?
```

**cleared to land, wrong runway** (rookie crew; the pilot knew: approach, 3000 ft, runway 27R, 10.8 NM final)

```
controller: BAW127 Cleared to land 27L
pilot:      Speedbird one two seven, we're established on 27R, confirm runway 27L?
```

**takeoff, traffic on short final** (line crew; the pilot knew: hold_short, holding short 27L, runway 27L)

```
controller: UAE769 Cleared for takeoff 27L
pilot:      Arrival BAW403 2.0 NM final
```

**instruction for the wrong aircraft** (rookie crew; the pilot knew: pushback, runway 27L)

```
controller: CPA510 Fly heading 180
pilot:      On the ground
```

**descent below a safe level** (visitor crew; the pilot knew: descent, 6900 ft, runway 27R, 12.0 NM final)

```
controller: BAW403 Altitude 1000
pilot:      Speedbird four zero tree, 13 miles out, minimum safe altitude 1500, confirm 1000 feet?
```

**speed below what the aircraft can fly** (rookie crew; the pilot knew: approach, 10000 ft, runway 27R, 14.1 NM final)

```
controller: BAW127 Speed 100
pilot:      Unable one zero zero knots, Speed 100 outside envelope 125-250 kt, Speedbird one two seven.
```

**sent to the ground frequency in the air** (rookie crew; the pilot knew: cruise, 7000 ft, runway 27R, 6.9 NM final)

```
controller: BAW127 Contact ground
pilot:      Speedbird one two seven, we're airborne, confirm contact Heathrow Ground?
```

## What the pilots still miss

Each miss is a rule to write or an example for the learned model:

**speed below what the aircraft can fly** (the pilot knew: descent, 8800 ft, runway 27R)

```
controller: IGO445 Speed 100
pilot:      Speed one zero zero knots, IFly four four fife.
```

The speed case is not a pilot error: the simulator refuses any speed below the aircraft type's minimum, so this type can fly 100 knots (IndiGo also flies ATR 72 turboprops). The adversary's rule was too coarse.

## What this is for

- **A quality bar.** The scoreboard runs on every change to the pilots, next to the story tests (20 today).
- **Training data.** `ml/data/selfplay/episodes.jsonl` holds every dialogue with the state the pilot knew. The learned pilot model (spec 13, phases 3 to 5) trains on millions of these; the adversary is what puts the rare, dangerous cases in.
- **Finding gaps.** New mistake kinds are a few lines each in `ml/selfplay/arena.ts`.

## Next

1. More mistake kinds: wrong callsign of a similar-sounding aircraft, forgotten aircraft, conflicting taxi routes, conditional clearances.
2. The adversary learns: it searches for the mistakes the pilots miss, instead of drawing them at random.
3. The same arena scores System 1 v2 (spec 12): the adversary speaks in free wording and through the speech models.
4. The learned pilot (wording and timing) trains on the episodes, with these rules as its safety net.
