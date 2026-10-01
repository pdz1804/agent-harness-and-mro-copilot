import { Sidebar as SidebarIcon } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import { useLocalStorageState } from '../../hooks/useLocalStorageState'
import type { RunSnapshot } from '../../lib/api-types'
import { ContextTab } from './ContextTab'
import { RawTab } from './RawTab'
import { ReasoningTab } from './ReasoningTab'
import { TimelineTab } from './TimelineTab'
import { ToolsTab } from './ToolsTab'
import { Button } from '../ui/Button'
import { Segmented } from '../ui/Input'

type TabId = 'timeline' | 'tools' | 'reasoning' | 'context' | 'raw'

const TABS: { id: TabId; label: string }[] = [
  { id: 'timeline', label: 'Timeline' },
  { id: 'tools', label: 'Tools' },
  { id: 'reasoning', label: 'Reasoning' },
  { id: 'context', label: 'Context' },
  { id: 'raw', label: 'Raw' },
]

const MIN_WIDTH = 320
const MAX_WIDTH = 640
const NARROW_BREAKPOINT = 1024

interface InspectorPanelProps {
  snapshot: RunSnapshot
  open: boolean
  onOpenChange: (open: boolean) => void
  focusedToolCallKey: string | null
}

/** Right-side run inspector: toggle button + `Ctrl+.` shortcut, drag-resize
 * (320-640px, persisted), collapses to a slide-over sheet under 1024px.
 * Open/width state both persist in localStorage (phase 05 spec). Purely a
 * read-over of the same `RunSnapshot`/`history` the chat view already has —
 * never a second data source, so it can never drift from what's on screen. */
export function InspectorPanel({ snapshot, open, onOpenChange, focusedToolCallKey }: InspectorPanelProps) {
  const [tab, setTab] = useLocalStorageState<TabId>('inspector.tab', 'timeline')
  const [width, setWidth] = useLocalStorageState('inspector.width', 400)
  const [isNarrow, setIsNarrow] = useState(() => window.innerWidth < NARROW_BREAKPOINT)
  const dragging = useRef(false)

  useEffect(() => {
    const onResize = () => setIsNarrow(window.innerWidth < NARROW_BREAKPOINT)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === '.') {
        e.preventDefault()
        onOpenChange(!open)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onOpenChange])

  useEffect(() => {
    if (focusedToolCallKey) setTab('tools')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedToolCallKey])

  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault()
    dragging.current = true
    const onMove = (ev: PointerEvent) => {
      if (!dragging.current) return
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, window.innerWidth - ev.clientX))
      setWidth(next)
    }
    const onUp = () => {
      dragging.current = false
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const body = (
    <div className="flex h-full flex-col" style={{ width: isNarrow ? undefined : width }}>
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--color-line)] px-3">
        <Segmented
          label="Run inspector"
          size="sm"
          value={tab}
          onChange={setTab}
          className="min-w-0"
          options={TABS.map((t) => ({ value: t.id, label: t.label }))}
        />
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          className="ml-auto shrink-0"
          icon={<SidebarIcon size={14} weight="bold" />}
          aria-label="Close inspector"
          title="Close inspector (Ctrl+.)"
          onClick={() => onOpenChange(false)}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {tab === 'timeline' && <TimelineTab events={snapshot.history} />}
        {tab === 'tools' && <ToolsTab events={snapshot.history} focusedKey={focusedToolCallKey} />}
        {tab === 'reasoning' && <ReasoningTab events={snapshot.history} />}
        {tab === 'context' && <ContextTab snapshot={snapshot} />}
        {tab === 'raw' && <RawTab snapshot={snapshot} />}
      </div>
    </div>
  )

  if (!open) return null

  if (isNarrow) {
    return (
      <div className="fixed inset-0 z-30 flex animate-fade justify-end bg-zinc-950/25 backdrop-blur-[2px]" onClick={() => onOpenChange(false)}>
        <div
          className="h-full w-full max-w-[420px] animate-drawer bg-white shadow-[var(--shadow-xl)]"
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-label="Run inspector"
        >
          {body}
        </div>
      </div>
    )
  }

  return (
    <div className="relative hidden h-full shrink-0 animate-drawer border-l border-[var(--color-line)] bg-white shadow-[-12px_0_32px_-24px_oklch(0.2_0.03_272/0.25)] lg:block">
      <div
        onPointerDown={startDrag}
        className="absolute top-0 -left-1 h-full w-2 cursor-col-resize"
        aria-hidden="true"
      />
      {body}
    </div>
  )
}
