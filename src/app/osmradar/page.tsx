'use client';
import dynamic from 'next/dynamic';

const OsmRadar = dynamic(() => import('@/components/OsmRadar'), { ssr: false });

export default function OsmRadarPage() {
  return <OsmRadar />;
}
