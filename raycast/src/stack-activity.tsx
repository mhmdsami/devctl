import { Action, ActionPanel, Clipboard, confirmAlert, Icon, List, showHUD, showToast, Toast, useNavigation } from '@raycast/api'
import { useEffect, useRef, useState } from 'react'
import { followLogsInTerminal, openInEditor, revealInFinder, runLongCommand, serviceLogs, statusJson, worktreePathFor } from './lib/devctl'
import { toastSafely, withToast } from './lib/actions'
import { useDevctlStatus } from './lib/useDevctlStatus'
import { useStacks } from './lib/useStacks'
import { serviceStateLabel, stackView, type ServiceState } from './lib/stackView'
import Diagnose from './diagnose'

const SERVICE_RANK: Record<ServiceState, number> = { failed: 0, starting: 1, stopped: 2, 'external-test': 3, 'external-prod': 3, ready: 4 }

interface Props {
  name: string
  action: 'up' | 'down' | 'view'
}

export function StackActivity({ name, action }: Props) {
  const { stacks, error: stacksError } = useStacks()
  const { status, error: statusError, isLoading } = useDevctlStatus(2_000)
  const { push } = useNavigation()
  const started = useRef(false)
  const [commandState, setCommandState] = useState<'running' | 'complete' | 'failed'>(action === 'view' ? 'complete' : 'running')
  const [commandError, setCommandError] = useState<string | null>(null)
  const definition = stacks?.stacks.find((stack) => stack.name === name)
  const view = definition ? stackView(definition, status) : null

  useEffect(() => {
    if (action === 'view' || started.current) return
    started.current = true
    let cancelled = false
    void runLongCommand(['stack', action, name])
      .then(() => {
        if (!cancelled) setCommandState('complete')
      })
      .catch(async (cause) => {
        if (cancelled) return
        const message = cause instanceof Error ? cause.message : String(cause)
        setCommandError(message)
        setCommandState('failed')
        await toastSafely({ style: Toast.Style.Failure, title: `Unable to ${action} stack`, message })
      })
    return () => {
      cancelled = true
    }
  }, [action, name])

  return (
    <List navigationTitle={`${action === 'view' ? 'Stack services' : `${action} stack`}: ${name}`} isLoading={isLoading || commandState === 'running'}>
      {(stacksError || statusError || commandError) && (
        <List.Section title="Problems">
          <List.Item
            icon={Icon.ExclamationMark}
            title={commandError ? `Unable to ${action} stack` : 'Status may be incomplete'}
            subtitle={commandError ?? stacksError ?? statusError ?? undefined}
            actions={commandError ? <ActionPanel><Action.CopyToClipboard title="Copy Full Error" content={commandError} /></ActionPanel> : undefined}
          />
        </List.Section>
      )}
      <List.Section title="Services">
        {(view?.services ?? []).slice().sort((a, b) => SERVICE_RANK[a.state] - SERVICE_RANK[b.state]).map((service) => {
          const icon = service.state === 'ready'
            ? { source: Icon.CheckCircle, tintColor: '#34c759' }
            : service.state === 'starting'
              ? { source: Icon.Clock, tintColor: '#ffcc00' }
              : service.state === 'failed'
                ? { source: Icon.ExclamationMark, tintColor: '#ff3b30' }
                : service.state.startsWith('external-')
                  ? { source: Icon.Globe, tintColor: '#0a84ff' }
                  : Icon.Circle
          return (
            <List.Item
              key={service.repo}
              icon={icon}
              title={`${service.repo}/${service.target}`}
              subtitle={service.url ?? undefined}
              accessories={[{ text: serviceStateLabel(service.state) }]}
              actions={
                <ActionPanel>
                  <ActionPanel.Section title="Service">
                  {service.url && <Action.OpenInBrowser title="Open Service" url={service.url} />}
                  {service.local && service.state === 'stopped' && (
                    <ActionPanel.Item
                      title="Start Service"
                      icon={Icon.Play}
                      shortcut={{ modifiers: ['cmd'], key: 'return' }}
                      onAction={() => {
                        const target = `${service.repo}/${service.target}`
                        void withToast(`Starting ${target}`, ['up', target])
                      }}
                    />
                  )}
                  {service.local && service.state !== 'stopped' && (
                    <ActionPanel.Item
                      title="Restart Service"
                      icon={Icon.ArrowClockwise}
                      shortcut={{ modifiers: ['cmd'], key: 'r' }}
                      onAction={async () => {
                        const confirmed = await confirmAlert({
                          title: `Restart ${service.repo}/${service.target}?`,
                          message: 'Stops the service (ownership-checked) and starts it again with fresh env.',
                          icon: Icon.ArrowClockwise,
                        })
                        if (confirmed) void withToast(`Restarting ${service.key}`, ['restart', `${service.repo}/${service.target}`])
                      }}
                    />
                  )}
                  {service.local && service.state !== 'stopped' && (
                    <ActionPanel.Item
                      title="Diagnose"
                      icon={Icon.MedicalSupport}
                      shortcut={{ modifiers: ['cmd', 'shift'], key: 'd' }}
                      onAction={() => push(<Diagnose target={service.key} title={`${service.repo}/${service.target}`} />)}
                    />
                  )}
                  </ActionPanel.Section>
                  <ActionPanel.Section title="Workspace">
                  {service.local && (
                    <ActionPanel.Item title={`Focus ${service.repo}`} icon={Icon.Terminal} shortcut={{ modifiers: ['cmd'], key: 'f' }} onAction={() => withToast(`Focusing ${service.repo}`, ['attach', service.key])} />
                  )}
                  {service.local && (
                    <ActionPanel.Item
                      title="Open in Editor"
                      icon={Icon.Pencil}
                      shortcut={{ modifiers: ['cmd'], key: 'o' }}
                      onAction={async () => {
                        try {
                          const path = await worktreePathFor(service.repo, service.target)
                          if (!path) throw new Error('worktree not found')
                          await openInEditor(path)
                        } catch (cause) {
                          await toastSafely({ style: Toast.Style.Failure, title: 'Unable to open editor', message: cause instanceof Error ? cause.message : String(cause) })
                        }
                      }}
                    />
                  )}
                  {service.local && (
                    <ActionPanel.Item
                      title="Follow Logs in Terminal"
                      icon={Icon.Terminal}
                      onAction={async () => {
                        try {
                          const status = await statusJson()
                          const logFile = status.stacks.find((s) => s.key === service.key)?.ref?.logFile
                          if (!logFile) throw new Error('no log file tracked for this service')
                          await followLogsInTerminal(logFile)
                        } catch (cause) {
                          await toastSafely({ style: Toast.Style.Failure, title: 'Unable to open Terminal', message: cause instanceof Error ? cause.message : String(cause) })
                        }
                      }}
                    />
                  )}
                  {service.local && (
                    <ActionPanel.Submenu title="Worktree" icon={Icon.Folder} shortcut={{ modifiers: ['cmd'], key: 'w' }}>
                      <ActionPanel.Item
                        title="Reveal in Finder"
                        icon={Icon.Finder}
                        onAction={async () => {
                          try {
                            const path = await worktreePathFor(service.repo, service.target)
                            if (!path) throw new Error('worktree not found')
                            await revealInFinder(path)
                          } catch (cause) {
                            await toastSafely({ style: Toast.Style.Failure, title: 'Unable to reveal', message: cause instanceof Error ? cause.message : String(cause) })
                          }
                        }}
                      />
                    </ActionPanel.Submenu>
                  )}
                  </ActionPanel.Section>
                  <ActionPanel.Section title="Export">
                  {service.url && (
                    <ActionPanel.Item title="Copy URL" icon={Icon.CopyClipboard} shortcut={{ modifiers: ['cmd'], key: 'c' }} onAction={async () => {
                    if (!service.url) return
                    try {
                      await Clipboard.copy(service.url)
                      await showHUD('URL copied')
                    } catch (cause) {
                      await toastSafely({ style: Toast.Style.Failure, title: 'Unable to copy URL', message: cause instanceof Error ? cause.message : String(cause) })
                    }
                  }} />
                  )}
                  {service.local && (
                    <ActionPanel.Item
                      title="Copy Recent Logs"
                      icon={Icon.Document}
                      onAction={async () => {
                        try {
                          await Clipboard.copy(await serviceLogs(`${service.repo}/${service.target}`))
                          await showHUD(`${service.repo} logs copied`)
                        } catch (cause) {
                          await toastSafely({ style: Toast.Style.Failure, title: 'Unable to read logs', message: cause instanceof Error ? cause.message : String(cause) })
                        }
                      }}
                    />
                  )}
                  </ActionPanel.Section>
                </ActionPanel>
              }
            />
          )
        })}
        {definition && view?.services.length === 0 && <List.EmptyView title="This stack has no services" />}
        {!definition && !stacksError && <List.EmptyView title="Loading stack definition…" />}
      </List.Section>
    </List>
  )
}
