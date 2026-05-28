'use client';
import dynamic from 'next/dynamic';

const LAXMap = dynamic(() => import('./index'), {
  ssr: false,
  loading: () => (
    <div className="w-full h-screen flex items-center justify-center bg-[#f2efe9]">
      <div className="text-slate-500 font-mono text-sm">Loading map...</div>
    </div>
  ),
});

export default function LAXMapWrapper() {
  return <LAXMap />;
}
