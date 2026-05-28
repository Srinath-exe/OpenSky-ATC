// SkyControl Shared Types - mirrors the Airport Data Model spec

export interface Coordinate {
  lat: number;
  lng: number;
  alt?: number;
}

export interface LocalPoint {
  x: number;
  y: number;
  alt?: number;
}

export interface Runway {
  designator: string;
  start: Coordinate;
  end: Coordinate;
  widthMeters: number;
  localStart?: LocalPoint;
  localEnd?: LocalPoint;
}

export interface Gate {
  id: string;
  terminal: string;
  position: Coordinate;
  pushbackHeading: number;
  localPosition?: LocalPoint;
}

export interface TaxiNode {
  id: string;
  position: Coordinate;
  type: 'intersection' | 'gate_entry' | 'runway_entry' | 'hold_short';
  localPosition?: LocalPoint;
}

export interface TaxiEdge {
  name: string;
  fromNodeId: string;
  toNodeId: string;
  isOneWay: boolean;
}

export interface AirspaceWaypoint {
  name: string;
  position: Coordinate;
}

export interface Airport {
  icao: string;
  name: string;
  referencePoint: Coordinate;
  runways: Runway[];
  gates: Gate[];
  taxiNodes: TaxiNode[];
  taxiEdges: TaxiEdge[];
  waypoints: AirspaceWaypoint[];
}

export interface AircraftPerformance {
  icaoCode: string;
  modelName: string;
  weightClass: 'L' | 'M' | 'H' | 'S';
  wingspanMeters: number;
  lengthMeters: number;
  safetyRadiusMeters: number;
  maxTaxiSpeed: number;
  takeoffRotationSpeed: number;
  approachSpeed: number;
  maxAirspeedTMA: number;
  minAirspeedTMA: number;
  maxClimbRate: number;
  maxDescentRate: number;
  accelerationRateAir: number;
  decelerationRateAir: number;
  turnRateAir: number;
  specialRules: {
    wakeTurbulenceGenerator: boolean;
    wakeTurbulenceRequiredCategory: 'none' | 'light' | 'heavy' | 'super';
    priorityAirspaceAccess: boolean;
    militaryManeuvering: boolean;
  };
}
