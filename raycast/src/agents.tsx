import { Action, ActionPanel, Clipboard, Icon, List, showToast, Toast } from '@raycast/api'
import { useEffect, useState } from 'react'
import { agentSessions, type TAgentSessionInfo } from './lib/devctl'
import { ErrorBoundary } from './lib/ErrorBoundary'

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

export default function Agents() {
  return (
    <ErrorBoundary>
      <AgentsView />
    </ErrorBoundary>
  )
}

function AgentsView() {
  const [sessions, setSessions] = useState<TAgentSessionInfo[]>([])
  const [loading, setLoading] = useState(true)

  async function load() {
    setLoading(true)
    try {
      setSessions(await agentSessions())
    } catch (error) {
      await showToast({ style: Toast.Style.Failure, title: 'Could not load sessions', message: error instanceof Error ? error.message : String(error) })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  const groups = new Map<string, TAgentSessionInfo[]>()
  for (const session of sessions) {
    const key = session.link ?? session.suggestion ?? 'unassigned'
    groups.set(key, [...(groups.get(key) ?? []), session])
  }

  return (
    <List isLoading={loading} searchBarPlaceholder="Filter sessions">
      {[...groups.entries()].map(([group, items]) => (
        <List.Section key={group} title={group === 'unassigned' ? 'Unassigned' : group}>
          {items.map((session) => (
            <List.Item
              key={`${session.agent}:${session.id}`}
              icon={Icon.Terminal}
              title={session.title || '(untitled)'}
              subtitle={session.agent}
              accessories={[
                ...(session.repo ? [{ text: session.repo }] : []),
                ...(session.state === 'archived' ? [{ tag: 'archived' }] : []),
              ]}
              actions={
                <ActionPanel>
                  {session.resume && (
                    <Action.CopyToClipboard
                      title="Copy Resume Command"
                      content={session.resume.map(shellQuote).join(' ')}
                      onCopy={() => showToast({ style: Toast.Style.Success, title: 'Copied resume command' })}
                    />
                  )}
                  <Action.CopyToClipboard title="Copy Session ID" content={session.id} />
                  {session.note && <Action.CopyToClipboard title="Copy Note" content={session.note} />}
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      ))}
    </List>
  )
}
