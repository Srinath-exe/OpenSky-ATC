/*
  Vehicles panel page object (src/game/VehiclePanel/VehiclePanel.tsx, UX 04 §6). GROUND / TOWER only.
  Opened from the ground-map toolbar (`map-tool-vehicles`, data-state on|off) or F10.

    vehicle-panel[data-responding] · veh-panel-close · veh-new-dispatch · veh-result[data-ok]
    vehicle-{ID}[data-state|data-type] · veh-card-{ID} · veh-card-{ID}-status[data-state] · veh-card-{ID}-eta[data-value]
    veh-card-{ID}-dispatch | -hold | -continue | -cross | -retask | -recall (wraps vehicle-recall-{ID})
    veh-flow[data-step=vehicles|target|confirm] · veh-pick-{ID}[aria-selected] · veh-next · veh-back · veh-cancel
    veh-target-{aircraft|runway|stand|map|station} · veh-target-runway-{RWY} · veh-target-stand-input · veh-summary
    veh-confirm (wraps vehicle-dispatch) · btn-arff-dispatch · veh-emergency[data-callsign]
*/
import { expect, type Page } from '@playwright/test';

export type VehicleTargetKind = 'aircraft' | 'runway' | 'stand' | 'map' | 'station';

export class VehiclePanelPage {
  constructor(readonly page: Page) {}

  root = () => this.page.getByTestId('vehicle-panel');
  toolbarBtn = () => this.page.getByTestId('map-tool-vehicles');
  closeBtn = () => this.page.getByTestId('veh-panel-close');
  newDispatch = () => this.page.getByTestId('veh-new-dispatch');
  result = () => this.page.getByTestId('veh-result');
  flow = () => this.page.getByTestId('veh-flow');
  next = () => this.page.getByTestId('veh-next');
  back = () => this.page.getByTestId('veh-back');
  cancel = () => this.page.getByTestId('veh-cancel');
  summary = () => this.page.getByTestId('veh-summary');
  dispatchBtn = () => this.page.getByTestId('vehicle-dispatch');
  arffDispatch = () => this.page.getByTestId('btn-arff-dispatch');
  target = (k: VehicleTargetKind) => this.page.getByTestId(`veh-target-${k}`);
  targetRunway = (rwy: string) => this.page.getByTestId(`veh-target-runway-${rwy}`);
  standInput = () => this.page.getByTestId('veh-target-stand-input');
  card = (id: string) => this.page.getByTestId(`vehicle-${id}`);
  cardStatus = (id: string) => this.page.getByTestId(`veh-card-${id}-status`);
  cardEta = (id: string) => this.page.getByTestId(`veh-card-${id}-eta`);
  cardAction = (id: string, a: 'dispatch' | 'hold' | 'continue' | 'cross' | 'retask' | 'recall') => this.page.getByTestId(`veh-card-${id}-${a}`);
  recallBtn = (id: string) => this.page.getByTestId(`vehicle-recall-${id}`);
  pick = (id: string) => this.page.getByTestId(`veh-pick-${id}`);
  vehicleStrip = (id: string) => this.page.getByTestId(`strip-vehicle-${id}`);
  vehicleStripState = (id: string) => this.page.getByTestId(`strip-vehicle-${id}-state`);

  /** Open the panel from the ground-map toolbar (no-op when already open). */
  async open(): Promise<void> {
    if (await this.root().count()) return;
    await this.toolbarBtn().click();
    await expect(this.root()).toBeVisible();
    await expect(this.toolbarBtn()).toHaveAttribute('data-state', 'on');
  }

  async close(): Promise<void> {
    await this.closeBtn().click();
    await expect(this.root()).toHaveCount(0);
  }

  async step(): Promise<string | null> { return this.flow().getAttribute('data-step'); }

  /** Start the dispatch flow for one standby vehicle from its card (lands on the target step). */
  async startDispatch(id: string): Promise<void> {
    await this.cardAction(id, 'dispatch').click();
    await expect(this.flow()).toHaveAttribute('data-step', 'target');
  }

  /** Pick the target on the target step. `aircraft` uses the currently selected aircraft. */
  async pickTarget(t: { kind: 'aircraft' } | { kind: 'runway'; runway: string } | { kind: 'stand'; ref: string } | { kind: 'station' }): Promise<void> {
    await this.target(t.kind).click();
    if (t.kind === 'runway') await this.targetRunway(t.runway).click();
    if (t.kind === 'stand') await this.standInput().fill(t.ref);
  }

  /** Next -> confirm step -> Dispatch; returns the result plate state and text. */
  async confirmDispatch(): Promise<{ ok: boolean; text: string }> {
    await this.next().click();
    await expect(this.flow()).toHaveAttribute('data-step', 'confirm');
    await this.dispatchBtn().click();
    await expect(this.result()).toBeVisible();
    return { ok: (await this.result().getAttribute('data-ok')) === 'true', text: (await this.result().textContent()) ?? '' };
  }
}
