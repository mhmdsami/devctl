import { useCallback, useEffect, useState } from 'react'

interface PollingOptions {
  intervalMs?: number
}

export interface PollingValue<T> {
  data: T | null
  error: Error | null
  isLoading: boolean
  reload: () => void
}

const MAX_BACKOFF_FACTOR = 12

export function usePollingValue<T>(load: () => Promise<T>, { intervalMs }: PollingOptions = {}): PollingValue<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [reloadIndex, setReloadIndex] = useState(0)

  useEffect(() => {
    let cancelled = false
    let inFlight = false
    let failures = 0
    let timer: ReturnType<typeof setTimeout> | null = null

    function schedule(): void {
      if (cancelled || !intervalMs) return
      const factor = Math.min(2 ** failures, MAX_BACKOFF_FACTOR)
      const backoff = intervalMs * factor
      timer = setTimeout(() => void refresh(), backoff + backoff * 0.2 * Math.random())
    }

    async function refresh(): Promise<void> {
      if (inFlight) return
      inFlight = true
      try {
        const next = await load()
        if (cancelled) return
        failures = 0
        setData(next)
        setError(null)
      } catch (cause) {
        if (cancelled) return
        failures = Math.min(failures + 1, 6)
        setError(cause instanceof Error ? cause : new Error(String(cause)))
      } finally {
        inFlight = false
        schedule()
      }
    }

    void refresh()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [intervalMs, load, reloadIndex])

  return {
    data,
    error,
    isLoading: data === null && error === null,
    reload: useCallback(() => setReloadIndex((index) => index + 1), []),
  }
}
