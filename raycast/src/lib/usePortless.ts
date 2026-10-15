import { portlessStatusJson, type TPortlessStatus } from './devctl'
import { usePollingValue } from './usePollingValue'

export function usePortless(intervalMs = 15_000) {
  const result = usePollingValue<TPortlessStatus>(portlessStatusJson, { intervalMs })
  return {
    portless: result.data,
    error: result.error?.message ?? null,
    isLoading: result.isLoading,
    reload: result.reload,
  }
}
