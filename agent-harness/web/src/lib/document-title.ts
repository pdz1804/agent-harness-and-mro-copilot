import { tabTitle } from './pending-approvals'

/** The browser tab title is composed from three independent writers, so none
 * of them can clobber another: the shell sets the section from the route, a
 * detail view sets the item it shows, and the approvals badge sets the waiting
 * count. Result: "(1) INC-7236 · Incidents · Agent Harness". */
export const APP_NAME = 'Agent Harness'

const state = { section: '', item: '', count: 0 }

export function composeTitle(section: string, item: string, count: number): string {
  const parts = [item, section && section !== APP_NAME ? section : '', APP_NAME].filter(Boolean)
  // An item equal to its section ("Incidents · Incidents") reads as a stutter.
  const unique = parts.filter((p, i) => parts.indexOf(p) === i)
  return tabTitle(unique.join(' · '), count)
}

function apply(): void {
  document.title = composeTitle(state.section, state.item, state.count)
}

export function setSectionTitle(section: string): void {
  state.section = section
  apply()
}

const itemListeners = new Set<() => void>()

export function setItemTitle(item: string): void {
  if (state.item === item) return
  state.item = item
  apply()
  itemListeners.forEach((listener) => listener())
}

/** The item the current detail view names (also used as the last breadcrumb). */
export function getItemTitle(): string {
  return state.item
}

export function subscribeItemTitle(listener: () => void): () => void {
  itemListeners.add(listener)
  return () => itemListeners.delete(listener)
}

export function setApprovalCount(count: number): void {
  state.count = count
  apply()
}
