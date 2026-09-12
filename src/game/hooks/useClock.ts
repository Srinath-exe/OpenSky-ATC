'use client'
import * as React from 'react'
import { formatTimeZ } from '@/design'

/** Wall-clock UTC "HH:MM:SS", ticking once a second. Empty string until mounted (no SSR mismatch). */
export function useUtcClock(): string {
  const [t, setT] = React.useState('')
  React.useEffect(() => {
    const tick = () => setT(formatTimeZ(new Date()))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])
  return t
}
