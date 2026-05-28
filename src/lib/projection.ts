import { Airport, LocalPoint } from '@/lib/types';

// Local Azimuthal Equidistant Projection centered on airport reference point
export function projectAirportToLocal(airport: Airport): Airport {
  const R = 6_371_000; // Earth radius in meters
  const ref = airport.referencePoint;
  const toLocal = (lat: number, lng: number): LocalPoint => {
    const x = R * Math.cos((ref.lat * Math.PI) / 180) * ((lng - ref.lng) * Math.PI) / 180;
    const y = R * ((lat - ref.lat) * Math.PI) / 180;
    return { x, y };
  };

  return {
    ...airport,
    runways: airport.runways.map(r => ({
      ...r,
      localStart: toLocal(r.start.lat, r.start.lng),
      localEnd: toLocal(r.end.lat, r.end.lng),
    })),
    gates: airport.gates.map(g => ({
      ...g,
      localPosition: toLocal(g.position.lat, g.position.lng),
    })),
    taxiNodes: airport.taxiNodes.map(n => ({
      ...n,
      localPosition: toLocal(n.position.lat, n.position.lng),
    })),
  };
}
