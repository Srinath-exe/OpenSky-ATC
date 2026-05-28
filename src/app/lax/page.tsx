import { Metadata } from 'next';
import LAXMapWrapper from '@/components/LAXMap/wrapper';

export const metadata: Metadata = {
  title: 'KLAX Experiment — OSM + X-Plane Combined Map',
  description: 'LAX airport map combining OpenStreetMap building data with X-Plane scenery data.',
};

export default function LAXPage() {
  return <LAXMapWrapper />;
}
