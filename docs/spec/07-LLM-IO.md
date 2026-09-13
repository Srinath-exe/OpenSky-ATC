# 07 — LLM I/O: driving SkyControl with an edge model

The game exposes one contract for a language model (on-device / edge or hosted) to play a controller position, advise
the player, or learn from the player: **text in, text out**, on the same phraseology the command line already parses.

```
                 observation (text)                          command lines (text)
   SimEngine ──► buildObservation() ──► [system + user] ──► LLM ──► parseReply() ──► sim.command(line, {position, who:'LLM'})
                                                                                          │
                                                        comm log ◄── LLM line / SYS line ◄─┘   + score, readbacks, alerts as for a human
```

Everything lives in `src/lib/llm/`:

| file | role |
|---|---|
| `observe.ts` | `buildObservation(engine, {position, radio, lastActions})` → `{ text, …json }` — what the controller sees (§2) |
| `prompt.ts` | `systemPrompt(position)` (rules + grammar, §3) and `parseReply(text)` (§3.2) |
| `client.ts` | `LlmConfig`, `chatComplete()` — one OpenAI-compatible chat completion via the proxy or direct (§4) |
| `agent.ts` | `LlmAgent` — the cadence loop, control / advise, the I/O log + JSONL export (§5, §6) |
| `src/app/api/llm/chat/route.ts` | the server-side proxy (§4.1) |

Settings → **Edge LLM** (in-game settings modal) holds the config; it is persisted under `skycontrol_llm`, separate from
the game settings blob.

## 1. Modes

| mode | what happens |
|---|---|
| `off` | nothing |
| `advise` | every cadence the model's lines are posted to the comm log as `LLM ▸ …` suggestions for the position(s) chosen; the player decides |
| `control` | the lines are executed on those positions exactly as if typed there (frequency checks, pilot delay, readbacks, scoring — all apply). The position tabs show the AI dot. |

Positions are independent of the player's: the model can work GROUND while you work TOWER, or all three.

## 2. Observation (model input)

`buildObservation()` renders a deterministic block, ~600–1500 tokens with 10 aircraft. Example (GROUND):

```
SKYCONTROL KSFO · you are GROUND · sim 00:12:34
WX wind 290/12 kt · vis 10 km+ · FEW027 · QNH 1019 · ATIS A
RUNWAYS dep 28R,10L · arr 28L,28R · 28R FREE · 28L OCCUPIED (QTR427 landing) · 01R FREE
SCORE 120 · TRAFFIC 9 (air 4, ground 5)
TAXIWAYS A A1 B B1 C … (first call only)

REQUESTS ON GROUND (1) — answer each, or STANDBY:
- AFR851: "San Francisco Intl Ground, Air France eight fifty-one, stand Foxtrot one eight, request pushback, information Alpha." (22s) · answers: PUSHBACK APPROVED | STANDBY | UNABLE

AIRCRAFT ON GROUND (3)
- AFR851 B752/M DEP · Parked at stand, engines off · stand F18 · rwy 28L · hdg 040 · 0 kt · REQUEST pushback (22s) · can: PUSHBACK APPROVED · STANDBY · UNABLE
- DLH553 B752/M DEP · Taxiing to the holding point · rwy 28L · via A B · hdg 275 · 15 kt · can: HOLD SHORT <rwy|twy> · HOLD POSITION · CONTACT TOWER
- QTR427 A359/H ARR · Landed, rolling out · rwy 28R · hdg 284 · 60 kt · can: TAXI STAND <stand> [VIA <twys>]

OTHER TRAFFIC (2, not on your frequency — do not instruct)
- BAW285 A388/J ARR · Established on the ILS · 1400 ft · 145 kt · hdg 284 · 4.2 NM out, bearing 104 from the field · 4.1 NM to threshold 28L · on TOWER

ALERTS (0)

RECENT RADIO (last 6)
- [00:12:10] PILOT AFR851: …
YOUR LAST ACTIONS
- "DLH553 TAXI 28L VIA A B" → OK: Holding point runway 28L via A B, Lufthansa 553
- "QTR427 CONTACT GROUND" → REJECTED: not on your frequency
```

Rules of the format:

* aircraft **on the position's frequency** carry `can:` — the actions the command tree enables right now (same matrix
  as the click UI); the model is told to pick from those. Other traffic is listed for awareness only.
* headings are **magnetic**, altitudes feet, speeds knots, distances NM; the sim clock is `hh:mm:ss`.
* `REQUESTS` repeats the open pilot requests with their canonical answers; `YOUR LAST ACTIONS` feeds the outcome of the
  model's previous lines back (readback on success, the rejection reason otherwise) so it can correct itself.
* the taxiway (ground/tower) or fix (approach) vocabulary is sent on the first call per position.

The same facts are available as JSON (`Observation`) for tool-calling or non-text integrations.

## 3. Reply (model output)

### 3.1 Contract
One command per line, `CALLSIGN instruction`, in the typed phraseology (the grammar in `systemPrompt()`), or `NOOP`.
No prose. Multiple instructions to one aircraft join with `THEN`.

```
AFR851 PUSHBACK APPROVED
DLH553 CONTACT TOWER
UAL9 HDG 180 THEN DESCEND 6000
```

### 3.2 Parsing
`parseReply()` strips code fences, bullets, numbering and quotes, upper-cases, keeps lines that start with a
callsign-shaped token followed by text, drops `NOOP` / prose, dedupes, caps at 12 lines. Each surviving line goes
through the ordinary parser (`executeText`) — a line the parser rejects becomes a `SYS` error line in the comm log and a
`REJECTED: <reason>` entry in the next observation. Nothing bypasses the engine's checks.

## 4. Transport

`chatComplete(cfg, messages)` posts an OpenAI-style chat completion `{ model, messages, temperature, max_tokens }` and
reads `choices[0].message.content`. Works unchanged against Ollama (`http://127.0.0.1:11434/v1`), llama.cpp server,
vLLM, LM Studio, or a hosted API.

### 4.1 Proxy `/api/llm/chat` (default)
The browser posts to the game server, which forwards to the upstream (`LLM_BASE_URL`, default Ollama on the same host)
with `LLM_API_KEY`. Advantages: no CORS, the key stays on the server, one place to point at the edge box. A request may
name its own `endpoint` only for localhost / private-LAN hosts or hosts listed in `LLM_ALLOW_HOSTS` (comma separated,
`*` = any) — the proxy is not an open relay. `GET /api/llm/chat?probe=1` lists the upstream's models (the "Test
connection" button).

Environment (server): `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` (default model when the client sends none), `LLM_ALLOW_HOSTS`.

### 4.2 Direct
Settings → "Call the endpoint from the browser": the browser calls `<endpoint>/chat/completions` itself (the server
must allow CORS, e.g. `OLLAMA_ORIGINS=*`). Use it for an in-browser model served on localhost.

## 5. Agent loop

`LlmAgent` runs on a 1 s wall-clock timer while the mode is not `off`. Per worked position it calls the model every
`intervalS` seconds (4–30), and sooner (≥ 2.5 s apart) when the set of open requests or active alerts changes. One call
in flight at a time; paused sim = no calls. Each call: observation → completion → lines → execute / suggest → outcomes
remembered for the next observation. Status (calls, latency, tokens, last error, last reply) is shown in the settings
modal and available as `sim.llmStatus()`.

Test hook: `window.__atcSim.llmAgent.tick('ground')` forces one call for a position (used by the E2E test with a mocked
endpoint); `window.__atcSim.updateLlm({...})` sets the config.

## 6. Recording I/O for training

"Record I/O for training" logs every model call and — with the observation the model would have seen at that moment —
every command the **player** issues (typed or by clicks), with the outcome. "Export JSONL" downloads one line per record:

```json
{"meta":{"t":754,"wall":1789336719546,"icao":"KSFO","position":"ground","source":"player","ms":null,"model":null,"outcomes":[{"line":"AFR851 PUSHBACK APPROVED","ok":true,"note":"Pushback approved, Air France 851"}]},
 "messages":[{"role":"system","content":"You are an air traffic controller…"},{"role":"user","content":"SKYCONTROL KSFO · you are GROUND …"},{"role":"assistant","content":"AFR851 PUSHBACK APPROVED"}]}
```

That is the standard chat-format sample: play a shift, export, filter on `meta.outcomes[].ok`, fine-tune the edge
model on the accepted samples. The log keeps the last 4000 records in memory (not persisted across reloads).

## 7. Running it with a local model

```bash
ollama pull qwen2.5:3b            # any instruct model; 3B runs on a laptop
OLLAMA_HOST=127.0.0.1:11434 ollama serve
LLM_BASE_URL=http://127.0.0.1:11434/v1 LLM_MODEL=qwen2.5:3b node .next/standalone/server.js   # or next dev
```
In the game: Settings → Edge LLM → Test connection → Mode: Advise (or Control) → pick positions. Watch the comm log:
`LLM ▸ …` lines are advice, `LLM` lines are executed transmissions.
