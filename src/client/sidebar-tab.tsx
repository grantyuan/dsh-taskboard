/**
 * Right-sidebar tab for the board (DSH `sidebar.right.pane.tab`).
 *
 * Registers a page TYPE (so `openTab('taskboard')` resolves and the host
 * shows a chip) plus its body seat; the tab shares the main panel's
 * BoardController — one snapshot, one SSE stream, one source of truth.
 *
 * Everything is soft: compositions without the sidebar services never
 * register and the board stays main-panel only. The services can also
 * arrive after our apply, so registration re-polls briefly.
 *
 * @module dsh-taskboard/client/sidebar-tab
 */
import * as React from 'react'
import type { BoardController } from './controller.ts'
import { TaskBoard } from './board/TaskBoard.tsx'
import { translate } from './i18n/runtime.ts'
import { OFFICIAL_PANEL_ID, type MountContextFace } from './official-panel.tsx'

/** Implementation id in the tab system (the key body registers under). */
export const BOARD_TAB_ID = `${OFFICIAL_PANEL_ID}/board-tab`

/** Tab kind `openTab` names. */
export const BOARD_TAB_KIND = 'taskboard'

/** Narrow face of ctx.get('sidebarRightTabs'). */
interface SidebarRightTabsFace {
  register(definition: Record<string, unknown>): () => void
}

/** Narrow face of ctx.get('slots') (same shape official-panel uses). */
interface SlotsServiceFace {
  inject(key: string, callback: () => unknown): () => void
  register(options: Record<string, unknown>, component: (props: never) => React.ReactNode): () => void
}

/** Narrow face of ctx.get('sidebarRight'). */
interface SidebarRightFace {
  openTab(kind: string, options?: Record<string, unknown>): void
}

/** How long to wait for the sidebar services to appear after our apply. */
const REGISTER_POLL_MS = 250
const REGISTER_DEADLINE_MS = 4000

/** Build the tab body; the host renderer owns its React root. */
function makeBoardTabBody(controller: BoardController): (props: Record<string, unknown>) => React.ReactNode {
  return function BoardTabBody(): React.ReactNode {
    return React.createElement(
      'div',
      { 'data-dsh-atb-sidebar-root': '', className: 'dsh-atb-sidebar-root' },
      React.createElement(TaskBoard, { controller }),
    )
  }
}

/**
 * Register the tab type + body seat and hand the controller its opener.
 * @param ctx - client context (soft accessors only).
 * @param controller - shared board controller.
 * @returns disposer that unregisters everything and hides the toolbar button.
 */
export function registerBoardSidebarTab(ctx: MountContextFace, controller: BoardController): () => void {
  const disposers: Array<() => void> = []
  let poll: ReturnType<typeof setTimeout> | undefined
  let deadline = Date.now() + REGISTER_DEADLINE_MS
  const register = (): boolean => {
    const tabs = ctx.get?.('sidebarRightTabs') as SidebarRightTabsFace | undefined
    const slots = ctx.get?.('slots') as SlotsServiceFace | undefined
    if (tabs === undefined || slots === undefined) return false
    disposers.push(tabs.register({
      id: BOARD_TAB_ID,
      kind: BOARD_TAB_KIND,
      title: () => translate('shared.entry.label'),
      // The board is global (not session-scoped): keep it alive across tab
      // switches so column scroll positions survive reveal/hide cycles.
      keepMounted: true,
    }))
    const body = makeBoardTabBody(controller) as unknown as (props: never) => React.ReactNode
    disposers.push(slots.inject('sidebar.right.pane.tab', () => slots.register(
      { name: 'sidebar.right.pane.tab', key: BOARD_TAB_ID }, body,
    )))
    // Resolved at click time — the navigation service may still arrive later.
    controller.installSidebarTabOpener(() => {
      const sidebar = ctx.get?.('sidebarRight') as SidebarRightFace | undefined
      if (sidebar === undefined) return
      sidebar.openTab(BOARD_TAB_KIND)
    })
    return true
  }
  const tick = (): void => {
    if (register()) return
    if (Date.now() < deadline) poll = setTimeout(tick, REGISTER_POLL_MS)
  }
  if (!register()) poll = setTimeout(tick, REGISTER_POLL_MS)
  return () => {
    if (poll !== undefined) clearTimeout(poll)
    controller.installSidebarTabOpener(undefined)
    for (const cleanup of disposers.splice(0).reverse()) cleanup()
  }
}
