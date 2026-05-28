export interface Asset2Node {
  id: string;
  name?: string;
  type: 'gate' | 'spot' | 'node' | 'runway_node';
  lat: number;
  lng: number;
  x: number;
  y: number;
}

export interface Asset2Link {
  name: string;
  type: 'runway' | 'taxiway' | 'pushback' | 'link';
  from: string | null;
  to: string | null;
  lengthFt: number;
  points: [number, number][]; // [[x,y], [x,y], ...] full polyline
}

export interface Asset2Airport {
  metadata: {
    name: string;
    icao: string;
    center: { lat: number; lng: number };
  };
  nodes: Asset2Node[];
  renderLinks: Asset2Link[];
  graphLinks: Asset2Link[];
  gates: Asset2Node[];
  spots: Asset2Node[];
}
