import { Action, ActionPanel, confirmAlert, Form, Icon, Toast, useNavigation, type Image } from '@raycast/api'
import { toastSafely, withToast } from './lib/actions'
import { useState } from 'react'
import { useWorktrees } from './lib/useWorktrees'

const NONE = 'none'
const CREATE = '__create__'

type Choice = { value: string; title: string; icon?: Image.ImageLike }

export function StackForm({
  initial,
}: {
  initial?: { name: string; services: Record<string, string>; label?: string }
}) {
  const editing = Boolean(initial)
  const { pop, push } = useNavigation()
  const { worktrees: trees, error: worktreesError, isLoading: isLoadingWorktrees } = useWorktrees()
  const [members, setMembers] = useState<Record<string, string | undefined>>({})
  const [busy, setBusy] = useState(false)

  const services = [...new Set([...trees.map((t) => t.repo), ...Object.keys(initial?.services ?? {})])]
  const worktreeItems = (repo: string): Choice[] =>
    trees
      .filter((t) => t.repo === repo && t.name !== 'head')
      .map((t) => ({ value: t.name, title: t.branch && t.branch !== t.name ? `${t.branch}/${t.name}` : t.name, icon: { source: Icon.Terminal } }))

  const valueFor = (repo: string): string => members[repo] ?? initial?.services[repo] ?? NONE

  const itemsFor = (repo: string): Choice[] => {
    const current = valueFor(repo)
    const extra =
      ![NONE, CREATE, 'head', 'test', 'prod'].includes(current) && !worktreeItems(repo).some((i) => i.value === current)
        ? [{ value: current, title: current }]
        : []
    return [
      ...extra,
      { value: NONE, title: 'Not in this stack', icon: { source: Icon.Minus, tintColor: '#8e8e93' } },
      { value: 'head', title: 'current HEAD of the repo', icon: { source: Icon.House, tintColor: '#34c759' } },
      { value: CREATE, title: 'Create new worktree (branch = stack name)', icon: { source: Icon.PlusTopRightSquare, tintColor: '#34c759' } },
      { value: 'test', title: 'Deployed test', icon: { source: Icon.Globe, tintColor: '#ffcc00' } },
      { value: 'prod', title: 'Deployed prod', icon: { source: Icon.Bolt, tintColor: '#ff9f0a' } },
      ...worktreeItems(repo),
    ]
  }

  async function submit(values: Record<string, string>) {
    if (busy) return
    const name = editing ? initial!.name : values.name?.trim()
    if (!name) {
      await toastSafely({ style: Toast.Style.Failure, title: 'Stack ID is required' })
      return
    }
    const removed = editing
      ? Object.entries(initial!.services)
          .filter(([repo, wt]) => wt && wt !== 'test' && wt !== 'prod' && values[repo] === NONE)
          .map(([repo, wt]) => `${repo}/${wt}`)
      : []
    if (removed.length > 0) {
      const confirmed = await confirmAlert({
        title: `Remove ${removed.length} service(s) from ${name}?`,
        message: `${removed.join(', ')} will no longer be part of this stack. Running members keep running; worktrees are untouched.`,
        icon: Icon.Trash,
      })
      if (!confirmed) return
    }
    setBusy(true)
    try {
      const args = ['stack', 'create', name, '--yes']
      for (const svc of services) {
        const v = values[svc]
        if (v && v !== NONE) args.push(`--${svc}`, v === CREATE ? name : v)
      }
      const label = values.label?.trim() ?? ''
      if (label || editing) args.push('--label', label)
      const ok = await withToast(editing ? `Updating ${name}` : `Creating ${name}`, args)
      if (ok) pop()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Form
      isLoading={isLoadingWorktrees}
      actions={
        <ActionPanel>
          <Action.SubmitForm icon={editing ? Icon.Pencil : Icon.Box} title={editing ? 'Save Changes' : 'Create Stack'} onSubmit={submit} />
        </ActionPanel>
      }
    >
      {worktreesError && <Form.Description text={`Unable to load worktrees: ${worktreesError}`} />}

      <Form.TextField id="label" title="Stack name" defaultValue={initial?.label} placeholder="My Feature - shown in lists" />

      {!editing && (
        <Form.TextField
          id="name"
          title="Stack ID"
          placeholder="ft-my-feature"
          info="The shared branch name used as the stack's id - worktrees are created on it. An existing worktree name also works."
        />
      )}

      <Form.Separator />

      {services.map((service) => {
        const value = valueFor(service)
        return (
          <Form.Dropdown
            key={service}
            id={service}
            title={service}
            value={value}
            onChange={(next) => setMembers((current) => ({ ...current, [service]: next }))}
          >
            {itemsFor(service).map((item) => (
              <Form.Dropdown.Item key={item.value} value={item.value} title={item.title} icon={item.icon} />
            ))}
          </Form.Dropdown>
        )
      })}
    </Form>
  )
}
