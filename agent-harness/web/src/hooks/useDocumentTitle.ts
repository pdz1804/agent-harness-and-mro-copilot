import { useEffect } from 'react'
import { setItemTitle } from '../lib/document-title'

/** Put the item a page shows in the tab title ("INC-7236 · Incidents ·
 * Agent Harness"). The section comes from the route (AppShell) and the
 * pending-approvals prefix from the badge, so pages only name their item.
 * Pass `null` while it is still loading. Cleared on unmount. */
export function useDocumentTitle(item: string | null | undefined): void {
  useEffect(() => {
    setItemTitle(item ?? '')
    return () => setItemTitle('')
  }, [item])
}
