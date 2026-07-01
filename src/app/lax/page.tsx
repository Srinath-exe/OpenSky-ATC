import { Metadata } from 'next';
import LAXMapWrapper from '@/components/LAXMap/wrapper';

export const metadata: Metadata = {
  title: 'KLAX — Simple Airport Map',
  description: 'LAX airport map with X-Plane scenery data.',
};

export default function LAXPage() {
  return <LAXMapWrapper />;
}
