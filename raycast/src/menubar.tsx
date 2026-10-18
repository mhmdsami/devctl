import { Clipboard, confirmAlert, Icon, MenuBarExtra, open, showToast, Toast } from '@raycast/api'
import { run, runLongCommand, serviceLogs } from './lib/devctl'
import { useDevctlStatus } from './lib/useDevctlStatus'
import { useStacks } from './lib/useStacks'
import { usePortless } from './lib/usePortless'
import { toastSafely, updateToast, withToast } from './lib/actions'
import { ErrorBoundary } from './lib/ErrorBoundary'
import { serviceStateLabel, stackView, type ServiceState } from './lib/stackView'

const stateIcon = (state: ServiceState | 'external') => {
  if (state === 'ready') return { source: Icon.CircleFilled, tintColor: '#34c759' }
  if (state === 'starting') return { source: Icon.Clock, tintColor: '#ffcc00' }
  if (state === 'failed') return { source: Icon.ExclamationMark, tintColor: '#ff3b30' }
  if (state === 'external' || state.startsWith('external-')) return { source: Icon.Globe, tintColor: '#0a84ff' }
  return { source: Icon.Circle, tintColor: '#8e8e93' }
}

export default function Menubar() {
  return (
    <ErrorBoundary fallback={<MenuBarExtra icon={Icon.ExclamationMark} title="devctl error" />}>
      <MenubarView />
    </ErrorBoundary>
  )
}

function MenubarView() {
  const { status, error: statusError, isLoading, reload: reloadStatus } = useDevctlStatus(5_000)
  const { stacks, error: stacksError, reload: reloadStacks } = useStacks(15_000)
  const { portless, error: portlessError } = usePortless(15_000)
  const rows = (stacks?.stacks ?? []).map((stack) => stackView(stack, status))
  const failed = rows.filter((row) => row.state === 'failed').length
  const starting = rows.filter((row) => row.state === 'starting').length
  const active = rows.filter((row) => row.state === 'ready' || row.state === 'external').length
  const title = failed
    ? `${failed} failed`
    : starting
      ? `${starting} starting`
      : active
        ? String(active)
        : undefined
  const icon = failed
    ? { source: Icon.Terminal, tintColor: '#ff3b30' }
    : starting
      ? { source: Icon.Terminal, tintColor: '#ffcc00' }
      : { source: Icon.Terminal, tintColor: active ? '#34c759' : '#8e8e93' }
  const reload = () => {
    reloadStatus()
    reloadStacks()
  }

  return (
    <MenuBarExtra icon={icon} title={title} isLoading={isLoading}>
      {(statusError || stacksError) && <MenuBarExtra.Item icon={Icon.ExclamationMark} title={`devctl error: ${statusError ?? stacksError}`} />}
      <MenuBarExtra.Section title="Stacks">
        {rows.map((row) => (
          <MenuBarExtra.Submenu
            key={row.id}
            icon={stateIcon(row.state === 'external' ? 'external' : row.state)}
            title={`${row.title} (${row.ready}/${row.localTotal} local)`}
          >
            {row.services.map((service) => (
              <MenuBarExtra.Submenu
                key={service.repo}
                icon={stateIcon(service.state)}
                title={`${service.repo}/${service.target} · ${serviceStateLabel(service.state)}`}
              >
                {service.url && <MenuBarExtra.Item icon={Icon.Globe} title="Open URL" onAction={() => open(service.url!)} />}
                {service.url && (
                  <MenuBarExtra.Item
                    icon={Icon.CopyClipboard}
                    title="Copy URL"
                    onAction={async () => {
                      try {
                        await Clipboard.copy(service.url!)
                        await toastSafely({ style: Toast.Style.Success, title: 'URL copied' })
                      } catch (cause) {
                        await toastSafely({ style: Toast.Style.Failure, title: 'Unable to copy URL', message: cause instanceof Error ? cause.message : String(cause) })
                      }
                    }}
                  />
                )}
                {service.local && (
                  <MenuBarExtra.Item
                    icon={Icon.Document}
                    title="Copy Recent Logs"
                    onAction={async () => {
                      try {
                        await Clipboard.copy(await serviceLogs(`${service.repo}/${service.target}`))
                        await toastSafely({ style: Toast.Style.Success, title: `${service.repo} logs copied` })
                      } catch (cause) {
                        await toastSafely({ style: Toast.Style.Failure, title: 'Unable to read logs', message: cause instanceof Error ? cause.message : String(cause) })
                      }
                    }}
                  />
                )}
                {service.local && ['failed', 'starting', 'ready'].includes(service.state) && (
                  <MenuBarExtra.Item
                    icon={Icon.MedicalSupport}
                    title="Diagnose"
                    onAction={async () => {
                      const target = `${service.repo}/${service.target}`
                      const toast = await showToast({ style: Toast.Style.Animated, title: `Diagnosing ${target}` }).catch(() => null)
                      if (!toast) return
                      try {
                        const parsed = JSON.parse(await runLongCommand(['diagnose', target, '--json'])) as { diagnosis?: string }
                        const lines = (parsed.diagnosis ?? '').split('\n')
                        const summary = lines.filter((line) => /^ROOT CAUSE:|^FIX:/.test(line)).join('\n') || (lines.at(-1) ?? 'See logs')
                        updateToast(toast, { style: Toast.Style.Success, title: target, message: summary })
                      } catch (cause) {
                        updateToast(toast, {
                          style: Toast.Style.Failure,
                          title: 'Diagnose failed',
                          message: cause instanceof Error ? cause.message.split('\n')[0] : String(cause),
                        })
                      }
                    }}
                  />
                )}
              </MenuBarExtra.Submenu>
            ))}
            {row.running ? (
              <MenuBarExtra.Item icon={Icon.Stop} title="Stop Stack" onAction={() => withToast(`Stopping ${row.title}`, ['stack', 'down', row.id], reload)} />
            ) : (
              <MenuBarExtra.Item icon={Icon.Play} title="Start Stack" onAction={() => withToast(`Starting ${row.title}`, ['stack', 'up', row.id], reload)} />
            )}
            <MenuBarExtra.Item
              icon={Icon.CopyClipboard}
              title="Copy Agent Context"
              onAction={async () => {
                try {
                  await Clipboard.copy(await run(['context', row.id]))
                  await toastSafely({ style: Toast.Style.Success, title: `${row.title} agent context copied` })
                } catch (cause) {
                  await toastSafely({ style: Toast.Style.Failure, title: 'Unable to copy agent context', message: cause instanceof Error ? cause.message : String(cause) })
                }
              }}
            />
            <MenuBarExtra.Item
              icon={Icon.Trash}
              title="Delete Stack"
              onAction={async () => {
                const confirmed = await confirmAlert({
                  title: `Delete ${row.title}?`,
                  message: 'Stops the stack, removes it from devctl, and deletes its worktrees. Branches are kept.',
                  icon: Icon.Trash,
                })
                if (confirmed) await withToast(`Deleting ${row.title}`, ['stack', 'delete', row.id, '--yes'], reload)
              }}
            />
          </MenuBarExtra.Submenu>
        ))}
        {rows.length === 0 && <MenuBarExtra.Item title="No stacks. Open Manage Stack to create one." />}
      </MenuBarExtra.Section>
      <MenuBarExtra.Section title="Environment">
        <MenuBarExtra.Submenu icon={Icon.Globe} title={`Environment: ${status?.env ?? 'Loading…'}`}>
          {(['test', 'prod'] as const).map((environment) => (
            <MenuBarExtra.Item
              key={environment}
              title={environment}
              icon={status?.env === environment ? stateIcon('ready') : stateIcon('stopped')}
              onAction={() => withToast(`Switching to ${environment}`, ['env', environment], reload)}
            />
          ))}
        </MenuBarExtra.Submenu>
      </MenuBarExtra.Section>
      <MenuBarExtra.Section title="Network">
        <MenuBarExtra.Submenu
          icon={portless?.usable && portless.proxyUp ? { source: Icon.Globe, tintColor: '#34c759' } : Icon.Globe}
          title={`Portless: ${portless ? (portless.usable ? (portless.proxyUp ? 'ok' : 'proxy down') : 'missing') : portlessError ? 'error' : 'Loading…'}`}
        >
          {portlessError && <MenuBarExtra.Item icon={Icon.ExclamationMark} title={portlessError} />}
          {!portlessError && portless && !portless.usable && (
            <MenuBarExtra.Item icon={Icon.Circle} title="Not installed - devctl needs it (Node 24+)" />
          )}
          {!portlessError && portless?.usable && (
            <MenuBarExtra.Item icon={Icon.CircleFilled} title="Routing: named URLs" />
          )}
          {!portlessError && portless?.usable && (
            <MenuBarExtra.Item
              icon={portless.proxyUp ? Icon.CircleFilled : Icon.Circle}
              title={`Proxy: ${portless.proxyUp ? `up on ${portless.port}` : 'down'}`}
            />
          )}
          {!portlessError && portless?.usable && (
            <MenuBarExtra.Item icon={Icon.Link} title={`Routes: ${portless.routes.length}`} />
          )}
          {!portlessError &&
            portless?.usable &&
            portless.routes.map((route) => (
              <MenuBarExtra.Item
                key={route}
                icon={Icon.Globe}
                title={route}
                onAction={() => open(portless && portless.port !== 443 ? `https://${route}:${portless.port}` : `https://${route}`)}
              />
            ))}
        </MenuBarExtra.Submenu>
      </MenuBarExtra.Section>
      <MenuBarExtra.Section title="Actions">
        <MenuBarExtra.Item icon={Icon.Terminal} title="Focus Workspace" onAction={() => withToast('Focusing workspace', ['attach'])} />
      </MenuBarExtra.Section>
    </MenuBarExtra>
  )
}
