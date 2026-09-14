'use client'
/*
  Liquid-glass lens: an SVG filter the glass surfaces reference from backdrop-filter (GlassPanel.module.css,
  html[data-lens="1"]). A displacement map pulls the blurred backdrop toward the centre in a band along the edges, so the
  rim of every pane reads as thick glass bending what is behind it. Chromium only (Safari / Firefox do not apply SVG
  filters to backdrops) and only on the high graphics tier - it is decoration, and it costs a pass per pane.
*/
import * as React from 'react'
import { useDetected, useGraphicsPref } from '@/components/atc/WorldMap/quality'

/** The rim band and its displacement, as two images stretched over each pane: `disp` (R = x, G = y; 128 = no shift)
 *  pulls samples toward the centre, `mask` (alpha) is 1 in the band along the edges and 0 inside - rounded-rect SDF,
 *  the band covering the outer 11 % of the half-extent. */
function lensMaps(n = 96): { disp: string; mask: string } {
  const c = document.createElement('canvas'); c.width = n; c.height = n
  const ctx = c.getContext('2d')!; const img = ctx.createImageData(n, n)
  const m = document.createElement('canvas'); m.width = n; m.height = n
  const mctx = m.getContext('2d')!; const mimg = mctx.createImageData(n, n)
  const r = 0.22          // corner radius in half-extent units
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const px = (x + 0.5) / n * 2 - 1, py = (y + 0.5) / n * 2 - 1        // -1..1
    // rounded-rect signed distance (inside negative) and its outward gradient
    const qx = Math.abs(px) - (1 - r), qy = Math.abs(py) - (1 - r)
    const ox = Math.max(qx, 0), oy = Math.max(qy, 0)
    const d = Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r     // 0 at the edge
    let nx: number, ny: number
    if (qx > 0 && qy > 0) { const l = Math.hypot(ox, oy) || 1; nx = ox / l; ny = oy / l } else if (qx > qy) { nx = 1; ny = 0 } else { nx = 0; ny = 1 }
    nx *= Math.sign(px) || 1; ny *= Math.sign(py) || 1
    const t = Math.min(1, Math.max(0, 1 + d / 0.11))                     // 0 deep inside .. 1 at the edge
    const band = t * t * (3 - 2 * t)
    const i = (y * n + x) * 4
    img.data[i] = Math.round(128 - nx * band * 120); img.data[i + 1] = Math.round(128 - ny * band * 120); img.data[i + 2] = 128; img.data[i + 3] = 255
    mimg.data[i] = 255; mimg.data[i + 1] = 255; mimg.data[i + 2] = 255; mimg.data[i + 3] = Math.round(band * 255)
  }
  ctx.putImageData(img, 0, 0); mctx.putImageData(mimg, 0, 0)
  return { disp: c.toDataURL('image/png'), mask: m.toDataURL('image/png') }
}

export function LiquidGlassDefs() {
  const detected = useDetected()
  const pref = useGraphicsPref()
  const [map, setMap] = React.useState<{ disp: string; mask: string } | null>(null)
  const chromium = typeof navigator !== 'undefined' && /Chrome\//.test(navigator.userAgent) && !/Edg\/1[0-6]/.test(navigator.userAgent)
  const on = chromium && (pref === 'high' || (pref === 'auto' && detected?.tier === 'high')) && !(typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-transparency: reduce)').matches)
  React.useEffect(() => { if (on && !map) setMap(lensMaps()) }, [on, map])
  React.useEffect(() => {
    if (on && map) document.documentElement.setAttribute('data-lens', '1'); else document.documentElement.removeAttribute('data-lens')
    return () => document.documentElement.removeAttribute('data-lens')
  }, [on, map])
  if (!on || !map) return null
  return (
    <svg width="0" height="0" style={{ position: 'absolute', width: 0, height: 0 }} aria-hidden="true">
      <defs>
        {/* interior: frosted (blur 14); rim band: lightly blurred backdrop bent toward the centre, i.e. the lens */}
        <filter id="lg-lens" x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
          <feImage href={map.disp} preserveAspectRatio="none" result="disp" />
          <feImage href={map.mask} preserveAspectRatio="none" result="mask" />
          <feGaussianBlur in="SourceGraphic" stdDeviation="2.5" result="soft" />
          <feDisplacementMap in="soft" in2="disp" scale="40" xChannelSelector="R" yChannelSelector="G" result="bent" />
          <feComposite in="bent" in2="mask" operator="in" result="rim" />
          <feGaussianBlur in="SourceGraphic" stdDeviation="14" result="frost" />
          <feComposite in="rim" in2="frost" operator="over" />
        </filter>
      </defs>
    </svg>
  )
}
