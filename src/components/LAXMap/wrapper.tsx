'use client';
import dynamic from 'next/dynamic';
import { GMSProvider } from '@/context/GroundTrafficContext';

const LAXMap = dynamic(() => import('./index'), {
  ssr: false,
  loading: () => (
    <div className="w-full h-screen flex items-center justify-center bg-[#111827]">
      <div className="text-gray-400 font-mono text-sm">Loading map...</div>
    </div>
  ),
});

export default function LAXMapWrapper() {
  return (
    <GMSProvider>
      <LAXMap />
    </GMSProvider>
  );
}
