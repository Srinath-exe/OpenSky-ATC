'use client'
/*
  A film clip (scripts/learn_clips.py: 30 fps H.264 from the raea SFO film). Muted, inline; played at `rate` so its
  length fits the narration over it; an optional slow push-in over `zoomS` seconds (the caller's
  class runs it: Cinema.module.css .zoom).
*/
import * as React from 'react'

const V = '3'
let index: Record<string, { dur: number }> | null = null
let loading: Promise<Record<string, { dur: number }>> | null = null
export function loadClips(): Promise<Record<string, { dur: number }>> {
  if (index) return Promise.resolve(index)
  loading ??= fetch(`/learn/clips/index.json?v=${V}`).then((r) => r.json()).then((j) => (index = j)).catch(() => (index = {}))
  return loading
}
export const clipDur = (id: string) => index?.[id]?.dur ?? 0
export const clipUrl = (id: string) => `/learn/clips/${id}.mp4?v=${V}`

export function Clip({ id, rate = 1, loop = false, playing = true, className, zoomS, style }: { id: string; rate?: number; loop?: boolean; playing?: boolean; className?: string; zoomS?: number; style?: React.CSSProperties }) {
  const ref = React.useRef<HTMLVideoElement>(null)
  React.useEffect(() => {
    const v = ref.current; if (!v) return
    v.playbackRate = Math.max(0.5, Math.min(2, rate))
    if (playing) { if (v.ended) v.currentTime = 0; void v.play().catch(() => {}) } else v.pause()
  }, [rate, playing])
  return (
    <video ref={ref} className={className} src={clipUrl(id)} muted playsInline preload="auto" loop={loop} autoPlay={playing}
      style={{ ...style, ...(zoomS ? { ['--zoom-s' as string]: `${zoomS}s`, animationPlayState: playing ? 'running' : 'paused' } : null) }} />
  )
}
