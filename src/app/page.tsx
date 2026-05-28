import AirportMap from '@/components/AirportMap';
import airportJson from '../../public/maps/KSFO.json';
import { Asset2Airport } from '@/lib/asset2-types';

export default function Home() {
  const airport = airportJson as Asset2Airport;
  return (
    <div className="w-full h-screen">
      <AirportMap airport={airport} />
    </div>
  );
}
