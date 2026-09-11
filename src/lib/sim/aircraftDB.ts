// ============================================================
//  Aircraft Performance Database  (aircraft_performance_database.md)
//
//  Every ICAO type maps to a weight class and a set of physical coefficients
//  that drive the physics in aircraft.ts (taxi/turn/takeoff speeds, climb &
//  descent rates, air turn rate, acceleration) plus special gameplay rules
//  (wake turbulence, priority access, military manoeuvring).
// ============================================================

export type WeightClass = 'L' | 'M' | 'H' | 'S';
export type WakeCat = 'none' | 'light' | 'heavy' | 'super';

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
}

const noRules = {
  wakeTurbulenceGenerator: false,
  wakeTurbulenceRequiredCategory: 'none' as WakeCat,
  priorityAirspaceAccess: false,
  militaryManeuvering: false,
};

export const AIRCRAFT_DB: Record<string, AircraftPerformance> = {
  // ── Light ──
  C172: { icaoCode: 'C172', modelName: 'Cessna 172 Skyhawk', weightClass: 'L', wingspanMeters: 11, lengthMeters: 8.2, safetyRadiusMeters: 15, maxTaxiSpeed: 15, taxiTurnSpeed: 8, takeoffRotationSpeed: 65, approachSpeed: 70, maxAirspeedTMA: 120, minAirspeedTMA: 50, maxClimbRate: 700, maxDescentRate: 500, accelerationRateAir: 2.0, decelerationRateAir: 1.5, turnRateAir: 3.0, specialRules: { ...noRules } },
  PA28: { icaoCode: 'PA28', modelName: 'Piper PA-28 Cherokee', weightClass: 'L', wingspanMeters: 10.7, lengthMeters: 7.3, safetyRadiusMeters: 15, maxTaxiSpeed: 15, taxiTurnSpeed: 8, takeoffRotationSpeed: 63, approachSpeed: 66, maxAirspeedTMA: 120, minAirspeedTMA: 48, maxClimbRate: 700, maxDescentRate: 500, accelerationRateAir: 2.0, decelerationRateAir: 1.5, turnRateAir: 3.0, specialRules: { ...noRules } },

  // ── Medium ──
  B738: { icaoCode: 'B738', modelName: 'Boeing 737-800', weightClass: 'M', wingspanMeters: 35.8, lengthMeters: 39.5, safetyRadiusMeters: 25, maxTaxiSpeed: 20, taxiTurnSpeed: 10, takeoffRotationSpeed: 140, approachSpeed: 145, maxAirspeedTMA: 250, minAirspeedTMA: 130, maxClimbRate: 2500, maxDescentRate: 1500, accelerationRateAir: 1.6, decelerationRateAir: 1.2, turnRateAir: 2.0, specialRules: { wakeTurbulenceGenerator: false, wakeTurbulenceRequiredCategory: 'heavy', priorityAirspaceAccess: false, militaryManeuvering: false } },
  A320: { icaoCode: 'A320', modelName: 'Airbus A320', weightClass: 'M', wingspanMeters: 35.8, lengthMeters: 37.6, safetyRadiusMeters: 25, maxTaxiSpeed: 20, taxiTurnSpeed: 10, takeoffRotationSpeed: 138, approachSpeed: 140, maxAirspeedTMA: 250, minAirspeedTMA: 128, maxClimbRate: 2500, maxDescentRate: 1500, accelerationRateAir: 1.6, decelerationRateAir: 1.2, turnRateAir: 2.0, specialRules: { wakeTurbulenceGenerator: false, wakeTurbulenceRequiredCategory: 'heavy', priorityAirspaceAccess: false, militaryManeuvering: false } },
  A20N: { icaoCode: 'A20N', modelName: 'Airbus A320neo', weightClass: 'M', wingspanMeters: 35.8, lengthMeters: 37.6, safetyRadiusMeters: 25, maxTaxiSpeed: 20, taxiTurnSpeed: 10, takeoffRotationSpeed: 135, approachSpeed: 138, maxAirspeedTMA: 250, minAirspeedTMA: 125, maxClimbRate: 2700, maxDescentRate: 1500, accelerationRateAir: 1.7, decelerationRateAir: 1.2, turnRateAir: 2.0, specialRules: { wakeTurbulenceGenerator: false, wakeTurbulenceRequiredCategory: 'heavy', priorityAirspaceAccess: false, militaryManeuvering: false } },
  E190: { icaoCode: 'E190', modelName: 'Embraer E190', weightClass: 'M', wingspanMeters: 28.7, lengthMeters: 36.2, safetyRadiusMeters: 22, maxTaxiSpeed: 20, taxiTurnSpeed: 10, takeoffRotationSpeed: 135, approachSpeed: 140, maxAirspeedTMA: 250, minAirspeedTMA: 125, maxClimbRate: 2600, maxDescentRate: 1500, accelerationRateAir: 1.6, decelerationRateAir: 1.2, turnRateAir: 2.2, specialRules: { wakeTurbulenceGenerator: false, wakeTurbulenceRequiredCategory: 'heavy', priorityAirspaceAccess: false, militaryManeuvering: false } },

  // ── Heavy ──
  B77W: { icaoCode: 'B77W', modelName: 'Boeing 777-300ER', weightClass: 'H', wingspanMeters: 64.8, lengthMeters: 73.9, safetyRadiusMeters: 40, maxTaxiSpeed: 20, taxiTurnSpeed: 8, takeoffRotationSpeed: 150, approachSpeed: 149, maxAirspeedTMA: 250, minAirspeedTMA: 140, maxClimbRate: 3000, maxDescentRate: 2000, accelerationRateAir: 1.2, decelerationRateAir: 0.9, turnRateAir: 1.5, specialRules: { wakeTurbulenceGenerator: true, wakeTurbulenceRequiredCategory: 'heavy', priorityAirspaceAccess: false, militaryManeuvering: false } },
  B789: { icaoCode: 'B789', modelName: 'Boeing 787-9 Dreamliner', weightClass: 'H', wingspanMeters: 60.1, lengthMeters: 62.8, safetyRadiusMeters: 38, maxTaxiSpeed: 20, taxiTurnSpeed: 9, takeoffRotationSpeed: 150, approachSpeed: 145, maxAirspeedTMA: 250, minAirspeedTMA: 138, maxClimbRate: 3000, maxDescentRate: 2000, accelerationRateAir: 1.2, decelerationRateAir: 0.9, turnRateAir: 1.6, specialRules: { wakeTurbulenceGenerator: true, wakeTurbulenceRequiredCategory: 'heavy', priorityAirspaceAccess: false, militaryManeuvering: false } },
  A359: { icaoCode: 'A359', modelName: 'Airbus A350-900', weightClass: 'H', wingspanMeters: 64.8, lengthMeters: 66.8, safetyRadiusMeters: 40, maxTaxiSpeed: 20, taxiTurnSpeed: 9, takeoffRotationSpeed: 150, approachSpeed: 145, maxAirspeedTMA: 250, minAirspeedTMA: 138, maxClimbRate: 3000, maxDescentRate: 2000, accelerationRateAir: 1.2, decelerationRateAir: 0.9, turnRateAir: 1.6, specialRules: { wakeTurbulenceGenerator: true, wakeTurbulenceRequiredCategory: 'heavy', priorityAirspaceAccess: false, militaryManeuvering: false } },
  A333: { icaoCode: 'A333', modelName: 'Airbus A330-300', weightClass: 'H', wingspanMeters: 60.3, lengthMeters: 63.7, safetyRadiusMeters: 38, maxTaxiSpeed: 20, taxiTurnSpeed: 9, takeoffRotationSpeed: 145, approachSpeed: 140, maxAirspeedTMA: 250, minAirspeedTMA: 135, maxClimbRate: 2800, maxDescentRate: 2000, accelerationRateAir: 1.2, decelerationRateAir: 0.9, turnRateAir: 1.6, specialRules: { wakeTurbulenceGenerator: true, wakeTurbulenceRequiredCategory: 'heavy', priorityAirspaceAccess: false, militaryManeuvering: false } },
  B788: { icaoCode: 'B788', modelName: 'Boeing 787-8 Dreamliner', weightClass: 'H', wingspanMeters: 60.1, lengthMeters: 56.7, safetyRadiusMeters: 38, maxTaxiSpeed: 20, taxiTurnSpeed: 9, takeoffRotationSpeed: 150, approachSpeed: 145, maxAirspeedTMA: 250, minAirspeedTMA: 138, maxClimbRate: 3000, maxDescentRate: 2000, accelerationRateAir: 1.2, decelerationRateAir: 0.9, turnRateAir: 1.6, specialRules: { wakeTurbulenceGenerator: true, wakeTurbulenceRequiredCategory: 'heavy', priorityAirspaceAccess: false, militaryManeuvering: false } },
  B38M: { icaoCode: 'B38M', modelName: 'Boeing 737 MAX 8', weightClass: 'M', wingspanMeters: 35.9, lengthMeters: 39.5, safetyRadiusMeters: 25, maxTaxiSpeed: 20, taxiTurnSpeed: 10, takeoffRotationSpeed: 140, approachSpeed: 145, maxAirspeedTMA: 250, minAirspeedTMA: 130, maxClimbRate: 2600, maxDescentRate: 1500, accelerationRateAir: 1.6, decelerationRateAir: 1.2, turnRateAir: 2.0, specialRules: { wakeTurbulenceGenerator: false, wakeTurbulenceRequiredCategory: 'heavy', priorityAirspaceAccess: false, militaryManeuvering: false } },

  // ── Super Heavy ──
  A388: { icaoCode: 'A388', modelName: 'Airbus A380-800', weightClass: 'S', wingspanMeters: 80, lengthMeters: 73, safetyRadiusMeters: 45, maxTaxiSpeed: 20, taxiTurnSpeed: 8, takeoffRotationSpeed: 150, approachSpeed: 140, maxAirspeedTMA: 250, minAirspeedTMA: 135, maxClimbRate: 2800, maxDescentRate: 2000, accelerationRateAir: 1.0, decelerationRateAir: 0.8, turnRateAir: 1.5, specialRules: { wakeTurbulenceGenerator: true, wakeTurbulenceRequiredCategory: 'super', priorityAirspaceAccess: false, militaryManeuvering: false } },
  B748: { icaoCode: 'B748', modelName: 'Boeing 747-8', weightClass: 'S', wingspanMeters: 68.4, lengthMeters: 76.3, safetyRadiusMeters: 42, maxTaxiSpeed: 20, taxiTurnSpeed: 8, takeoffRotationSpeed: 155, approachSpeed: 145, maxAirspeedTMA: 250, minAirspeedTMA: 140, maxClimbRate: 2800, maxDescentRate: 2000, accelerationRateAir: 1.0, decelerationRateAir: 0.8, turnRateAir: 1.5, specialRules: { wakeTurbulenceGenerator: true, wakeTurbulenceRequiredCategory: 'super', priorityAirspaceAccess: false, militaryManeuvering: false } },

  // ── Military ──
  F18: { icaoCode: 'F18', modelName: 'F/A-18 Hornet', weightClass: 'M', wingspanMeters: 13.6, lengthMeters: 17.1, safetyRadiusMeters: 12, maxTaxiSpeed: 25, taxiTurnSpeed: 12, takeoffRotationSpeed: 130, approachSpeed: 155, maxAirspeedTMA: 350, minAirspeedTMA: 110, maxClimbRate: 12000, maxDescentRate: 8000, accelerationRateAir: 15.0, decelerationRateAir: 8.0, turnRateAir: 6.0, specialRules: { wakeTurbulenceGenerator: false, wakeTurbulenceRequiredCategory: 'none', priorityAirspaceAccess: false, militaryManeuvering: true } },
  F35: { icaoCode: 'F35', modelName: 'F-35 Lightning II', weightClass: 'M', wingspanMeters: 10.7, lengthMeters: 15.7, safetyRadiusMeters: 12, maxTaxiSpeed: 25, taxiTurnSpeed: 12, takeoffRotationSpeed: 135, approachSpeed: 150, maxAirspeedTMA: 350, minAirspeedTMA: 115, maxClimbRate: 12000, maxDescentRate: 8000, accelerationRateAir: 15.0, decelerationRateAir: 8.0, turnRateAir: 6.0, specialRules: { wakeTurbulenceGenerator: false, wakeTurbulenceRequiredCategory: 'none', priorityAirspaceAccess: false, militaryManeuvering: true } },
  C17: { icaoCode: 'C17', modelName: 'Boeing C-17 Globemaster III', weightClass: 'H', wingspanMeters: 51.8, lengthMeters: 53, safetyRadiusMeters: 35, maxTaxiSpeed: 20, taxiTurnSpeed: 8, takeoffRotationSpeed: 130, approachSpeed: 130, maxAirspeedTMA: 250, minAirspeedTMA: 120, maxClimbRate: 4500, maxDescentRate: 3000, accelerationRateAir: 2.0, decelerationRateAir: 1.5, turnRateAir: 2.0, specialRules: { wakeTurbulenceGenerator: true, wakeTurbulenceRequiredCategory: 'heavy', priorityAirspaceAccess: false, militaryManeuvering: true } },

  // ── VIP / State ──
  VC25: { icaoCode: 'VC25', modelName: 'Boeing VC-25 (Air Force One)', weightClass: 'H', wingspanMeters: 59.6, lengthMeters: 70.6, safetyRadiusMeters: 35, maxTaxiSpeed: 20, taxiTurnSpeed: 8, takeoffRotationSpeed: 145, approachSpeed: 135, maxAirspeedTMA: 250, minAirspeedTMA: 130, maxClimbRate: 3000, maxDescentRate: 2000, accelerationRateAir: 1.2, decelerationRateAir: 1.0, turnRateAir: 1.5, specialRules: { wakeTurbulenceGenerator: true, wakeTurbulenceRequiredCategory: 'heavy', priorityAirspaceAccess: true, militaryManeuvering: false } },
};

export const DEFAULT_TYPE = 'B738';

export function getPerformance(icaoCode: string): AircraftPerformance {
  return AIRCRAFT_DB[icaoCode] ?? AIRCRAFT_DB[DEFAULT_TYPE];
}

// Wake separation behind a given generator, in nautical miles (super → 6NM).
export function wakeSeparationNM(leader: AircraftPerformance): number {
  if (!leader.specialRules.wakeTurbulenceGenerator) return 3;
  return leader.specialRules.wakeTurbulenceRequiredCategory === 'super' ? 6 : 5;
}

// Common commercial pool for random spawns.
export const COMMERCIAL_TYPES = ['B738', 'A320', 'A20N', 'B38M', 'E190', 'A333', 'A359', 'B789', 'B77W', 'B788'];

export function randomCommercialType(): string {
  return COMMERCIAL_TYPES[Math.floor(Math.random() * COMMERCIAL_TYPES.length)];
}

// Same pool, restricted to a set of weight classes (e.g. a short runway that
// disallows Heavy/Super). Falls back to the unrestricted pool if the filter
// would leave nothing to pick from.
export function randomCommercialTypeOf(allowed?: Set<WeightClass> | null): string {
  if (!allowed || allowed.size === 0) return randomCommercialType();
  const pool = COMMERCIAL_TYPES.filter(t => allowed.has(AIRCRAFT_DB[t].weightClass));
  if (!pool.length) return randomCommercialType();
  return pool[Math.floor(Math.random() * pool.length)];
}
