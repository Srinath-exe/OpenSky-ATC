'use client'
import * as React from 'react'
import { readJson, writeJson } from '../persist'

/** useState backed by localStorage (JSON). The initial render uses `fallback` so SSR and the client agree; the stored value is applied in an effect. */
export function usePersistedState<T>(key: string, fallback: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = React.useState<T>(fallback)
  const loaded = React.useRef(false)
  React.useEffect(() => {
    setValue(readJson<T>(key, fallback))
    loaded.current = true
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  React.useEffect(() => {
    if (!loaded.current) return
    writeJson(key, value)
  }, [key, value])
  return [value, setValue]
}
