// ============================================================
//  Aircraft Performance Database  (aircraft_performance_database.md)
//
//  Every ICAO type maps to a weight class and a set of physical coefficients
//  that drive the physics in aircraft.ts (taxi/turn/takeoff speeds, climb &
//  descent rates, air turn rate, acceleration) plus special gameplay rules
//  (wake turbulence, priority access, military manoeuvring) and the fields
//  the feature spec relies on (03 §A2: engines, spoken type, V1, TORA/LD,
//  runway-separation category, B757 wake flag, ILS capability, startup time).
//
//  All randomness goes through rng.ts (05 §2.2) — never Math.random.
// ============================================================
import { rnd } from './rng';

export type WeightClass = 'L' | 'M' | 'H' | 'S';
export type WakeCat = 'none' | 'light' | 'heavy' | 'super';
export type RunwaySepCategory = 'I' | 'II' | 'III';
export type IlsCapability = 'CAT1' | 'CAT2' | 'CAT3A' | 'CAT3B';
export type PropulsionKind = 'piston' | 'turboprop' | 'jet';

export interface AircraftPerformance {
  icaoCode: string;
  modelName: string;
  weightClass: WeightClass;

  // dimensions for ground collision (metres)
  wingspanMeters: number;
  lengthMeters: number;
  safetyRadiusMeters: number;

  // taxi (knots)
  maxTaxiSpeed: number;
  taxiTurnSpeed: number;

  // speed limits (knots)
  takeoffRotationSpeed: number; // Vr
  approachSpeed: number;        // Vapp
  maxAirspeedTMA: number;
  minAirspeedTMA: number;

  // climb / descent (ft per minute) + air accel (kts/sec)
  maxClimbRate: number;
  maxDescentRate: number;
  accelerationRateAir: number;
  decelerationRateAir: number;

  // manoeuvring
  turnRateAir: number; // deg/sec

  specialRules: {
    wakeTurbulenceGenerator: boolean;
    wakeTurbulenceRequiredCategory: WakeCat;
    priorityAirspaceAccess: boolean;
    militaryManeuvering: boolean;
  };

  // ── 03 §A2 additions ──
  /** Spoken type for traffic information ("Boeing 737"). */
  spokenType: string;
  engines: number;
  propulsion: PropulsionKind;
  /** V1 as a fraction of Vr (03 §A8: 0.92 jets, 0.85 props). */
  v1Factor: number;
  /** Required takeoff run, metres (03 §C2 defaults per class). */
  toraM: number;
  /** Dry landing distance, metres (03 §D6 defaults per class). */
  ldM: number;
  /** FAA 7110.65 3-9-6 runway separation category (03 §A4). */
  runwaySepCategory: RunwaySepCategory;
  /** B757: treated as HEAVY leader for MEDIUM/LIGHT followers (FAA). */
  b757: boolean;
  ilsCapability: IlsCapability;
  /** Engine start duration range, seconds (03 §1.2 by type). */
  startupS: readonly [number, number];
}

const noRules = {
  wakeTurbulenceGenerator: false,
  wakeTurbulenceRequiredCategory: 'none' as WakeCat,
  priorityAirspaceAccess: false,
  militaryManeuvering: false,
};
const heavyRules = { wakeTurbulenceGenerator: true, wakeTurbulenceRequiredCategory: 'heavy' as WakeCat, priorityAirspaceAccess: false, militaryManeuvering: false };
const mediumRules = { wakeTurbulenceGenerator: false, wakeTurbulenceRequiredCategory: 'heavy' as WakeCat, priorityAirspaceAccess: false, militaryManeuvering: false };

type Core = Omit<AircraftPerformance, 'spokenType' | 'engines' | 'propulsion' | 'v1Factor' | 'toraM' | 'ldM' | 'runwaySepCategory' | 'b757' | 'ilsCapability' | 'startupS'>;
type Extra = Partial<Pick<AircraftPerformance, 'spokenType' | 'engines' | 'propulsion' | 'v1Factor' | 'toraM' | 'ldM' | 'runwaySepCategory' | 'b757' | 'ilsCapability' | 'startupS'>>;

/** Class defaults for the §A2 fields (03 §C2 / §D6 / §1.2 tables). */
function classDefaults(wc: WeightClass, propulsion: PropulsionKind, engines: number): Omit<Extra, 'spokenType'> & Required<Pick<Extra, 'engines' | 'propulsion' | 'v1Factor' | 'toraM' | 'ldM' | 'runwaySepCategory' | 'b757' | 'ilsCapability' | 'startupS'>> {
  const jet = propulsion === 'jet';
  const tora = wc === 'L' ? 500 : propulsion === 'turboprop' ? 1200 : wc === 'M' ? 2000 : wc === 'H' ? 2800 : 3200;
  const ld = wc === 'L' ? 600 : propulsion === 'turboprop' ? 1000 : wc === 'M' ? 1600 : wc === 'H' ? 2000 : 2300;
  const startup: readonly [number, number] = wc === 'L' ? [30, 60] : propulsion === 'turboprop' ? [90, 120] : wc === 'M' ? [120, 180] : engines >= 4 || wc === 'S' ? [200, 240] : [150, 210];
  const sep: RunwaySepCategory = wc === 'L' ? (engines >= 2 ? 'II' : 'I') : 'III';
  return {
    engines, propulsion, v1Factor: jet ? 0.92 : 0.85, toraM: tora, ldM: ld, runwaySepCategory: sep, b757: false,
    ilsCapability: wc === 'L' ? 'CAT1' : 'CAT3A', startupS: startup,
  };
}

function def(core: Core, propulsion: PropulsionKind, engines: number, spokenType: string, extra: Extra = {}): AircraftPerformance {
  return { ...core, ...classDefaults(core.weightClass, propulsion, engines), spokenType, ...extra };
}

export const AIRCRAFT_DB: Record<string, AircraftPerformance> = {
  // ── Light ──
  C172: def({ icaoCode: 'C172', modelName: 'Cessna 172 Skyhawk', weightClass: 'L', wingspanMeters: 11, lengthMeters: 8.2, safetyRadiusMeters: 15, maxTaxiSpeed: 15, taxiTurnSpeed: 8, takeoffRotationSpeed: 65, approachSpeed: 70, maxAirspeedTMA: 120, minAirspeedTMA: 50, maxClimbRate: 700, maxDescentRate: 500, accelerationRateAir: 2.0, decelerationRateAir: 1.5, turnRateAir: 3.0, specialRules: { ...noRules } }, 'piston', 1, 'Cessna 172'),
  PA28: def({ icaoCode: 'PA28', modelName: 'Piper PA-28 Cherokee', weightClass: 'L', wingspanMeters: 10.7, lengthMeters: 7.3, safetyRadiusMeters: 15, maxTaxiSpeed: 15, taxiTurnSpeed: 8, takeoffRotationSpeed: 63, approachSpeed: 66, maxAirspeedTMA: 120, minAirspeedTMA: 48, maxClimbRate: 700, maxDescentRate: 500, accelerationRateAir: 2.0, decelerationRateAir: 1.5, turnRateAir: 3.0, specialRules: { ...noRules } }, 'piston', 1, 'Cherokee'),

  // ── Medium turboprops / regionals ──
  DH8D: def({ icaoCode: 'DH8D', modelName: 'Bombardier Dash 8 Q400', weightClass: 'M', wingspanMeters: 28.4, lengthMeters: 32.8, safetyRadiusMeters: 22, maxTaxiSpeed: 20, taxiTurnSpeed: 10, takeoffRotationSpeed: 115, approachSpeed: 120, maxAirspeedTMA: 250, minAirspeedTMA: 105, maxClimbRate: 2000, maxDescentRate: 1500, accelerationRateAir: 1.5, decelerationRateAir: 1.3, turnRateAir: 2.5, specialRules: { ...mediumRules } }, 'turboprop', 2, 'Dash 8'),
  AT76: def({ icaoCode: 'AT76', modelName: 'ATR 72-600', weightClass: 'M', wingspanMeters: 27.1, lengthMeters: 27.2, safetyRadiusMeters: 20, maxTaxiSpeed: 18, taxiTurnSpeed: 9, takeoffRotationSpeed: 110, approachSpeed: 115, maxAirspeedTMA: 230, minAirspeedTMA: 100, maxClimbRate: 1600, maxDescentRate: 1400, accelerationRateAir: 1.4, decelerationRateAir: 1.3, turnRateAir: 2.5, specialRules: { ...mediumRules } }, 'turboprop', 2, 'ATR 72'),
  CRJ9: def({ icaoCode: 'CRJ9', modelName: 'Bombardier CRJ-900', weightClass: 'M', wingspanMeters: 24.9, lengthMeters: 36.2, safetyRadiusMeters: 22, maxTaxiSpeed: 20, taxiTurnSpeed: 10, takeoffRotationSpeed: 135, approachSpeed: 138, maxAirspeedTMA: 250, minAirspeedTMA: 125, maxClimbRate: 2500, maxDescentRate: 1500, accelerationRateAir: 1.6, decelerationRateAir: 1.2, turnRateAir: 2.2, specialRules: { ...mediumRules } }, 'jet', 2, 'CRJ 900'),
  CRJ7: def({ icaoCode: 'CRJ7', modelName: 'Bombardier CRJ-700', weightClass: 'M', wingspanMeters: 23.2, lengthMeters: 32.3, safetyRadiusMeters: 22, maxTaxiSpeed: 20, taxiTurnSpeed: 10, takeoffRotationSpeed: 135, approachSpeed: 138, maxAirspeedTMA: 250, minAirspeedTMA: 125, maxClimbRate: 2500, maxDescentRate: 1500, accelerationRateAir: 1.6, decelerationRateAir: 1.2, turnRateAir: 2.2, specialRules: { ...mediumRules } }, 'jet', 2, 'CRJ 700'),
  E175: def({ icaoCode: 'E175', modelName: 'Embraer E175', weightClass: 'M', wingspanMeters: 26, lengthMeters: 31.7, safetyRadiusMeters: 22, maxTaxiSpeed: 20, taxiTurnSpeed: 10, takeoffRotationSpeed: 130, approachSpeed: 132, maxAirspeedTMA: 250, minAirspeedTMA: 120, maxClimbRate: 2600, maxDescentRate: 1500, accelerationRateAir: 1.6, decelerationRateAir: 1.2, turnRateAir: 2.2, specialRules: { ...mediumRules } }, 'jet', 2, 'Embraer 175'),
  E190: def({ icaoCode: 'E190', modelName: 'Embraer E190', weightClass: 'M', wingspanMeters: 28.7, lengthMeters: 36.2, safetyRadiusMeters: 22, maxTaxiSpeed: 20, taxiTurnSpeed: 10, takeoffRotationSpeed: 135, approachSpeed: 140, maxAirspeedTMA: 250, minAirspeedTMA: 125, maxClimbRate: 2600, maxDescentRate: 1500, accelerationRateAir: 1.6, decelerationRateAir: 1.2, turnRateAir: 2.2, specialRules: { ...mediumRules } }, 'jet', 2, 'Embraer 190'),

  // ── Medium jets ──
  B738: def({ icaoCode: 'B738', modelName: 'Boeing 737-800', weightClass: 'M', wingspanMeters: 35.8, lengthMeters: 39.5, safetyRadiusMeters: 25, maxTaxiSpeed: 20, taxiTurnSpeed: 10, takeoffRotationSpeed: 140, approachSpeed: 145, maxAirspeedTMA: 250, minAirspeedTMA: 130, maxClimbRate: 2500, maxDescentRate: 1500, accelerationRateAir: 1.6, decelerationRateAir: 1.2, turnRateAir: 2.0, specialRules: { ...mediumRules } }, 'jet', 2, 'Boeing 737'),
  B739: def({ icaoCode: 'B739', modelName: 'Boeing 737-900', weightClass: 'M', wingspanMeters: 35.8, lengthMeters: 42.1, safetyRadiusMeters: 25, maxTaxiSpeed: 20, taxiTurnSpeed: 10, takeoffRotationSpeed: 140, approachSpeed: 145, maxAirspeedTMA: 250, minAirspeedTMA: 130, maxClimbRate: 2500, maxDescentRate: 1500, accelerationRateAir: 1.6, decelerationRateAir: 1.2, turnRateAir: 2.0, specialRules: { ...mediumRules } }, 'jet', 2, 'Boeing 737'),
  B38M: def({ icaoCode: 'B38M', modelName: 'Boeing 737 MAX 8', weightClass: 'M', wingspanMeters: 35.9, lengthMeters: 39.5, safetyRadiusMeters: 25, maxTaxiSpeed: 20, taxiTurnSpeed: 10, takeoffRotationSpeed: 140, approachSpeed: 145, maxAirspeedTMA: 250, minAirspeedTMA: 130, maxClimbRate: 2600, maxDescentRate: 1500, accelerationRateAir: 1.6, decelerationRateAir: 1.2, turnRateAir: 2.0, specialRules: { ...mediumRules } }, 'jet', 2, 'Boeing 737 MAX'),
  A320: def({ icaoCode: 'A320', modelName: 'Airbus A320', weightClass: 'M', wingspanMeters: 35.8, lengthMeters: 37.6, safetyRadiusMeters: 25, maxTaxiSpeed: 20, taxiTurnSpeed: 10, takeoffRotationSpeed: 138, approachSpeed: 140, maxAirspeedTMA: 250, minAirspeedTMA: 128, maxClimbRate: 2500, maxDescentRate: 1500, accelerationRateAir: 1.6, decelerationRateAir: 1.2, turnRateAir: 2.0, specialRules: { ...mediumRules } }, 'jet', 2, 'Airbus A320'),
  A319: def({ icaoCode: 'A319', modelName: 'Airbus A319', weightClass: 'M', wingspanMeters: 35.8, lengthMeters: 33.8, safetyRadiusMeters: 25, maxTaxiSpeed: 20, taxiTurnSpeed: 10, takeoffRotationSpeed: 138, approachSpeed: 140, maxAirspeedTMA: 250, minAirspeedTMA: 128, maxClimbRate: 2500, maxDescentRate: 1500, accelerationRateAir: 1.6, decelerationRateAir: 1.2, turnRateAir: 2.0, specialRules: { ...mediumRules } }, 'jet', 2, 'Airbus A319'),
  A20N: def({ icaoCode: 'A20N', modelName: 'Airbus A320neo', weightClass: 'M', wingspanMeters: 35.8, lengthMeters: 37.6, safetyRadiusMeters: 25, maxTaxiSpeed: 20, taxiTurnSpeed: 10, takeoffRotationSpeed: 135, approachSpeed: 138, maxAirspeedTMA: 250, minAirspeedTMA: 125, maxClimbRate: 2700, maxDescentRate: 1500, accelerationRateAir: 1.7, decelerationRateAir: 1.2, turnRateAir: 2.0, specialRules: { ...mediumRules } }, 'jet', 2, 'Airbus A320neo'),
  A321: def({ icaoCode: 'A321', modelName: 'Airbus A321', weightClass: 'M', wingspanMeters: 35.8, lengthMeters: 44.5, safetyRadiusMeters: 27, maxTaxiSpeed: 20, taxiTurnSpeed: 10, takeoffRotationSpeed: 145, approachSpeed: 145, maxAirspeedTMA: 250, minAirspeedTMA: 132, maxClimbRate: 2400, maxDescentRate: 1500, accelerationRateAir: 1.5, decelerationRateAir: 1.2, turnRateAir: 2.0, specialRules: { ...mediumRules } }, 'jet', 2, 'Airbus A321'),
  B752: def({ icaoCode: 'B752', modelName: 'Boeing 757-200', weightClass: 'M', wingspanMeters: 38, lengthMeters: 47.3, safetyRadiusMeters: 28, maxTaxiSpeed: 20, taxiTurnSpeed: 10, takeoffRotationSpeed: 142, approachSpeed: 138, maxAirspeedTMA: 250, minAirspeedTMA: 130, maxClimbRate: 3000, maxDescentRate: 1800, accelerationRateAir: 1.7, decelerationRateAir: 1.1, turnRateAir: 2.0, specialRules: { ...mediumRules } }, 'jet', 2, 'Boeing 757', { b757: true }),

  // ── Heavy ──
  B763: def({ icaoCode: 'B763', modelName: 'Boeing 767-300', weightClass: 'H', wingspanMeters: 47.6, lengthMeters: 54.9, safetyRadiusMeters: 34, maxTaxiSpeed: 20, taxiTurnSpeed: 9, takeoffRotationSpeed: 145, approachSpeed: 140, maxAirspeedTMA: 250, minAirspeedTMA: 132, maxClimbRate: 2800, maxDescentRate: 1900, accelerationRateAir: 1.3, decelerationRateAir: 1.0, turnRateAir: 1.7, specialRules: { ...heavyRules } }, 'jet', 2, 'Boeing 767'),
  B77W: def({ icaoCode: 'B77W', modelName: 'Boeing 777-300ER', weightClass: 'H', wingspanMeters: 64.8, lengthMeters: 73.9, safetyRadiusMeters: 40, maxTaxiSpeed: 20, taxiTurnSpeed: 8, takeoffRotationSpeed: 150, approachSpeed: 149, maxAirspeedTMA: 250, minAirspeedTMA: 140, maxClimbRate: 3000, maxDescentRate: 2000, accelerationRateAir: 1.2, decelerationRateAir: 0.9, turnRateAir: 1.5, specialRules: { ...heavyRules } }, 'jet', 2, 'Boeing 777'),
  B788: def({ icaoCode: 'B788', modelName: 'Boeing 787-8 Dreamliner', weightClass: 'H', wingspanMeters: 60.1, lengthMeters: 56.7, safetyRadiusMeters: 38, maxTaxiSpeed: 20, taxiTurnSpeed: 9, takeoffRotationSpeed: 150, approachSpeed: 145, maxAirspeedTMA: 250, minAirspeedTMA: 138, maxClimbRate: 3000, maxDescentRate: 2000, accelerationRateAir: 1.2, decelerationRateAir: 0.9, turnRateAir: 1.6, specialRules: { ...heavyRules } }, 'jet', 2, 'Boeing 787'),
  B789: def({ icaoCode: 'B789', modelName: 'Boeing 787-9 Dreamliner', weightClass: 'H', wingspanMeters: 60.1, lengthMeters: 62.8, safetyRadiusMeters: 38, maxTaxiSpeed: 20, taxiTurnSpeed: 9, takeoffRotationSpeed: 150, approachSpeed: 145, maxAirspeedTMA: 250, minAirspeedTMA: 138, maxClimbRate: 3000, maxDescentRate: 2000, accelerationRateAir: 1.2, decelerationRateAir: 0.9, turnRateAir: 1.6, specialRules: { ...heavyRules } }, 'jet', 2, 'Boeing 787'),
  A333: def({ icaoCode: 'A333', modelName: 'Airbus A330-300', weightClass: 'H', wingspanMeters: 60.3, lengthMeters: 63.7, safetyRadiusMeters: 38, maxTaxiSpeed: 20, taxiTurnSpeed: 9, takeoffRotationSpeed: 145, approachSpeed: 140, maxAirspeedTMA: 250, minAirspeedTMA: 135, maxClimbRate: 2800, maxDescentRate: 2000, accelerationRateAir: 1.2, decelerationRateAir: 0.9, turnRateAir: 1.6, specialRules: { ...heavyRules } }, 'jet', 2, 'Airbus A330'),
  A359: def({ icaoCode: 'A359', modelName: 'Airbus A350-900', weightClass: 'H', wingspanMeters: 64.8, lengthMeters: 66.8, safetyRadiusMeters: 40, maxTaxiSpeed: 20, taxiTurnSpeed: 9, takeoffRotationSpeed: 150, approachSpeed: 145, maxAirspeedTMA: 250, minAirspeedTMA: 138, maxClimbRate: 3000, maxDescentRate: 2000, accelerationRateAir: 1.2, decelerationRateAir: 0.9, turnRateAir: 1.6, specialRules: { ...heavyRules } }, 'jet', 2, 'Airbus A350'),
  A346: def({ icaoCode: 'A346', modelName: 'Airbus A340-600', weightClass: 'H', wingspanMeters: 63.4, lengthMeters: 75.4, safetyRadiusMeters: 42, maxTaxiSpeed: 20, taxiTurnSpeed: 8, takeoffRotationSpeed: 155, approachSpeed: 148, maxAirspeedTMA: 250, minAirspeedTMA: 140, maxClimbRate: 2200, maxDescentRate: 1900, accelerationRateAir: 1.0, decelerationRateAir: 0.9, turnRateAir: 1.5, specialRules: { ...heavyRules } }, 'jet', 4, 'Airbus A340'),
  MD11: def({ icaoCode: 'MD11', modelName: 'McDonnell Douglas MD-11', weightClass: 'H', wingspanMeters: 51.7, lengthMeters: 61.2, safetyRadiusMeters: 36, maxTaxiSpeed: 20, taxiTurnSpeed: 9, takeoffRotationSpeed: 155, approachSpeed: 155, maxAirspeedTMA: 250, minAirspeedTMA: 145, maxClimbRate: 2600, maxDescentRate: 2000, accelerationRateAir: 1.2, decelerationRateAir: 0.9, turnRateAir: 1.6, specialRules: { ...heavyRules } }, 'jet', 3, 'MD-11'),
  B744: def({ icaoCode: 'B744', modelName: 'Boeing 747-400', weightClass: 'H', wingspanMeters: 64.4, lengthMeters: 70.7, safetyRadiusMeters: 42, maxTaxiSpeed: 20, taxiTurnSpeed: 8, takeoffRotationSpeed: 150, approachSpeed: 150, maxAirspeedTMA: 250, minAirspeedTMA: 140, maxClimbRate: 2800, maxDescentRate: 2000, accelerationRateAir: 1.0, decelerationRateAir: 0.8, turnRateAir: 1.5, specialRules: { ...heavyRules } }, 'jet', 4, 'Boeing 747'),
  // 03 §A2: the 747-8 is HEAVY (ICAO Doc 8643), not SUPER.
  B748: def({ icaoCode: 'B748', modelName: 'Boeing 747-8', weightClass: 'H', wingspanMeters: 68.4, lengthMeters: 76.3, safetyRadiusMeters: 42, maxTaxiSpeed: 20, taxiTurnSpeed: 8, takeoffRotationSpeed: 155, approachSpeed: 145, maxAirspeedTMA: 250, minAirspeedTMA: 140, maxClimbRate: 2800, maxDescentRate: 2000, accelerationRateAir: 1.0, decelerationRateAir: 0.8, turnRateAir: 1.5, specialRules: { ...heavyRules } }, 'jet', 4, 'Boeing 747'),

  // ── Super ──
  A388: def({ icaoCode: 'A388', modelName: 'Airbus A380-800', weightClass: 'S', wingspanMeters: 80, lengthMeters: 73, safetyRadiusMeters: 45, maxTaxiSpeed: 20, taxiTurnSpeed: 8, takeoffRotationSpeed: 150, approachSpeed: 140, maxAirspeedTMA: 250, minAirspeedTMA: 135, maxClimbRate: 2800, maxDescentRate: 2000, accelerationRateAir: 1.0, decelerationRateAir: 0.8, turnRateAir: 1.5, specialRules: { wakeTurbulenceGenerator: true, wakeTurbulenceRequiredCategory: 'super', priorityAirspaceAccess: false, militaryManeuvering: false } }, 'jet', 4, 'Airbus A380', { ilsCapability: 'CAT3B' }),

  // ── Military ──
  F18: def({ icaoCode: 'F18', modelName: 'F/A-18 Hornet', weightClass: 'M', wingspanMeters: 13.6, lengthMeters: 17.1, safetyRadiusMeters: 12, maxTaxiSpeed: 25, taxiTurnSpeed: 12, takeoffRotationSpeed: 130, approachSpeed: 155, maxAirspeedTMA: 350, minAirspeedTMA: 110, maxClimbRate: 12000, maxDescentRate: 8000, accelerationRateAir: 15.0, decelerationRateAir: 8.0, turnRateAir: 6.0, specialRules: { wakeTurbulenceGenerator: false, wakeTurbulenceRequiredCategory: 'none', priorityAirspaceAccess: false, militaryManeuvering: true } }, 'jet', 2, 'Hornet', { startupS: [60, 90] }),
  F35: def({ icaoCode: 'F35', modelName: 'F-35 Lightning II', weightClass: 'M', wingspanMeters: 10.7, lengthMeters: 15.7, safetyRadiusMeters: 12, maxTaxiSpeed: 25, taxiTurnSpeed: 12, takeoffRotationSpeed: 135, approachSpeed: 150, maxAirspeedTMA: 350, minAirspeedTMA: 115, maxClimbRate: 12000, maxDescentRate: 8000, accelerationRateAir: 15.0, decelerationRateAir: 8.0, turnRateAir: 6.0, specialRules: { wakeTurbulenceGenerator: false, wakeTurbulenceRequiredCategory: 'none', priorityAirspaceAccess: false, militaryManeuvering: true } }, 'jet', 1, 'Lightning', { startupS: [60, 90] }),
  C17: def({ icaoCode: 'C17', modelName: 'Boeing C-17 Globemaster III', weightClass: 'H', wingspanMeters: 51.8, lengthMeters: 53, safetyRadiusMeters: 35, maxTaxiSpeed: 20, taxiTurnSpeed: 8, takeoffRotationSpeed: 130, approachSpeed: 130, maxAirspeedTMA: 250, minAirspeedTMA: 120, maxClimbRate: 4500, maxDescentRate: 3000, accelerationRateAir: 2.0, decelerationRateAir: 1.5, turnRateAir: 2.0, specialRules: { wakeTurbulenceGenerator: true, wakeTurbulenceRequiredCategory: 'heavy', priorityAirspaceAccess: false, militaryManeuvering: true } }, 'jet', 4, 'Globemaster'),

  // ── VIP / State ──
  VC25: def({ icaoCode: 'VC25', modelName: 'Boeing VC-25 (Air Force One)', weightClass: 'H', wingspanMeters: 59.6, lengthMeters: 70.6, safetyRadiusMeters: 35, maxTaxiSpeed: 20, taxiTurnSpeed: 8, takeoffRotationSpeed: 145, approachSpeed: 135, maxAirspeedTMA: 250, minAirspeedTMA: 130, maxClimbRate: 3000, maxDescentRate: 2000, accelerationRateAir: 1.2, decelerationRateAir: 1.0, turnRateAir: 1.5, specialRules: { wakeTurbulenceGenerator: true, wakeTurbulenceRequiredCategory: 'heavy', priorityAirspaceAccess: true, militaryManeuvering: false } }, 'jet', 4, 'Boeing 747'),
};

export const DEFAULT_TYPE = 'B738';

export function getPerformance(icaoCode: string): AircraftPerformance {
  return AIRCRAFT_DB[icaoCode.toUpperCase()] ?? AIRCRAFT_DB[DEFAULT_TYPE];
}

/** Spoken type for an ICAO code (unknown codes are spelled as-is). */
export function spokenTypeOf(icaoCode: string): string {
  return AIRCRAFT_DB[icaoCode.toUpperCase()]?.spokenType ?? icaoCode;
}

// Legacy symmetric wake separation behind a given generator, in nautical miles
// (super -> 6NM). The engine uses the leader/follower matrix in types.ts; this
// stays for callers that only know one aircraft.
export function wakeSeparationNM(leader: AircraftPerformance): number {
  if (!leader.specialRules.wakeTurbulenceGenerator) return 3;
  return leader.specialRules.wakeTurbulenceRequiredCategory === 'super' ? 6 : 5;
}

/** V1 in knots (03 §A8). */
export function v1Kt(p: AircraftPerformance): number { return Math.round(p.takeoffRotationSpeed * p.v1Factor); }

// Common commercial pool for random spawns (weighted toward narrow-bodies).
export const COMMERCIAL_TYPES = ['B738', 'B738', 'A320', 'A320', 'A20N', 'A321', 'B38M', 'E190', 'E175', 'DH8D', 'B752', 'A333', 'A359', 'B789', 'B77W', 'B788', 'B744', 'A388'];

export function randomCommercialType(): string {
  return rnd(COMMERCIAL_TYPES);
}

// Same pool, restricted to a set of weight classes (e.g. a short runway that
// disallows Heavy/Super). Falls back to the unrestricted pool if the filter
// would leave nothing to pick from.
export function randomCommercialTypeOf(allowed?: Set<WeightClass> | null): string {
  if (!allowed || allowed.size === 0) return randomCommercialType();
  const pool = COMMERCIAL_TYPES.filter(t => allowed.has(AIRCRAFT_DB[t].weightClass));
  if (!pool.length) return randomCommercialType();
  return rnd(pool);
}
