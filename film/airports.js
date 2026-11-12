// Per-airport film settings: who flies, which runways, the city on the horizon, the camera's opening moves.
// Geometry (runways, stands, routes) comes from prep.py's jfk.json (named for the first airport; any ICAO).
// traffic: id -> [callsign, type, airline]
export const AIRPORTS = {
  KSFO: {
    arrName: '28R', depName: '1R', turn: 1, d1t0: -268, heroGold: true, heavies: true, // departures turn right (east, over the bay)
    traffic: {
      hero: ['SJX12', 'A359', 'Starlux'], a2: ['ASA331', 'A320', 'Alaska'], a3: ['JAL2', 'B77W', 'JAL'], a4: ['SIA31', 'A359', 'Singapore'],
      a5: ['SWA1924', 'B738', 'Southwest'], a0: ['UAL1531', 'A320', 'United'],
      d1: ['CPA873', 'B77W', 'Cathay'], d2: ['DLH455', 'B744', 'Lufthansa'], d3: ['UAE226', 'A388', 'Emirates'], d4: ['UAL1191', 'A320', 'United'], d5: ['SWA2051', 'B738', 'Southwest'],
    },
    // the loop: arrivals in this order (number 0 is the hero), and the departure we follow
    cycle: [['SJX12', 'A359', 'Starlux'], ['ASA331', 'A320', 'Alaska'], ['JAL2', 'B77W', 'JAL'], ['UAL1531', 'A320', 'United'], ['SIA31', 'A359', 'Singapore'],
      ['SWA1924', 'B738', 'Southwest'], ['UAL837', 'B77W', 'United'], ['KAL23', 'A388', 'Korean Air'], ['AAL20', 'B738', 'American'], ['QFA73', 'B744', 'Qantas'],
      ['DAL1583', 'A320', 'Delta'], ['EVA28', 'B77W', 'EVA Air'], ['UAL1724', 'B738', 'United']],
    cycleDep: ['DLH455', 'B744', 'Lufthansa'],
    // [lat, lon, half-width, half-depth (units), count, max height (units), grid angle (deg)]
    city: [
      [37.7905, -122.3990, 26, 30, 420, 27, 45],   // Financial District, SoMa
      [37.7700, -122.4300, 70, 60, 260, 4, 0],     // the low city
      [37.8035, -122.2715, 20, 20, 130, 14, 30],   // downtown Oakland
    ],
    landmarks: [[37.7897, -122.3972, 33, 1.9], [37.7952, -122.4028, 26, 1.4]], // Salesforce Tower, Transamerica
    cityLabel: 'SAN FRANCISCO', cityAt: [37.7905, -122.3990],
  },
  KJFK: {
    arrName: '31R', depName: '31L', turn: -1,
    traffic: {
      hero: ['DAL220', 'A359', 'Delta'], a2: ['JBU623', 'A320', 'JetBlue'], a3: ['AAL2', 'B77W', 'American'], a4: ['UAE203', 'B77W', 'Emirates'],
      a5: ['BAW117', 'B77W', 'Speedbird'], a0: ['JBU1104', 'A320', 'JetBlue'],
      d1: ['AFR7', 'B77W', 'Air France'], d2: ['DAL400', 'A320', 'Delta'], d3: ['JBU1001', 'A320', 'JetBlue'], d4: ['KLM642', 'A359', 'KLM'], d5: ['UAL1532', 'B738', 'United'],
    },
    city: [[40.7549, -73.984, 28, 95, 420, 34, 29], [40.7095, -74.0105, 22, 32, 220, 30, 29], [40.693, -73.985, 40, 30, 120, 12, 29], [40.747, -73.944, 25, 22, 90, 16, 29]],
    landmarks: [[40.713, -74.0132, 54, 2.2], [40.7484, -73.9857, 44, 2.4]],
    cityLabel: 'MANHATTAN', cityAt: [40.7549, -73.984],
  },
};
