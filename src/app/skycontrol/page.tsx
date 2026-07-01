'use client';
import dynamic from 'next/dynamic';

const SkyControl = dynamic(() => import('@/components/SkyControl'), { ssr: false });

export default function SkyControlPage() {
  return <SkyControl />;
}
