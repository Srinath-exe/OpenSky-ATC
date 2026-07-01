// Compatibility shim — the real implementation now lives in airportData.ts.
// Kept so any code still importing from '@/lib/taxiwayGraph' keeps working.
export {
  buildTaxiGraph,
  planRoute,
  findNearestNode,
  findNearestGate,
  resolveDestination,
  loadAirportBundle,
  type TaxiGraph,
  type TaxiNode,
  type TaxiEdge,
  type HoldLine,
  type GateNode,
  type RunwayThreshold,
  type TaxiRoute,
  type TaxiRouteSegment,
  type RouteEndpoint,
  type RouteConstraints,
  type AirportGeojsonBundle,
} from './airportData';