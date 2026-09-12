/*
  Game page object (`/play`, src/app/play/page.tsx + src/game/*). Test ids follow the CODE (UX 04 §10 / §G12
  naming), not the legacy table in 05 §3.1 — the full list is in tests/e2e/testids.txt. The ones used here:

    page-atc[data-ready] · game-shell[data-mode|data-paused|data-has-panel] · load-overlay · view-{ground|radar}
    Nav:      brand-home, airport-badge, position-tabs, mode-tab-{ground|tower|approach} (aria-selected + aria-pressed),
              atis-chip, wind, clock, clock-utc, rate-pause[data-state=paused|running], rate-1x/2x/4x (aria-pressed),
              rate-ff, score-chip, score[data-value], score-hi, alerts-bell[data-count], settings-btn, help-btn
    Strips:   strip-bay, bay-total[data-value], bay-collapse, bay-search, bay-filter-{id}, strip-bay-{BAY}, bay-count-{BAY},
              strip-{CS}[data-stage|data-phase|data-kind|data-selected], strip-cs, strip-phase[data-stage], strip-alt[data-value],
              strip-spd, strip-hdg, strip-{CS}-runway, strip-{CS}-req, strip-{CS}-alert, strip-{CS}-pending, strip-{CS}-box-{key}
    Panel:    detail-panel[data-callsign|data-stage|data-kind|data-draft|data-conflict|data-emergency], detail-callsign,
              badge-kind[data-kind], detail-sub, panel-wake, panel-stage[data-stage], panel-phase-chip[data-phase],
              panel-runway, panel-stand, panel-pending, panel-view-in-{pos}, panel-locate, panel-pin, detail-close,
              panel-req-band, panel-req-answer / -unable / -standby, panel-emerg-band, panel-quick-row, quick-{actionId},
              panel-actions, {actionId} (e.g. action-heading — data-state|data-reason|data-hotkey), btn-cancel, btn-undo,
              panel-result[data-status|data-code|data-action], panel-result-tx, panel-result-rb, panel-result-status
    Stepper:  stepper-{actionId}[data-step|data-step-type], stepper, step-title, step-{i} (crumbs), step-next, step-back,
              picker-runway / picker-runway-{RWY} / picker-runway-mode-{ils|loc|visual},
              picker-route / picker-route-auto / picker-route-clear / picker-route-input / picker-route-twy-{T} /
                picker-route-holdshort / picker-route-holdshort-{RWY} / picker-route-cross / picker-route-cross-{RWY},
              picker-heading / picker-heading-input / picker-heading-left|right|shortest / picker-heading-dial(-svg),
              picker-altitude / picker-alt-ladder(-svg, -value, -step-{q}) / picker-alt-input / picker-alt-expedite,
              picker-speed / picker-speed-ladder(-svg, -step-{q}) / picker-speed-chip-{k} / picker-speed-final / picker-speed-resume,
              picker-fix-{FIX} / picker-fix-search, picker-hold, picker-direction / picker-dir-left|right|N|E|S|W|any,
              picker-taxiway-{T}, picker-gate-{REF}, picker-aircraft-{CS}, picker-position-{POS},
              confirm-step, confirm-summary, confirm-transmit[data-state], btn-transmit, confirm-transmit-anyway,
              confirm-blocked-reason[data-reason], confirm-warning-{i}, confirm-add-part
    Comm log: comm-log, log-filter-{gnd|twr|app|all}, radio-log, radio-line[data-who|data-key|data-callsign|data-status],
              radio-text, cmd-form, cmd-input, cmd-send, cmd-parse-error, cmd-review, cmd-autocomplete-{n}, log-collapse
    Misc:     toast-host, toast-{kind}, alert-stack, alert-{id}, paused-pill, pause-menu, help-overlay, settings-modal,
              map-tool-*, radar-tool-*, ground-map, ground-overlay, radar-canvas, map-tooltip
*/
import { expect, type Locator, type Page } from '@playwright/test';
import { SimApi, type PlayerPosition } from '../fixtures/simApi';

export interface GameGotoOptions {
  icao?: string;
  seed?: number;
  spawn?: 'none' | 'default';
  position?: PlayerPosition;
  /** default true — `?test=1` (deterministic, __atcTest installed, no RAF). */
  test?: boolean;
  /** Wait for the MapLibre ground map to finish loading too (GROUND / TOWER only). Default false. */
  waitMap?: boolean;
}

export type RadioWho = 'ATC' | 'PILOT' | 'SYS' | 'AI';
export interface RadioRow { who: RadioWho; text: string; callsign: string | null; key: number; status: string | null }
export interface ToastRow { kind: string; text: string }
export type StepperSpeedTarget = number | 'final' | 'resume';

/** Named hotkeys the shell dispatcher understands (src/game/hotkeys.ts). */
export type ShellHotkey =
  | 'F1' | 'F2' | 'F3' | 'F4' | 'F8' | 'F9' | 'F10' | 'Space' | 'Escape' | 'Enter' | 'Tab' | 'Shift+Tab'
  | '1' | '2' | '4' | ',' | '.' | '[' | ']' | '/' | '?' | 'U' | 'Control+k' | 'Control+z' | 'Alt+f' | 'Shift+r'
  | (string & {});

export class GamePage {
  readonly sim: SimApi;
  constructor(readonly page: Page) { this.sim = new SimApi(page); }

  // ── roots ────────────────────────────────────────────────────────────────
  root = () => this.page.getByTestId('page-atc');
  shell = () => this.page.getByTestId('game-shell');
  loadOverlay = () => this.page.getByTestId('load-overlay');
  loadError = () => this.page.getByTestId('loading-error');
  view = (v: 'ground' | 'radar') => this.page.getByTestId(`view-${v}`);
  groundMap = () => this.page.getByTestId('ground-map');
  groundOverlay = () => this.page.getByTestId('ground-overlay');
  radarCanvas = () => this.page.getByTestId('radar-canvas');

  // ── nav bar ──────────────────────────────────────────────────────────────
  brand = () => this.page.getByTestId('brand-home');
  airportBadge = () => this.page.getByTestId('airport-badge');
  modeTab = (p: PlayerPosition) => this.page.getByTestId(`mode-tab-${p}`);
  atisChip = () => this.page.getByTestId('atis-chip');
  wind = () => this.page.getByTestId('wind');
  clock = () => this.page.getByTestId('clock');
  pauseBtn = () => this.page.getByTestId('rate-pause');
  rateBtn = (r: 1 | 2 | 4) => this.page.getByTestId(`rate-${r}x`);
  score = () => this.page.getByTestId('score');
  scoreHi = () => this.page.getByTestId('score-hi');
  alertsBell = () => this.page.getByTestId('alerts-bell');
  settingsBtn = () => this.page.getByTestId('settings-btn');
  helpBtn = () => this.page.getByTestId('help-btn');
  pausedPill = () => this.page.getByTestId('paused-pill');

  // ── strip bay ────────────────────────────────────────────────────────────
  stripBay = () => this.page.getByTestId('strip-bay');
  bayTotal = () => this.page.getByTestId('bay-total');
  /** Every aircraft strip card (root has role=option, data-id, data-stage, data-phase, data-kind, data-bay, data-selected). */
  strips = () => this.page.locator('[role="option"][data-testid^="strip-"][data-id]');
  strip = (cs: string) => this.page.getByTestId(`strip-${cs}`);
  stripPhase = (cs: string) => this.strip(cs).getByTestId('strip-phase');
  stripAlt = (cs: string) => this.strip(cs).getByTestId('strip-alt');
  stripRunway = (cs: string) => this.page.getByTestId(`strip-${cs}-runway`);
  stripReq = (cs: string) => this.page.getByTestId(`strip-${cs}-req`);
  bay = (bayId: string) => this.page.getByTestId(`strip-bay-${bayId}`);

  // ── command panel ────────────────────────────────────────────────────────
  panel = () => this.page.getByTestId('detail-panel');
  panelEmpty = () => this.page.getByTestId('detail-empty');
  panelCallsign = () => this.page.getByTestId('detail-callsign');
  panelClose = () => this.page.getByTestId('detail-close');
  panelStage = () => this.page.getByTestId('panel-stage');
  panelKind = () => this.page.getByTestId('badge-kind');
  panelRunway = () => this.page.getByTestId('panel-runway');
  panelStand = () => this.page.getByTestId('panel-stand');
  panelPending = () => this.page.getByTestId('panel-pending');
  panelActions = () => this.page.getByTestId('panel-actions');
  quickRow = () => this.page.getByTestId('panel-quick-row');
  quickBtn = (actionId: string) => this.page.getByTestId(`quick-${actionId}`);
  actionBtn = (actionId: string) => this.page.getByTestId(actionId);
  reqBand = () => this.page.getByTestId('panel-req-band');
  reqAnswer = () => this.page.getByTestId('panel-req-answer');
  reqUnable = () => this.page.getByTestId('panel-req-unable');
  reqStandby = () => this.page.getByTestId('panel-req-standby');
  metric = (k: 'alt' | 'spd' | 'hdg') => this.page.getByTestId(`metric-${k}`);
  metricTarget = (k: 'alt' | 'spd' | 'hdg') => this.page.getByTestId(`metric-${k}-target`);
  result = () => this.page.getByTestId('panel-result');
  resultTx = () => this.page.getByTestId('panel-result-tx');
  resultRb = () => this.page.getByTestId('panel-result-rb');
  undoChip = () => this.page.getByTestId('btn-undo');
  cancelBtn = () => this.page.getByTestId('btn-cancel');

  // ── stepper ──────────────────────────────────────────────────────────────
  stepper = () => this.page.locator('[data-testid^="stepper-"][data-step]');
  stepperFor = (actionId: string) => this.page.getByTestId(`stepper-${actionId}`);
  stepNext = () => this.page.getByTestId('step-next');
  stepBack = () => this.page.getByTestId('step-back');
  confirmStep = () => this.page.getByTestId('confirm-step');
  confirmSummary = () => this.page.getByTestId('confirm-summary');
  transmitBtn = () => this.page.getByTestId('btn-transmit');
  transmitAnyway = () => this.page.getByTestId('confirm-transmit-anyway');
  blockedReason = () => this.page.getByTestId('confirm-blocked-reason');
  picker = (type: 'runway' | 'route' | 'heading' | 'altitude' | 'speed' | 'direction' | 'hold' | 'gate' | 'aircraft' | 'position' | 'text' | 'vehicle') => this.page.getByTestId(`picker-${type}`);

  // ── comm log ─────────────────────────────────────────────────────────────
  commLog = () => this.page.getByTestId('comm-log');
  radioLog = () => this.page.getByTestId('radio-log');
  radioLines = (who?: RadioWho) => (who ? this.page.locator(`[data-testid="radio-line"][data-who="${who}"]`) : this.page.getByTestId('radio-line'));
  cmdInput = () => this.page.getByTestId('cmd-input');
  cmdSend = () => this.page.getByTestId('cmd-send');
  cmdParseError = () => this.page.getByTestId('cmd-parse-error');
  cmdReview = () => this.page.getByTestId('cmd-review');
  logFilter = (f: 'gnd' | 'twr' | 'app' | 'all') => this.page.getByTestId(`log-filter-${f}`);

  // ── ATIS / runway config (AtisWeather.tsx, RunwayConfigDialog.tsx) ───────
  atisPanel = () => this.page.getByTestId('atis-panel');
  atisLetter = () => this.page.getByTestId('atis-letter');
  atisRunwayStatus = (rwy: string) => this.page.getByTestId(`atis-runway-${rwy}-status`);
  atisRunwayStatusOption = (rwy: string, o: 'open' | 'close' | 'sterile' | 'inspect') => this.page.getByTestId(`atis-runway-${rwy}-${o}`);
  atisDep = (rwy: string) => this.page.getByTestId(`atis-dep-${rwy}`);
  atisArr = (rwy: string) => this.page.getByTestId(`atis-arr-${rwy}`);
  runwayConfigDialog = () => this.page.getByTestId('airport-dialog');
  rwycfgEnd = (rwy: string, role: 'dep' | 'arr') => this.page.getByTestId(`rwycfg-end-${rwy}-${role}`);
  rwycfgWeight = (rwy: string, w: 'L' | 'M' | 'H' | 'S') => this.page.getByTestId(`rwycfg-end-${rwy}-weight-${w}`);
  rwycfgApply = () => this.page.getByTestId('rwycfg-apply');
  rwycfgCancel = () => this.page.getByTestId('rwycfg-cancel');
  rwycfgBlockedReason = () => this.page.getByTestId('rwycfg-blocked-reason');

  // ── toasts / alerts / overlays ───────────────────────────────────────────
  toastHost = () => this.page.getByTestId('toast-host');
  toasts = () => this.toastHost().locator('[data-testid^="toast-"][data-kind]');
  toast = (kind: 'info' | 'success' | 'attention' | 'error' | string) => this.toastHost().getByTestId(`toast-${kind}`);
  alertStack = () => this.page.getByTestId('alert-stack');
  pauseMenu = () => this.page.getByTestId('pause-menu');
  helpOverlay = () => this.page.getByTestId('help-overlay');
  settingsModal = () => this.page.getByTestId('settings-modal');
  mapTooltip = () => this.page.getByTestId('map-tooltip');
  /** The top nav (`data-escalated` = an unacked critical alert older than 10 s). */
  topBar = () => this.page.locator('nav[aria-label="Top bar"]');

  // ── alert stack (src/game/AlertStack/AlertStack.tsx) ─────────────────────
  //  Stack cards are keyed by ALERT id (`toast-{alertId}` — not the ToastHost `toast-{kind}` ids above):
  //    toast-{id}[data-severity|data-kind] > (stca-alert | emergency-banner-{cs}) > alert-{id}
  //    toast-{id}-ack / -select / -locate / -mute / -pair-{subject}; acked cards collapse into alert-pill-{id};
  //    alert-resolved-{id} pills show for 3 s (wall clock); toast-overflow when more than 3 are unacked.
  //  Auto-dismiss is WALL-CLOCK (info 6 s, warning 12 s, critical never) and only hides the card — the alert stays active.
  alertCard = (id: string) => this.page.getByTestId(`toast-${id}`);
  alertCards = () => this.alertStack().locator('[data-testid^="toast-al"][data-severity]');
  alertCardAck = (id: string) => this.page.getByTestId(`toast-${id}-ack`);
  alertCardSelect = (id: string) => this.page.getByTestId(`toast-${id}-select`);
  alertCardLocate = (id: string) => this.page.getByTestId(`toast-${id}-locate`);
  alertCardMute = (id: string) => this.page.getByTestId(`toast-${id}-mute`);
  alertCardPair = (id: string, subject: string) => this.page.getByTestId(`toast-${id}-pair-${subject}`);
  alertItem = (id: string) => this.page.getByTestId(`alert-${id}`);
  alertPill = (id: string) => this.page.getByTestId(`alert-pill-${id}`);
  alertResolvedPill = (id: string) => this.page.getByTestId(`alert-resolved-${id}`);
  alertOverflow = () => this.page.getByTestId('toast-overflow');
  stcaAlert = () => this.page.getByTestId('stca-alert');
  emergencyBanner = (cs: string) => this.page.getByTestId(`emergency-banner-${cs}`);
  /** `alerts-bell[data-count]` = unacknowledged non-info alerts. */
  async bellCount(): Promise<number> { return Number((await this.alertsBell().getAttribute('data-count')) ?? '0'); }
  /** Click ACK on a stack card and wait for it to leave the stack. */
  async ackFromStack(id: string): Promise<void> {
    await this.alertCardAck(id).click();
    await expect(this.alertCard(id)).toHaveCount(0);
  }

  // ── alerts drawer (bell) — `alertsDrawer` / `alertsDrawerClose` / `alertsRow` / `alertsRows` / `alertsEmpty` live in the nav-chrome section ─
  /** `alerts-row-{id}-state[data-state=active|acked|resolved]` */
  alertsRowState = (id: string) => this.page.getByTestId(`alerts-row-${id}-state`);
  alertsRowScore = (id: string) => this.page.getByTestId(`alerts-row-${id}-score`);
  alertsFilter = (f: 'critical' | 'warning' | 'info') => this.page.getByTestId(`alerts-filter-${f}`);
  alertsClearResolved = () => this.page.getByTestId('alerts-clear-resolved');
  async openAlertsDrawer(): Promise<void> {
    if (await this.alertsDrawer().count()) return;
    await this.alertsBell().click();
    await expect(this.alertsDrawer()).toBeVisible();
  }
  async closeAlertsDrawer(): Promise<void> {
    await this.alertsDrawerClose().click();
    await expect(this.alertsDrawer()).toHaveCount(0);
  }

  // ── command-panel alert banner + emergency band ──────────────────────────
  panelAlertBanner = () => this.page.getByTestId('panel-alert-banner');
  panelAlertGeometry = () => this.page.getByTestId('panel-alert-geometry');
  panelAlertAck = () => this.page.getByTestId('panel-alert-ack');
  panelAlertPair = (cs: string) => this.page.getByTestId(`panel-alert-pair-${cs}`);
  /** `panel-emerg-band[data-level=MAYDAY|PAN][data-type][data-status]` */
  emergBand = () => this.page.getByTestId('panel-emerg-band');
  emergBandToggle = () => this.page.getByTestId('panel-emerg-toggle');
  emergBandPob = () => this.page.getByTestId('emerg-band-pob');
  emergBandFuel = () => this.page.getByTestId('emerg-band-fuel');
  emergBandStatus = () => this.page.getByTestId('emerg-band-status');
  emergChecklist = () => this.page.getByTestId('panel-emerg-checklist');
  /** `emerg-check-{item}[data-done=true|false]` — item with `_` -> `-` (souls_fuel -> souls-fuel). */
  emergCheck = (item: string) => this.page.getByTestId(`emerg-check-${item.replace(/_/g, '-')}`);
  /** Strip emergency band `strip-{cs}-emerg[data-level]` */
  stripEmerg = (cs: string) => this.page.getByTestId(`strip-${cs}-emerg`);
  stripAlert = (cs: string) => this.page.getByTestId(`strip-${cs}-alert`);
  /** Text-picker chip (`picker-info-pob`, `picker-emerg-sterile`, `picker-emerg-location-aircraft` ...): click + aria-pressed. */
  async pickChip(testId: string, on = true): Promise<void> {
    const chip = this.page.getByTestId(testId);
    if ((await chip.getAttribute('aria-pressed')) === String(on)) return;
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', String(on));
  }
  /** Vehicle-picker card (`picker-vehicle-{ID}`): toggle to the wanted state. */
  async pickVehicle(id: string, on = true): Promise<void> {
    const card = this.page.getByTestId(`picker-vehicle-${id}`);
    if ((await card.getAttribute('aria-pressed')) === String(on)) return;
    await card.click();
    await expect(card).toHaveAttribute('aria-pressed', String(on));
  }

  // ── vehicles panel (src/game/VehiclePanel/VehiclePanel.tsx; GROUND / TOWER only) ─
  vehiclesToolBtn = () => this.page.getByTestId('map-tool-vehicles');
  vehiclesPanel = () => this.page.getByTestId('vehicle-panel');
  vehiclesPanelClose = () => this.page.getByTestId('veh-panel-close');
  /** `veh-emergency[data-callsign]` block with the quick-dispatch buttons. */
  vehEmergency = () => this.page.getByTestId('veh-emergency');
  arffDispatchBtn = () => this.page.getByTestId('btn-arff-dispatch');
  ambulanceDispatchBtn = () => this.page.getByTestId('btn-ambulance-dispatch');
  /** `veh-result[data-ok=true|false]` */
  vehResult = () => this.page.getByTestId('veh-result');
  vehFlow = () => this.page.getByTestId('veh-flow');
  vehNext = () => this.page.getByTestId('veh-next');
  vehSummary = () => this.page.getByTestId('veh-summary');
  vehDispatchBtn = () => this.page.getByTestId('vehicle-dispatch');
  vehTargetRunway = (rwy: string) => this.page.getByTestId(`veh-target-runway-${rwy}`);
  vehCardDispatch = (id: string) => this.page.getByTestId(`veh-card-${id}-dispatch`);
  vehCardRecall = (id: string) => this.page.getByTestId(`vehicle-recall-${id}`);
  /** `veh-card-{ID}-status[data-state=standby|enroute|onscene|returning]` */
  vehCardStatus = (id: string) => this.page.getByTestId(`veh-card-${id}-status`);
  /** ARFF-only state pill `arff-vehicle-{ID}[data-state]` */
  arffVehicle = (id: string) => this.page.getByTestId(`arff-vehicle-${id}`);
  /** `veh-runway-{RWY}-status[data-status]` (only rendered for runways that are not open). */
  vehRunwayStatus = (rwy: string) => this.page.getByTestId(`veh-runway-${rwy}-status`);
  /** Open the vehicles panel from the ground-map toolbar (position must be GROUND or TOWER). */
  async openVehiclesPanel(): Promise<void> {
    if (await this.vehiclesPanel().count()) return;
    await this.vehiclesToolBtn().click();
    await expect(this.vehiclesPanel()).toBeVisible();
  }

  // ── strip bay chrome (StripBay.tsx): filters, search, collapse rail, bay sections ──
  bayFilter = (f: 'all' | 'dep' | 'arr' | 'req' | 'alert') => this.page.getByTestId(`bay-filter-${f}`);
  baySearch = () => this.page.getByTestId('bay-search');
  bayCollapse = () => this.page.getByTestId('bay-collapse');
  /** Collapsed-rail count button per bay: data-count / data-req / data-alert. */
  bayRailCount = (bayId: string) => this.page.getByTestId(`bay-rail-count-${bayId}`);
  bayCount = (bayId: string) => this.page.getByTestId(`bay-count-${bayId}`);
  bayEmpty = (bayId: string) => this.page.getByTestId(`bay-empty-${bayId}`);
  /** Callsigns of the strips inside one bay section, in DOM order. */
  async bayCallsigns(bayId: string): Promise<string[]> {
    return this.bay(bayId).locator('[role="option"][data-testid^="strip-"][data-id]').evaluateAll((els) => els.map((e) => (e.getAttribute('data-testid') ?? '').slice('strip-'.length)));
  }
  /** Drag strip `cs` onto strip `target` (HTML5 drag; `where` picks the top / bottom half of the target card). */
  async dragStrip(cs: string, target: string, where: 'before' | 'after' = 'before'): Promise<void> {
    const box = await this.strip(target).boundingBox();
    const y = where === 'before' ? 4 : Math.max(5, (box?.height ?? 40) - 4);
    await this.strip(cs).dragTo(this.strip(target), { targetPosition: { x: 40, y } });
  }

  // ── comm log chrome (CommLog.tsx) ───────────────────────────────────────
  logCollapse = () => this.page.getByTestId('log-collapse');
  logLastLine = () => this.page.getByTestId('log-last-line');
  logLastCalled = () => this.page.getByTestId('log-last-called');
  logNewPill = () => this.page.getByTestId('radio-log-new');
  radioLogEmpty = () => this.page.getByTestId('radio-log-empty');
  cmdAutocomplete = () => this.page.getByTestId('cmd-autocomplete');
  cmdAutocompleteItem = (i: number) => this.page.getByTestId(`cmd-autocomplete-${i}`);
  cmdAutocompleteItems = () => this.page.locator('[data-testid^="cmd-autocomplete-"][role="option"]');
  cmdParseErrorToken = () => this.page.getByTestId('cmd-parse-error-token');
  /** The `radio-line` element with a given store key (data-key). */
  radioLineByKey = (key: number) => this.page.locator(`[data-testid="radio-line"][data-key="${key}"]`);
  lineUndo = (key: number) => this.page.getByTestId(`log-line-${key}-undo`);
  lineRepeat = (key: number) => this.page.getByTestId(`log-line-${key}-repeat`);
  lineCorrect = (key: number) => this.page.getByTestId(`log-line-${key}-correct`);
  /** Autocomplete option labels currently shown (empty when the menu is closed). */
  async autocompleteLabels(): Promise<string[]> {
    return this.cmdAutocompleteItems().evaluateAll((els) => els.map((e) => e.textContent?.trim() ?? ''));
  }

  // ── nav chrome: ATIS / score / alerts / TX / help / pause / settings ─────
  scoreChip = () => this.page.getByTestId('score-chip');
  scoreBreakdown = () => this.page.getByTestId('score-breakdown');
  scoreBreakdownClose = () => this.page.getByTestId('score-breakdown-close');
  scoreRow = (key: string) => this.page.getByTestId(`score-row-${key}`);
  atisClose = () => this.page.getByTestId('atis-close');
  atisWind = () => this.page.getByTestId('atis-wind');
  atisQnh = () => this.page.getByTestId('atis-qnh');
  atisText = () => this.page.getByTestId('atis-text');
  alertsDrawer = () => this.page.getByTestId('alerts-drawer');
  alertsDrawerClose = () => this.page.getByTestId('alerts-drawer-close');
  alertsEmpty = () => this.page.getByTestId('alerts-empty');
  alertsRow = (id: string) => this.page.getByTestId(`alerts-row-${id}`);
  alertsRows = () => this.page.locator('[data-testid^="alerts-row-"]:not([data-testid$="-state"]):not([data-testid$="-score"])');
  txIndicator = () => this.page.getByTestId('tx-indicator');
  clockPopover = () => this.page.getByTestId('clock-popover');
  helpTab = (t: 'hotkeys' | 'phraseology' | 'matrix' | 'alerts' | 'glossary') => this.page.getByTestId(`help-tab-${t}`);
  helpSearch = () => this.page.getByTestId('help-search');
  helpClose = () => this.page.getByTestId('help-close');
  helpHotkeyRows = () => this.page.locator('[data-testid^="help-hotkey-row-"]');
  helpHotkeyRow = (id: string) => this.page.getByTestId(`help-hotkey-row-${id}`);
  helpPhraseRows = () => this.page.locator('[data-testid^="help-phrase-"]');
  helpMatrix = () => this.page.getByTestId('help-matrix');
  helpAlertRows = () => this.page.locator('[data-testid^="help-alert-"]');
  helpGlossaryRows = () => this.page.locator('[data-testid^="help-glossary-"]');
  pauseItem = (id: 'resume' | 'restart' | 'runways' | 'settings' | 'tracks' | 'quit') => this.page.getByTestId(`pause-${id}`);
  pauseConfirm = (which: 'restart' | 'quit') => this.page.getByTestId(`pause-confirm-${which}`);
  pauseConfirmYes = () => this.page.getByTestId('pause-confirm-yes');
  pauseConfirmNo = () => this.page.getByTestId('pause-confirm-no');
  settingsClose = () => this.page.getByTestId('set-close');
  settingsOpenFull = () => this.page.getByTestId('set-open-full');
  /** In-game settings toggle (role=switch, aria-checked). */
  settingsToggle = (id: 'set-sound' | 'set-tts' | 'set-autotower' | 'set-autoground' | 'set-auto-handoff' | 'set-strict-frequencies' | 'set-readback-errors' | 'set-instant-vectors' | 'set-typed-instant' | 'set-show-rings' | 'set-reduced-motion' | 'set-hotkey-badges') => this.page.getByTestId(id);

  // ── lifecycle ────────────────────────────────────────────────────────────
  /** Build the /play URL for a config (test mode on by default). */
  static url(o: GameGotoOptions = {}): string {
    const q = new URLSearchParams();
    q.set('icao', o.icao ?? 'EGLL');
    q.set('seed', String(o.seed ?? 7));
    q.set('spawn', o.spawn ?? 'none');
    if (o.test !== false) q.set('test', '1');
    if (o.position) q.set('position', o.position);
    return `/play?${q.toString()}`;
  }

  /**
   * Open the game deterministically: `/play?icao=&seed=&spawn=&test=1[&position=]`, wait for
   * `page-atc[data-ready="true"]`, the load overlay to go and `__atcTest.ready()`.
   */
  async goto(o: GameGotoOptions = {}): Promise<void> {
    await this.page.goto(GamePage.url(o));
    await this.waitReady(o);
  }

  /** Wait for a mounted /play route (used after home -> START as well). */
  async waitReady(o: { test?: boolean; waitMap?: boolean } = {}): Promise<void> {
    await expect(this.root()).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
    await expect(this.loadOverlay()).toHaveCount(0, { timeout: 60_000 });
    if (await this.loadError().count()) throw new Error(`airport failed to load: ${await this.loadError().textContent()}`);
    if (o.test !== false) await this.sim.waitReady();
    if (o.waitMap) await this.sim.waitMapReady();
  }

  /** Current position tab from the shell root. */
  async position(): Promise<PlayerPosition> {
    return (await this.shell().getAttribute('data-mode')) as PlayerPosition;
  }

  /** Switch position tab via the nav and wait for the matching view to mount. */
  async setPosition(p: PlayerPosition): Promise<void> {
    await this.modeTab(p).click();
    await expect(this.modeTab(p)).toHaveAttribute('aria-selected', 'true');
    await expect(this.shell()).toHaveAttribute('data-mode', p);
    await expect(this.view(p === 'approach' ? 'radar' : 'ground')).toBeVisible();
  }

  async isPaused(): Promise<boolean> { return (await this.pauseBtn().getAttribute('data-state')) === 'paused'; }
  async togglePause(): Promise<void> {
    const was = await this.isPaused();
    await this.pauseBtn().click();
    await expect(this.pauseBtn()).toHaveAttribute('data-state', was ? 'running' : 'paused');
  }
  async setRate(r: 1 | 2 | 4): Promise<void> {
    await this.rateBtn(r).click();
    await expect(this.rateBtn(r)).toHaveAttribute('aria-pressed', 'true');
  }

  // ── strips + panel ───────────────────────────────────────────────────────
  /** Click a strip and wait until it is selected and the panel shows its callsign. */
  async selectStrip(cs: string): Promise<void> {
    await this.strip(cs).click();
    await expect(this.strip(cs)).toHaveAttribute('data-selected', 'true');
    await expect(this.panelCallsign()).toHaveText(cs);
  }
  /** Select via the strip and wait for the command panel (`detail-panel[data-callsign=cs]`). */
  async openPanelFor(cs: string): Promise<void> {
    await this.selectStrip(cs);
    await expect(this.panel()).toHaveAttribute('data-callsign', cs);
    await expect(this.panelActions().or(this.stepper()).first()).toBeVisible();
  }
  /** Close the panel (X) and wait until nothing is selected. */
  async closePanel(): Promise<void> {
    await this.panelClose().click();
    await expect(this.shell()).toHaveAttribute('data-has-panel', 'false');
  }
  /** Callsigns of the strips currently rendered, in bay order. */
  async stripCallsigns(): Promise<string[]> {
    return this.strips().evaluateAll((els) => els.map((e) => (e.getAttribute('data-testid') ?? '').slice('strip-'.length)));
  }

  /**
   * Click an action-grid button by ActionId (e.g. 'action-heading', 'action-taxi-runway', 'emerg-ack')
   * and wait for its stepper to open. Falls back to the quick-row pill when the grid button is absent.
   */
  async action(actionId: string): Promise<void> {
    const grid = this.actionBtn(actionId);
    if (await grid.count()) {
      await expect(grid, `${actionId} is disabled: ${await grid.getAttribute('data-reason')}`).toHaveAttribute('data-state', 'enabled');
      await grid.click();
    } else {
      await this.quickBtn(actionId).click();
    }
    await expect(this.stepperFor(actionId)).toBeVisible();
  }
  /** Click a quick-row pill (`quick-{actionId}`) and wait for its stepper. */
  async quick(actionId: string): Promise<void> {
    await this.quickBtn(actionId).click();
    await expect(this.stepperFor(actionId)).toBeVisible();
  }
  /** data-state / data-reason of an action-grid button. */
  async actionState(actionId: string): Promise<{ state: string | null; reason: string | null }> {
    const b = this.actionBtn(actionId);
    return { state: await b.getAttribute('data-state'), reason: await b.getAttribute('data-reason') };
  }

  // ── stepper helpers (one per picker type) ────────────────────────────────
  async stepType(): Promise<string | null> { return this.stepper().first().getAttribute('data-step-type'); }
  /** Advance to the next step (Next button). */
  async next(): Promise<void> {
    const before = await this.stepper().first().getAttribute('data-step');
    await expect(this.stepNext()).toBeEnabled();
    await this.stepNext().click();
    await expect(this.stepper().first()).not.toHaveAttribute('data-step', before ?? '');
  }
  async back(): Promise<void> { await this.stepBack().click(); }
  async cancel(): Promise<void> {
    await this.cancelBtn().click();
    await expect(this.stepper()).toHaveCount(0);
  }

  /** picker-runway: pick an end (and optionally the ILS / LOC / VIS mode). */
  async pickRunway(rwy: string, mode?: 'ils' | 'loc' | 'visual'): Promise<void> {
    if (mode) await this.page.getByTestId(`picker-runway-mode-${mode}`).click();
    const b = this.page.getByTestId(`picker-runway-${rwy}`);
    await b.click();
    await expect(b).toHaveAttribute('aria-pressed', 'true');
  }
  /**
   * picker-route (taxi to runway / stand): AUTO by default; `via` appends taxiway chips in order,
   * `holdShort` / `cross` open their menus and pick a runway.
   */
  async pickTaxiwayRoute(o: { via?: string[]; auto?: boolean; holdShort?: string; cross?: string[] } = {}): Promise<void> {
    await expect(this.picker('route')).toBeVisible();
    if (o.via?.length) {
      await this.page.getByTestId('picker-route-clear').click().catch(() => {});
      for (const t of o.via) await this.page.getByTestId(`picker-route-twy-${t}`).click();
    } else if (o.auto !== false) {
      await this.page.getByTestId('picker-route-auto').click();
    }
    if (o.holdShort) {
      await this.page.getByTestId('picker-route-holdshort').click();
      await this.page.getByTestId(`picker-route-holdshort-${o.holdShort}`).click();
    }
    for (const r of o.cross ?? []) {
      await this.page.getByTestId('picker-route-cross').click();
      await this.page.getByTestId(`picker-route-cross-${r}`).click();
    }
  }
  /** picker-heading: type a MAGNETIC heading into the dial input (blur commits) and pick a turn direction. */
  async dial(hdgMag: number, dir?: 'L' | 'R' | 'shortest'): Promise<void> {
    const input = this.page.getByTestId('picker-heading-input');
    await input.fill(String(((Math.round(hdgMag) % 360) + 360) % 360 || 360).padStart(3, '0'));
    await input.press('Tab');
    if (dir) await this.page.getByTestId(`picker-heading-${dir === 'L' ? 'left' : dir === 'R' ? 'right' : 'shortest'}`).click();
    await expect(input).toHaveValue(String(((Math.round(hdgMag) % 360) + 360) % 360 || 360).padStart(3, '0'));
  }
  /** Drive a Ladder (`{base}-svg` aria-valuenow) to `target` with quick-step buttons + arrow keys. */
  private async ladderTo(base: string, target: number): Promise<void> {
    const svg = this.page.getByTestId(`${base}-svg`);
    await expect(svg).toBeVisible();
    const read = async () => Number(await svg.getAttribute('aria-valuenow'));
    const min = Number(await svg.getAttribute('aria-valuemin'));
    const max = Number(await svg.getAttribute('aria-valuemax'));
    expect(target, `ladder target ${target} outside [${min}, ${max}]`).toBeGreaterThanOrEqual(min);
    expect(target).toBeLessThanOrEqual(max);
    // quick-step buttons first (largest that still moves toward the target without overshooting)
    const steps = await this.page.locator(`[data-testid^="${base}-step-"]`).evaluateAll((els) =>
      els.map((e) => Number((e.getAttribute('data-testid') ?? '').split('-step-')[1])).filter((n) => Number.isFinite(n)));
    const quick = steps.sort((a, b) => Math.abs(b) - Math.abs(a));
    for (let guard = 0; guard < 60; guard++) {
      const cur = await read();
      const delta = target - cur;
      if (delta === 0) return;
      const q = quick.find((s) => Math.sign(s) === Math.sign(delta) && Math.abs(s) <= Math.abs(delta));
      if (q != null) {
        const btn = this.page.getByTestId(`${base}-step-${q}`);
        if (await btn.isEnabled()) { await btn.click(); continue; }
      }
      await svg.focus();
      await svg.press(delta > 0 ? 'ArrowUp' : 'ArrowDown');
      const after = await read();
      if (after === cur) break;                               // ladder cannot move further (min / max / step mismatch)
    }
    const final = await read();
    expect(final, `ladder ${base} stuck at ${final}, wanted ${target}`).toBe(target);
  }
  /** picker-altitude: set the ladder to `ft` (1000-ft steps; 500-ft toggle handled by the ladder's step). */
  async ladderAlt(ft: number, opts: { expedite?: boolean } = {}): Promise<void> {
    await this.ladderTo('picker-alt-ladder', ft);
    if (opts.expedite != null) {
      const t = this.page.getByTestId('picker-alt-expedite');
      if ((await t.getAttribute('aria-checked')) !== String(opts.expedite)) await t.click();
    }
  }
  /** picker-speed: click a quick chip when there is one, else drive the ladder; 'final' / 'resume' use the presets. */
  async ladderSpd(target: StepperSpeedTarget): Promise<void> {
    if (target === 'final') { await this.page.getByTestId('picker-speed-final').click(); return; }
    if (target === 'resume') { await this.page.getByTestId('picker-speed-resume').click(); return; }
    const chip = this.page.getByTestId(`picker-speed-chip-${target}`);
    if (await chip.count()) { await chip.click(); await expect(chip).toHaveAttribute('aria-pressed', 'true'); return; }
    await this.ladderTo('picker-speed-ladder', target);
  }
  /** Generic `ladder(value)`: whichever ladder is on screen (altitude in ft or speed in kts). */
  async ladder(value: number): Promise<void> {
    if (await this.page.getByTestId('picker-alt-ladder-svg').count()) return this.ladderAlt(value);
    return this.ladderSpd(value);
  }
  /** picker-fix (direct / hold): pick a beacon row. */
  async pickFix(fix: string): Promise<void> {
    const row = this.page.getByTestId(`picker-fix-${fix}`);
    await row.click();
    await expect(row).toHaveAttribute('aria-pressed', 'true');
  }
  /** picker-direction: LEFT / RIGHT / N E S W / any. */
  async pickDirection(d: 'L' | 'R' | 'N' | 'E' | 'S' | 'W' | 'any'): Promise<void> {
    const id = d === 'L' ? 'picker-dir-left' : d === 'R' ? 'picker-dir-right' : `picker-dir-${d}`;
    const b = this.page.getByTestId(id);
    await b.click();
    if (d !== 'any') await expect(b).toHaveAttribute('aria-pressed', 'true');
  }
  pickGate(ref: string) { return this.page.getByTestId(`picker-gate-${ref}`).click(); }
  pickTaxiway(t: string) { return this.page.getByTestId(`picker-taxiway-${t}`).click(); }
  pickAircraft(cs: string) { return this.page.getByTestId(`picker-aircraft-${cs}`).click(); }
  pickPosition(p: PlayerPosition | 'departure') { return this.page.getByTestId(`picker-position-${p}`).click(); }

  /**
   * On the confirm step: click TRANSMIT (or TRANSMIT ANYWAY when only soft warnings block) and wait for the
   * inline result. Returns the result status / code / transmission text shown in the panel.
   */
  async transmit(o: { anyway?: boolean } = {}): Promise<{ status: string | null; code: string | null; tx: string }> {
    await expect(this.confirmStep()).toBeVisible();
    const anyway = this.transmitAnyway();
    if (o.anyway && (await anyway.count())) await anyway.click();
    else {
      await expect(this.page.getByTestId('confirm-transmit')).toHaveAttribute('data-state', 'enabled');
      await this.transmitBtn().click();
    }
    await expect(this.result()).toBeVisible();
    return { status: await this.result().getAttribute('data-status'), code: await this.result().getAttribute('data-code'), tx: (await this.resultTx().textContent()) ?? '' };
  }
  /** Alias: confirm() === transmit(). */
  confirm(o: { anyway?: boolean } = {}) { return this.transmit(o); }

  /**
   * Soft-blocked confirm step: the amber TRANSMIT ANYWAY button needs a 600 ms pointer hold
   * (ConfirmStep.tsx HOLD_MS); a plain click cancels the hold. Holds the pointer for `holdMs` wall-clock
   * milliseconds (UI gesture, not sim time) and waits for the inline result.
   */
  async holdTransmitAnyway(holdMs = 900): Promise<{ status: string | null; code: string | null; tx: string }> {
    await expect(this.confirmStep()).toBeVisible();
    const anyway = this.transmitAnyway();
    await expect(anyway).toBeVisible();
    const box = await anyway.boundingBox();
    expect(box, 'confirm-transmit-anyway has no box').not.toBeNull();
    await this.page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await this.page.mouse.down();
    await this.page.waitForTimeout(holdMs);
    await this.page.mouse.up();
    await expect(this.result()).toBeVisible();
    return { status: await this.result().getAttribute('data-status'), code: await this.result().getAttribute('data-code'), tx: (await this.resultTx().textContent()) ?? '' };
  }
  /** Texts of the soft warnings shown on the confirm step (`confirm-warning-{i}`). */
  async confirmWarnings(): Promise<string[]> {
    return this.page.locator('[data-testid^="confirm-warning-"]').evaluateAll((els) => els.map((e) => e.textContent?.trim() ?? ''));
  }
  /** `data-reason` of the first hard block on the confirm step (null when not blocked). */
  async blockedReasonText(): Promise<string | null> {
    if (!(await this.blockedReason().count())) return null;
    return this.blockedReason().getAttribute('data-reason');
  }

  // ── ATIS / runway config flows ───────────────────────────────────────────
  /** Open the ATIS dropdown from the nav chip (no-op when already open). */
  async openAtis(): Promise<void> {
    if (!(await this.atisPanel().count())) await this.atisChip().click();
    await expect(this.atisPanel()).toBeVisible();
  }
  /** Open the runway configuration dialog (via the ATIS panel "Change" button). */
  async openRunwayConfig(): Promise<void> {
    await this.openAtis();
    await this.page.getByTestId('atis-runway-config').click();
    await expect(this.runwayConfigDialog()).toBeVisible();
  }
  /** Set a runway end's status through the ATIS panel status chip menu. */
  async setRunwayStatusViaAtis(rwy: string, o: 'open' | 'close' | 'sterile' | 'inspect'): Promise<void> {
    await this.openAtis();
    await this.atisRunwayStatus(rwy).click();
    await this.atisRunwayStatusOption(rwy, o).click();
    const expected = o === 'close' ? 'closed' : o === 'inspect' ? 'inspection' : o;
    await expect(this.atisRunwayStatus(rwy)).toHaveAttribute('data-status', expected);
  }
  /** Close the ATIS panel via its X. */
  async closeAtis(): Promise<void> {
    if (await this.atisPanel().count()) await this.page.getByTestId('atis-close').click();
    await expect(this.atisPanel()).toHaveCount(0);
  }

  // ── typed commands + radio ───────────────────────────────────────────────
  /** Type a command in the comm-log input and press Enter; waits for the input to clear (accepted) or an error plate. */
  async send(text: string): Promise<{ accepted: boolean; error: string | null }> {
    await this.cmdInput().fill(text);
    await this.cmdInput().press('Enter');
    await expect.poll(async () => (await this.cmdInput().inputValue()) === '' || (await this.cmdParseError().count()) > 0 || (await this.cmdReview().count()) > 0, { timeout: 10_000 }).toBe(true);
    const err = (await this.cmdParseError().count()) ? await this.cmdParseError().textContent() : null;
    return { accepted: err == null && (await this.cmdInput().inputValue()) === '', error: err };
  }
  /** Same as send() but expects acceptance and returns the ATC line that was logged. */
  async sendOk(text: string): Promise<RadioRow> {
    const r = await this.send(text);
    expect(r.error, `command rejected: ${r.error}`).toBeNull();
    expect(r.accepted).toBe(true);
    return this.waitRadio(/./, { who: 'ATC' });
  }
  /** Send via the SEND button instead of Enter. */
  async sendViaButton(text: string): Promise<void> {
    await this.cmdInput().fill(text);
    await this.cmdSend().click();
  }
  /** Rows currently shown in the comm log (DOM; filtered by the log's frequency filter). */
  async radioRows(who?: RadioWho): Promise<RadioRow[]> {
    return this.radioLines(who).evaluateAll((els) => els.map((e) => ({
      who: (e.getAttribute('data-who') ?? 'SYS') as RadioWho,
      text: e.querySelector('[data-testid="radio-text"]')?.textContent?.trim() ?? '',
      callsign: e.getAttribute('data-callsign'),
      key: Number(e.getAttribute('data-key') ?? 0),
      status: e.getAttribute('data-status'),
    })));
  }
  /** Last line in the visible comm log (optionally by speaker). */
  async readLastRadio(who?: RadioWho): Promise<RadioRow | null> {
    const rows = await this.radioRows(who);
    return rows.length ? rows[rows.length - 1] : null;
  }
  /** Poll the visible comm log until a line matching `re` (and `who` / `callsign` when given) exists; returns the newest match. */
  async waitRadio(re: RegExp, o: { who?: RadioWho; callsign?: string; timeout?: number } = {}): Promise<RadioRow> {
    let found: RadioRow | null = null;
    await expect.poll(async () => {
      const rows = await this.radioRows(o.who);
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i];
        if (o.callsign && r.callsign !== o.callsign) continue;
        if (re.test(r.text)) { found = r; return true; }
      }
      return false;
    }, { timeout: o.timeout ?? 10_000, message: `radio line /${re.source}/ ${o.who ?? ''} ${o.callsign ?? ''} not logged` }).toBe(true);
    return found!;
  }
  /** Show every frequency in the log (the default filter follows the position tab). */
  async showAllFrequencies(): Promise<void> {
    await this.logFilter('all').click();
    await expect(this.logFilter('all')).toHaveAttribute('aria-selected', 'true');
  }

  // ── toasts ───────────────────────────────────────────────────────────────
  async toastRows(): Promise<ToastRow[]> {
    return this.toasts().evaluateAll((els) => els.map((e) => ({ kind: e.getAttribute('data-kind') ?? '', text: e.textContent?.trim() ?? '' })));
  }
  async waitToast(re: RegExp, timeout = 10_000): Promise<ToastRow> {
    let found: ToastRow | null = null;
    await expect.poll(async () => { const t = (await this.toastRows()).find((x) => re.test(x.text)); if (t) found = t; return !!t; }, { timeout, message: `toast /${re.source}/ not shown` }).toBe(true);
    return found!;
  }

  // ── keyboard ─────────────────────────────────────────────────────────────
  /** Press a shell hotkey with focus on the map region (so inputs / pickers do not swallow it). */
  async hotkey(key: ShellHotkey): Promise<void> {
    await this.page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur?.(); });
    await this.page.keyboard.press(key === '?' ? 'Shift+/' : key);
  }

  // ── canvas hit-testing (05 §3.2) ─────────────────────────────────────────
  /** The active canvas element (radar on APPROACH, ground map otherwise). */
  async activeCanvas(): Promise<Locator> {
    return (await this.position()) === 'approach' ? this.radarCanvas() : this.groundMap();
  }
  /** Click an aircraft on the active canvas at its projected position (centres first when off-view). */
  async clickAircraft(cs: string): Promise<void> {
    const canvas = await this.activeCanvas();
    let p = await this.sim.screenPos(cs);
    const box = await canvas.boundingBox();
    const inside = (q: { x: number; y: number } | null) => !!q && !!box && q.x >= 0 && q.y >= 0 && q.x <= box.width && q.y <= box.height;
    if (!inside(p)) { await this.sim.centerOn(cs); await this.sim.flush(); p = await this.sim.screenPos(cs); }
    expect(p, `${cs} has no screen position`).not.toBeNull();
    await canvas.click({ position: { x: p!.x, y: p!.y } });
  }
  /** Click an empty spot on the active canvas (deselects). */
  async clickEmpty(): Promise<void> {
    const canvas = await this.activeCanvas();
    const p = await this.sim.emptySpot();
    await canvas.click({ position: p });
  }
}
