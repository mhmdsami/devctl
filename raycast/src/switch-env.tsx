import { ActionPanel, Icon, List } from '@raycast/api'
import { withToast } from './lib/actions'
import { ErrorBoundary } from './lib/ErrorBoundary'
import { useDevctlStatus } from './lib/useDevctlStatus'

const environments = ['test', 'prod'] as const
const activeIcon = { source: Icon.CircleFilled, tintColor: '#34c759' }
const inactiveIcon = { source: Icon.Circle, tintColor: '#8e8e93' }

export default function SwitchEnv() {
  return (
    <ErrorBoundary>
      <SwitchEnvView />
    </ErrorBoundary>
  )
}

function SwitchEnvView() {
  const { status, error, isLoading, reload } = useDevctlStatus()

  return (
    <List isLoading={isLoading} navigationTitle="Switch Environment">
      {error && <List.EmptyView icon={Icon.ExclamationMark} title="Unable to load environment" description={error} />}
      {!error && environments.map((environment) => (
        <List.Item
          key={environment}
          icon={status?.env === environment ? activeIcon : inactiveIcon}
          title={environment}
          subtitle={environment === 'test' ? 'Deployed test services' : 'Deployed production services'}
          accessories={status?.env === environment ? [{ text: 'Current' }] : []}
          actions={
            <ActionPanel>
              <ActionPanel.Item
                title={`Switch to ${environment}`}
                icon={Icon.Switch}
                onAction={() => withToast(`Switching to ${environment}`, ['env', environment], reload)}
              />
            </ActionPanel>
          }
        />
      ))}
    </List>
  )
}
