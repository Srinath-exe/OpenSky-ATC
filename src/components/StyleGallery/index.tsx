'use client';
import React, { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { STYLES, MapStyle } from '@/lib/map-styles';

interface MiniMapProps {
  style: MapStyle;
  center: [number, number];
  onClick: () => void;
}

function MiniMap({ style, center, onClick }: MiniMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const m = new maplibregl.Map({
      container: containerRef.current,
      style: style.style as any,
      center,
      zoom: 14,
      pitch: 0,
      bearing: 0,
      attributionControl: false,
      interactive: false,
    });
    mapRef.current = m;
    return () => { m.remove(); };
  }, [style, center]);

  return (
    <div
      onClick={onClick}
      className="relative cursor-pointer group overflow-hidden rounded-lg border border-slate-700 hover:border-slate-400 transition-all hover:shadow-lg hover:shadow-cyan-500/20"
    >
      <div ref={containerRef} className="w-full h-64" />
      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent pointer-events-none" />
      <div className="absolute bottom-0 left-0 right-0 p-3">
        <h3 className="text-white font-bold text-sm">{style.name}</h3>
        <p className="text-slate-400 text-xs">{style.description}</p>
      </div>
      <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <span className="bg-cyan-600 text-white text-xs px-2 py-1 rounded font-medium">Click to select</span>
      </div>
    </div>
  );
}

interface FullMapProps {
  style: MapStyle;
  center: [number, number];
  onClose: () => void;
}

function FullMap({ style, center, onClose }: FullMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [zoom, setZoom] = useState(14);

  useEffect(() => {
    if (!containerRef.current) return;
    const m = new maplibregl.Map({
      container: containerRef.current,
      style: style.style as any,
      center,
      zoom: 14,
      pitch: 0,
      bearing: 0,
      attributionControl: false,
    });
    mapRef.current = m;
    m.addControl(new maplibregl.NavigationControl({ showCompass: true, showZoom: true }), 'top-right');
    m.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-left');
    m.on('zoom', () => setZoom(Math.round(m.getZoom() * 10) / 10));
    return () => { m.remove(); };
  }, [style, center]);

  return (
    <div className="fixed inset-0 z-50 bg-black">
      <div className="absolute top-4 left-4 z-10 flex items-center gap-3">
        <button
          onClick={onClose}
          className="bg-slate-800 hover:bg-slate-700 text-white px-3 py-2 rounded-lg text-sm font-medium border border-slate-600 transition-colors"
        >
          ← Back to Gallery
        </button>
        <div className="bg-slate-800/90 text-white px-3 py-2 rounded-lg text-sm border border-slate-600">
          <span className="font-bold">{style.name}</span>
          <span className="text-slate-400 ml-2">{style.description}</span>
        </div>
      </div>
      <div className="absolute top-4 right-4 z-10">
        <div className="bg-slate-800/90 text-slate-300 px-3 py-2 rounded-lg text-xs font-mono border border-slate-600">
          Zoom: {zoom}
        </div>
      </div>
      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
}

export default function StyleGallery({ center }: { center: [number, number] }) {
  const [selected, setSelected] = useState<MapStyle | null>(null);

  return (
    <div className="min-h-screen bg-slate-950">
      {selected && (
        <FullMap style={selected} center={center} onClose={() => setSelected(null)} />
      )}

      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-white mb-2">SkyControl Airport Map Styles</h1>
          <p className="text-slate-400">
            Click any style to preview it full-screen. All styles use real SFO ASSET2 data with GPU-accelerated rendering.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {STYLES.map((style) => (
            <MiniMap
              key={style.id}
              style={style}
              center={center}
              onClick={() => setSelected(style)}
            />
          ))}
        </div>

        <div className="mt-12 p-6 bg-slate-900 rounded-lg border border-slate-800">
          <h2 className="text-lg font-bold text-white mb-3">Style Customization Guide</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
            <div>
              <h3 className="text-cyan-400 font-medium mb-1">Colors</h3>
              <p className="text-slate-400">Background, runway pavement, taxiway pavement, centerlines, gates, spots, labels</p>
            </div>
            <div>
              <h3 className="text-cyan-400 font-medium mb-1">Widths</h3>
              <p className="text-slate-400">Zoom-interpolated line widths for runways, taxiways, pushbacks</p>
            </div>
            <div>
              <h3 className="text-cyan-400 font-medium mb-1">Visibility</h3>
              <p className="text-slate-400">Min/max zoom per layer, filters by feature length or type</p>
            </div>
            <div>
              <h3 className="text-cyan-400 font-medium mb-1">New Features</h3>
              <p className="text-slate-400">Add holding positions, stop bars, wind indicators, weather overlays</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
