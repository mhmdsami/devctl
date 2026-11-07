import { statusJson, type TStackStatus } from './devctl'
import { usePollingValue } from './usePollingValue'

export function useDevctlStatus(intervalMs = 10_000) {
  const result = usePollingValue<TStackStatus>(statusJson, { intervalMs })
  return {
    status: result.data,
    error: result.error?.message ?? null,
    isLoading: result.isLoading,
    reload: result.reload,
  }
}
