/**
 * Archived-session claim auto-release (objective: a claim whose holding
 * agent-session is archived must never strand a card). Three release paths:
 *  1. lazy — taskboard_move/taskboard_delete by another session release an
 *     archived foreign hold instead of refusing;
 *  2. execution gate — run() re-claims a card whose foreign holder is
 *     archived;
 *  3. proactive — the session-sync sweep returns such cards to todo with a
 *     system comment, independent of the syncExternalSessions setting.
 * Fail-safe: without authoritative archive evidence every guard keeps the
 * old strict behaviour.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { registerTaskboardTools, type WorkspaceFace } from '../src/host/tools.ts'
import { TaskStore } from '../src/host/store.ts'
import { ExecutionService, type AgentsFace, type EventsFace } from '../src/host/execution.ts'
import { ExternalSessionSyncService } from '../src/host/session-sync.ts'
import type { TaskRecord } from '../src/shared/protocol.ts'

let dir: string
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'tb-arch-claim-')) })
afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

const ARCHIVED = 'session-dead'
const LIVE = 'session-live'

function face(archived: ReadonlySet<string>, withProbe = true): WorkspaceFace {
  return {
    resolveByPath: async path => (path === '/proj/a' ? { id: 'ws-a' } : undefined),
    get: id => (id === 'ws-a' ? { id: 'ws-a', path: '/proj/a', title: 'A' } : undefined),
    list: () => [{ id: 'ws-a', path: '/proj/a', title: 'A' }],
    ...(withProbe ? { isSessionArchived: (sessionId: string) => archived.has(sessionId) } : {}),
  }
}

async function toolSetup(probe: boolean) {
  const store = new TaskStore({ file: join(dir, `led-${Math.random().toString(36).slice(2)}.json`) })
  const registered: Array<Record<string, unknown>> = []
  registerTaskboardTools(
    { tools: { register: tool => { registered.push(tool); return () => {} } } },
    { store, workspaces: face(new Set([ARCHIVED]), probe), now: () => 7_000 },
  )
  const tool = (name: string): { execute(args: unknown, exec: unknown): Promise<unknown> } =>
    registered.find(t => t.name === name) as never
  const exec = { agent: { id: 'session-1', session: { header: { cwd: '/proj/a' } } } }
  const make = async (title: string, holder?: string) => {
    const { task } = await tool('taskboard_create').execute({ title, workspaceId: 'ws-a', urgency: 'normal' }, exec) as { task: { id: string } }
    if (holder !== undefined) {
      await store.mutate('task-moved', ledger => {
        const t = ledger.tasks.find(x => x.id === task.id)!
        t.status = 'in_progress'
        t.claimedBy = holder
        t.claimedAt = 6_000
        t.version += 1
        return [t]
      })
    }
    return task.id
  }
  return { store, tool, exec, make }
}

describe('lazy release on agent status changes (tools)', () => {
  it('a move by another session releases an archived foreign hold instead of refusing', async () => {
    const { store, tool, exec, make } = await toolSetup(true)
    const id = await make('Held by archived', ARCHIVED)
    await expect(tool('taskboard_move').execute({ id, status: 'todo', ifVersion: 2 }, exec)).resolves.toBeDefined()
    const t = store.get(id)!
    expect(t.status).toBe('todo')
    expect(t.claimedBy).toBeUndefined()
    expect(t.claimedAt).toBeUndefined()
    // The card is now claimable: the release is durable, not just per-call.
    await expect(tool('taskboard_move').execute({ id, status: 'in_progress', ifVersion: t.version }, exec)).resolves.toBeDefined()
    expect(store.get(id)!.claimedBy).toBe('session-1')
  })

  it('a live foreign hold still refuses (strict guard unchanged)', async () => {
    const { store, tool, exec, make } = await toolSetup(true)
    const id = await make('Held by live', LIVE)
    await expect(tool('taskboard_move').execute({ id, status: 'todo', ifVersion: 2 }, exec))
      .rejects.toThrow('task is held by session session-live')
    const t = store.get(id)!
    expect(t.status).toBe('in_progress')
    expect(t.claimedBy).toBe(LIVE)
    expect(t.version).toBe(2)
  })

  it('without the archive probe every foreign hold still refuses (fail-safe)', async () => {
    const { tool, exec, make } = await toolSetup(false)
    const id = await make('Held by archived, probe absent', ARCHIVED)
    await expect(tool('taskboard_move').execute({ id, status: 'todo', ifVersion: 2 }, exec))
      .rejects.toThrow('task is held by session')
  })

  it('delete releases an archived hold; a live hold still refuses', async () => {
    const { store, tool, exec, make } = await toolSetup(true)
    const dead = await make('Trash archived', ARCHIVED)
    await expect(tool('taskboard_delete').execute({ id: dead, ifVersion: 2 }, exec)).resolves.toEqual({ trashed: true })
    const rec = store.get(dead)!
    expect(rec.trashedAt).toBeDefined()
    expect(rec.claimedBy).toBeUndefined()
    const live = await make('Trash live', LIVE)
    await expect(tool('taskboard_delete').execute({ id: live, ifVersion: 2 }, exec))
      .rejects.toThrow('task is held by session session-live')
  })
})

function execTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 't-run',
    title: 'Run me',
    description: '',
    prompt: 'DO THE THING',
    workspaceId: 'ws-a',
    urgency: 'normal',
    status: 'todo',
    blocked: false,
    execution: { mode: 'claim' },
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    createdBy: { kind: 'user' },
    updatedBy: { kind: 'user' },
    comments: [],
    executions: [],
    ...overrides,
  }
}

async function execStore(...tasks: TaskRecord[]): Promise<TaskStore> {
  const store = new TaskStore({ file: join(dir, `led-${Math.random().toString(36).slice(2)}.json`) })
  await store.mutate('task-created', ledger => {
    ledger.tasks.push(...tasks)
    return [...tasks]
  })
  return store
}

function fakeAgents(): AgentsFace & { created: Array<{ sessionId: string }> } {
  const created: Array<{ sessionId: string }> = []
  return {
    created,
    async create(options: { sessionId: string }) {
      created.push({ sessionId: options.sessionId })
      return {
        agent: {
          id: options.sessionId,
          followup: () => {},
          inject: () => {},
          whenIdle: () => new Promise<void>(() => {}),
        },
        dispose: async () => {},
      }
    },
  } as never
}

const noEvents: EventsFace = { onSessionEvent: () => () => {} }

describe('execution start gate', () => {
  it('re-claims a card whose foreign holder is archived', async () => {
    const held = execTask({ status: 'in_progress', claimedBy: ARCHIVED, claimedAt: 1 })
    const store = await execStore(held)
    const agents = fakeAgents()
    const svc = new ExecutionService({
      store, agents, events: noEvents, now: () => 1_000,
      workspaces: {
        get: id => (id === 'ws-a' ? { id: 'ws-a', path: '/proj/a' } : undefined),
        attach: async () => {},
        isSessionArchived: id => id === ARCHIVED,
      },
    })
    const result = await svc.run(held.id, 'manual')
    expect(result.ok).toBe(true)
    const after = store.get(held.id)!
    expect(after.claimedBy).toBeDefined()
    expect(after.claimedBy).not.toBe(ARCHIVED)
    expect(after.executions).toHaveLength(1)
    expect(after.executions[0]!.outcome).toBe('running')
    svc.dispose()
  })

  it('a live foreign claim still blocks the gate', async () => {
    const held = execTask({ id: 't-held', status: 'in_progress', claimedBy: LIVE, claimedAt: 1 })
    const store = await execStore(held)
    const svc = new ExecutionService({
      store, agents: fakeAgents(), events: noEvents, now: () => 1_000,
      workspaces: {
        get: id => (id === 'ws-a' ? { id: 'ws-a', path: '/proj/a' } : undefined),
        attach: async () => {},
        isSessionArchived: id => id === ARCHIVED,
      },
    })
    expect(await svc.run(held.id, 'manual')).toEqual({ ok: false, error: 'task is already in progress' })
    expect(store.get(held.id)!.claimedBy).toBe(LIVE)
    svc.dispose()
  })
})

describe('proactive sweep (session-sync)', () => {
  async function syncHarness(probe: boolean, managed: string[] = []) {
    const store = new TaskStore({ file: join(dir, `led-${Math.random().toString(36).slice(2)}.json`) })
    const service = new ExternalSessionSyncService({
      store,
      workspaces: face(new Set([ARCHIVED]), probe),
      events: noEvents,
      now: () => 9_000,
      scanIntervalMs: 0,
      isSessionManaged: sessionId => managed.includes(sessionId),
    })
    return { store, service }
  }

  it('returns archived-held cards to todo with a system comment, settings-independent', async () => {
    const stranded = execTask({ id: 't-strand', status: 'in_progress', claimedBy: ARCHIVED, claimedAt: 2 })
    const held = execTask({ id: 't-live', status: 'in_progress', claimedBy: LIVE, claimedAt: 2 })
    const running = execTask({
      id: 't-running', status: 'in_progress', claimedBy: ARCHIVED, claimedAt: 2,
      executions: [{ id: 'e-live', sessionId: ARCHIVED, trigger: 'manual', startedAt: 0, outcome: 'running' }],
    })
    const { store, service } = await syncHarness(true)
    await store.mutate('task-created', ledger => { ledger.tasks.push(stranded, held, running); return [] })
    // syncExternalSessions is OFF (default) — the sweep must still run.
    await service.releaseArchivedClaims()
    const t = store.get('t-strand')!
    expect(t.status).toBe('todo')
    expect(t.claimedBy).toBeUndefined()
    expect(t.claimedAt).toBeUndefined()
    expect(t.updatedBy).toEqual({ kind: 'system' })
    expect(t.comments).toHaveLength(1)
    expect(t.comments[0]!.systemKey).toBe('sys.claimReleasedArchived')
    expect(t.comments[0]!.threadId).toBe(ARCHIVED)
    expect(store.get('t-live')!.status).toBe('in_progress')
    expect(store.get('t-running')!.status).toBe('in_progress')
    expect(store.get('t-running')!.claimedBy).toBe(ARCHIVED)
    service.dispose()
  })

  it('skips sessions the execution service still manages', async () => {
    const managedTask = execTask({ id: 't-managed', status: 'in_progress', claimedBy: ARCHIVED, claimedAt: 2 })
    const { store, service } = await syncHarness(true, [ARCHIVED])
    await store.mutate('task-created', ledger => { ledger.tasks.push(managedTask); return [] })
    await service.releaseArchivedClaims()
    expect(store.get('t-managed')!.claimedBy).toBe(ARCHIVED)
    service.dispose()
  })

  it('does nothing when the workspace face lacks the probe', async () => {
    const stranded = execTask({ id: 't-noprobe', status: 'in_progress', claimedBy: ARCHIVED, claimedAt: 2 })
    const { store, service } = await syncHarness(false)
    await store.mutate('task-created', ledger => { ledger.tasks.push(stranded); return [] })
    await service.releaseArchivedClaims()
    expect(store.get('t-noprobe')!.claimedBy).toBe(ARCHIVED)
    expect(store.get('t-noprobe')!.comments).toHaveLength(0)
    service.dispose()
  })
})
