'use client';
import dynamic from 'next/dynamic';

const GroundRadar = dynamic(() => import('@/components/GroundRadar'), { ssr: false });

export default function GroundRadarPage() {
  return <GroundRadar />;
}
