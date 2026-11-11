# The pilot brain: pilots that think, remember and speak up

Status: plan, 11 November 2026. The umbrella for the voice work: spec 12 (System 1 v2) becomes its "understanding" part.
Owner decisions are listed at the end.

## 1. What the owner wants

Pilots that behave like real pilots, not a command parser:

- **Whole-flight memory.** Every aircraft lives one story, stand to runway or runway to stand, and remembers everything
  the controller told it on the way.
- **Consistency.** When a new instruction contradicts an earlier one, the pilot asks: "previously you cleared us to
  flight level 80, confirm now 6,000 feet?"
- **Initiative.** Pilots call the controller themselves when the situation calls for it: traffic converging, a runway
  that is still occupied, waiting too long at a hold, an instruction they cannot follow, a problem on board.
- **Understanding of the whole airport.** What is landing, what is taking off, who is taxiing where, and how the pieces
  fit together.
- **Natural speech.** Correct phraseology, but varied and human, never robotic.
- **Flawless sync.** Everything said matches the game exactly; nothing is invented.

## 2. What the game already has

The simulator (`src/lib/sim`, about 7,400 lines) already models most of the world:

| piece | where | what |
|---|---|---|
| flight phases | `stage.ts`, `engine.ts` | stand, start-up, pushback, taxi, hold short, line-up, takeoff, climb, approach, landing, vacate, taxi in |
| pilot-initiated calls | `PilotRequest`, 22 kinds | clearance, pushback, start-up, taxi, cross, ready, with you, higher, lower, direct, hold, taxi in, say again, radio check, cancel mayday, return to stand, wind check, confirm cleared, further, intersection, runway vacated, going around; requests expire when unanswered |
| readbacks | `phraseology.ts readback()` | full readbacks, deliberate wrong readbacks (`wrongReadback`) that the player must catch, "unable" with reasons |
| alerts | `alerts.ts` | short-term conflict (60 s look-ahead), minimum safe altitude, runway incursion, wake on final, ground conflict, delays, unanswered requests |
| emergencies | `emergencies.ts` | emergency types, souls and fuel queries |
| AI controllers | auto mode | full-auto play, used to generate data |

What is missing is **judgement and language**: a record of what each pilot was told, pilots reacting to the situation and
not only to a timer, questions when instructions conflict, and speech that is not a fixed template.

## 3. Principles (how it stays flawless)

1. **The simulator is the single source of truth.** No model owns state. Models propose; the simulator decides.
2. **Every spoken fact comes from state.** Numbers, callsigns, runways and fixes are copied from the game, never
   generated freely; every pilot line is re-parsed by the game and must match what the pilot is actually doing.
3. **Safety-critical triggers are deterministic.** Converging traffic, an occupied runway, a contradiction: detected by
   code that can be tested, so they never depend on a model's mood. Models decide *how* and *when* to say it.
4. **Everything is tested as stories.** Each behaviour is a scripted scenario with an expected outcome, run on every
   change (§7).

## 4. Architecture

```
            ┌──────────── the simulator (truth) ────────────┐
 controller │  aircraft, runways, traffic, phases, alerts   │
 speech ──► │  + NEW clearance ledger per aircraft          │
            └───────┬───────────────────────────┬───────────┘
                    │ state + ledger            │ state changes
     ┌──────────────▼─────────────┐   ┌─────────▼──────────────────┐
     │ understanding (System 1 v2) │   │ situation monitor           │
     │ speech → command(s), with   │   │ detects concerns: conflicts,│
     │ the ledger and the dialogue │   │ contradictions, waiting,    │
     │ as context (spec 12)        │   │ impossible instructions     │
     └──────────────┬─────────────┘   └─────────┬──────────────────┘
                    └──────────┐   ┌────────────┘
                         ┌─────▼───▼─────┐
                         │ pilot policy   │  what to say, when, in what order
                         └───────┬───────┘
                         ┌───────▼───────┐
                         │ pilot voice    │  intent → words (phraseology, persona)
                         └───────┬───────┘
                                 ▼
                 text-to-speech (per-pilot neural voice) ──► radio
          unusual conversation ──► language model (System 2), grounded in the same state
```

**4.1 Clearance ledger (new, deterministic).** Per aircraft: every instruction with time, the readback, and its status
(issued, read back, executing, completed, superseded, cancelled), plus the clearance limit (where it must stop and wait).
It answers "what was this aircraft told, and is it still valid?" The pilot's memory is this ledger, so it can never
disagree with the game.

**4.2 Contradiction rules (deterministic).** A new instruction is checked against the ledger and the state. Examples:
a new level without "correction" while another level is being flown; cleared to cross a runway the aircraft was told to
hold short of, without cancelling the hold; a heading while flying direct to a fix; cleared for takeoff while not lined
up; cleared to land with traffic still on the runway. The pilot then asks for confirmation, quoting the earlier
instruction, and does not act until it is resolved.

**4.3 Situation monitor (deterministic, then learned scoring).** Turns state changes into pilot concerns, building on
`alerts.ts`: traffic converging (a TCAS-like call: "traffic, we have it in sight" or "TCAS climb"); runway occupied on
short final; taxi conflict ahead ("stopping, aircraft crossing ahead"); waiting at a clearance limit too long; an
instruction the aircraft physically cannot follow ("unable, we need 2,000 metres"); a missed frequency change; low fuel,
weather, technical problems. Each concern has an urgency.

**4.4 Pilot policy (learned).** Given this aircraft's state, its ledger, the concerns and the recent dialogue on the
frequency: whether to speak, what to say (readback, confirm, query, request, report, unable, alert, or stay quiet), and
when. Radio etiquette is part of the job: one speaker at a time, urgent calls first, no chatter, a reminder only after a
sensible wait.

**4.5 Pilot voice (learned, with exact phraseology).** Intent → transmission. Safety-critical parts (readbacks of
levels, headings, runways, frequencies) follow exact phraseology from templates; the wording around them varies with a
persona per aircraft (airline, experience, verbosity; the neural voice per callsign already exists). A small generative
model adds the variety; every line is re-parsed by the game (§3.2).

**4.6 Understanding with context (System 1 v2, spec 12).** The controller's speech is read with the aircraft's ledger
and the last transmissions in the input, so references work: "correction", "disregard", "as before", "continue as
cleared", conditional clearances ("behind the landing A320, line up and wait"), several commands in one call.

**4.7 Open conversation (System 2).** Questions and unusual requests in both directions go to a language model that
sees the same state and ledger; whatever it proposes as a command is checked by the game's parser; what it says is
grounded in state (§3.2).

## 5. Stories

Each flight follows a story with expected calls and possible deviations.

- **Departure:** clearance delivery → start-up → pushback → taxi (holds, crossings, give way) → holding point →
  line-up → takeoff → departure handoff. Deviations: delays, start-up failure, a stand blocked, a runway change, a
  rejected takeoff.
- **Arrival:** first call → descents and vectors → approach clearance → tower → landing → vacate → taxi in → on stand.
  Deviations: holding, a runway change, a go-around, a missed approach, an emergency.

The story is the frame the pilot policy works in: the pilot knows what comes next ("ready for departure" only when at
the holding point) and what is overdue ("still waiting for pushback").

## 6. How the models learn

**6.1 Episode generator.** The headless simulator with its AI controllers already plays whole sessions. It is extended
to record **episodes**: full multi-turn dialogues (controller ↔ pilots) with the state at every transmission, across
every airport, position and traffic level. Scripted perturbations put in what a perfect controller would never do, so
the pilots learn to react: contradictory instructions, a landing clearance onto an occupied runway, forgotten aircraft,
wrong frequencies, conflicts. Target: millions of transmissions, a few hours of CPU per million.

**6.2 Labels.** The deterministic layers (ledger, contradiction rules, monitor) label what a correct pilot must notice;
the phraseology layer labels the exact readback; a strong language model (teacher) rewrites wordings for variety, and
every rewrite must re-parse to the same meaning.

**6.3 Models.**
- *Understanding:* System 1 v2 (spec 12) with ledger and dialogue context in its input.
- *Pilot policy and voice:* one small sequence model (10–50 M parameters) that runs in the browser and on the phone:
  input = compact state of this aircraft and its neighbours + ledger + concerns + recent dialogue; output = intent and
  the transmission, with numbers and names filled from state (slot copying, never free generation).
- Training: supervised on the episodes, then **reinforcement learning inside the simulator**: rewards for safety (a
  concern that needed a call was called), correctness (the readback matches), restraint (no needless chatter, good
  timing), consistency (never contradicting the ledger); a language-model judge scores naturalness on samples.

## 7. Story tests (the quality bar)

A fixed suite of scripted scenarios, each with an expected outcome, checked automatically on every change. Examples:

1. Climb to flight level 80, then "descend 6,000 feet" without "correction": the pilot asks which.
2. Cleared to land while an aircraft is still on the runway: the pilot queries, or goes around if not answered.
3. Two aircraft converging on a taxiway: one stops and reports.
4. Holding short for more than three minutes with no word: the pilot reminds the controller.
5. A wrong readback, the controller corrects it: the pilot reads back the correction and executes it.
6. "Disregard" after an instruction: the pilot keeps the previous clearance.
7. A full departure story with a perfect controller: exactly the expected calls, no extras.
8. A full arrival with a go-around: the go-around call, the missed approach, the re-sequence.

Scores: scenario pass rate; contradictions with the ledger (**must be zero**); false alarms per hour (chatter);
calls missed when needed; latency per call.

## 8. Phases

| phase | work | models | what the owner sees |
|---|---|---|---|
| 1. Memory and judgement | clearance ledger, contradiction rules, situation monitor v1, new pilot calls (confirm, traffic, stopping, waiting, unable with reasons), story tests | none | pilots that remember, question conflicting instructions and speak up; the game feels alive |
| 2. Understanding with context | System 1 v2 (spec 12) with the ledger and dialogue in its input | System 1 v2 | own words, references, several commands at once |
| 3. Episodes | the episode generator, perturbations, labels | – | millions of training dialogues |
| 4. Pilot voice | the small model for wording and persona, on device | pilot model | varied, human pilots; same safety |
| 5. Pilot policy | learned timing and choice, RL in the simulator | pilot model | pilots with judgement, not rules |
| 6. Open conversation | System 2 for questions and unusual requests, grounded | language model | talk to pilots about anything |
| 7. Flywheel | opt-in logging of real play, weekly retraining | all | it keeps getting better |

Phase 1 needs no training and makes the biggest visible difference, so it comes first.

## 9. Cost

Phase 1 is engineering only. Phases 2–5: GPU about 15–25 hours in total, about $10–25 on spot instances; the paraphrase
and wording teacher about $20–60 with a commercial language model API. Phase 6 runs per call, on a cloud API or our own
GPU server.

## 10. Risks

- A pilot that talks too much is worse than one that talks too little: chatter is a tracked metric with a ceiling.
- Learned wording can drift from phraseology: safety-critical parts stay templated and every line is re-parsed.
- Episodes from AI controllers can be too clean: perturbations and, later, real players' sessions fix that.
- A pilot model on the phone has a latency and size budget: 10–50 M parameters, measured like the speech models.

## 11. Decisions for the owner

1. Start with phase 1 (no training): ledger, contradiction questions, situation calls, story tests.
2. The teacher for wording and paraphrases: a commercial language model API or our own models.
3. The GPU budget for phases 2–5: about $10–25 on spot.
4. Opt-in logging of real play for the flywheel.
5. Open conversation (phase 6): cloud API per call, or our own model on a GPU server.
