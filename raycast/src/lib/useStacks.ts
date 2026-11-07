import { stacksJson, type TStackInfo } from './devctl'
import { usePollingValue } from './usePollingValue'

export interface TStacksData {
  stacks: TStackInfo[]
}

export function useStacks(intervalMs = 10_000) {
  const result = usePollingValue<TStacksData>(stacksJson, { intervalMs })
  return {
    stacks: result.data,
    error: result.error?.message ?? null,
    isLoading: result.isLoading,
    reload: result.reload,
  }
}
