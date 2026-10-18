import { Action, ActionPanel, Detail } from '@raycast/api'
import { useEffect, useState } from 'react'
import { spawnDevctl } from './lib/devctl'

export default function Diagnose({ target, title }: { target: string; title: string }) {
  const [output, setOutput] = useState('Starting the debug agent…')
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let buffer = ''
    const handle = spawnDevctl(['diagnose', target], (chunk) => {
      if (cancelled) return
      buffer += chunk
      setOutput(buffer)
    })
    handle.promise
      .then((code) => {
        if (cancelled) return
        if (code !== 0 && !buffer.trim()) setError(`devctl exited with code ${code}`)
      })
      .catch((cause) => {
        if (cancelled) return
        const message = cause instanceof Error ? cause.message : String(cause)
        setError(message)
        setOutput(`Diagnosis failed: ${message}`)
      })
      .finally(() => {
        if (!cancelled) setDone(true)
      })
    return () => {
      cancelled = true
      handle.kill()
    }
  }, [target])

  const markdown = error
    ? `## Diagnosing \`${target}\`\n\n**Error**\n\n\`\`\`\n${error}\n\`\`\``
    : `## Diagnosing \`${target}\`\n\nThe debug agent reads the service's recent logs and reports a root cause.\n\n\`\`\`\n${output.trim()}\n\`\`\``

  return (
    <Detail
      isLoading={!done}
      navigationTitle={`Diagnose ${title}`}
      markdown={markdown}
      actions={
        <ActionPanel>
          <Action.CopyToClipboard title="Copy Diagnosis" content={output} />
        </ActionPanel>
      }
    />
  )
}
