import { showToast, Toast } from '@raycast/api'
import { runLongCommand } from './devctl'

function lastOutputLine(output: string): string {
  return output.trim().split('\n').at(-1) || 'Done'
}

export function updateToast(toast: Toast, next: { style?: Toast.Style; title?: string; message?: string }): void {
  try {
    if (next.style) toast.style = next.style
    if (next.title) toast.title = next.title
    if (next.message !== undefined) toast.message = next.message
  } catch {}
}

export async function toastSafely(options: Toast.Options): Promise<void> {
  try {
    await showToast(options)
  } catch {}
}

const inFlight = new Set<string>()

export async function withToast(title: string, args: string[], reload?: () => void): Promise<boolean> {
  const key = args.join(' ')
  if (inFlight.has(key)) {
    await toastSafely({ style: Toast.Style.Failure, title: 'Already running', message: key })
    return false
  }
  inFlight.add(key)
  let toast: Toast
  try {
    toast = await showToast({ style: Toast.Style.Animated, title })
  } catch {
    inFlight.delete(key)
    return false
  }
  try {
    const output = await runLongCommand(args)
    updateToast(toast, { style: Toast.Style.Success, message: lastOutputLine(output) })
    return true
  } catch (error) {
    updateToast(toast, {
      style: Toast.Style.Failure,
      message: error instanceof Error ? error.message.split('\n')[0] : String(error),
    })
    return false
  } finally {
    inFlight.delete(key)
    try {
      reload?.()
    } catch {}
  }
}
