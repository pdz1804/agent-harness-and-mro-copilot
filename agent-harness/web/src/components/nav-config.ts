import {
  BookOpen,
  Brain,
  ChartBar,
  ClipboardText,
  FileText,
  Lightning,
  ListMagnifyingGlass,
  Plug,
  PlusCircle,
  Pulse,
  Robot,
  ShieldCheck,
  Warning,
  Wrench,
  type Icon,
} from '@phosphor-icons/react'

export interface NavItem {
  to: string
  label: string
  icon: Icon
  /** Extra words the command palette matches (what people call this page). */
  keywords: string
  end?: boolean
}

export interface NavGroup {
  label: string | null
  items: NavItem[]
}

/** The workspace navigation, in sidebar order. The sidebar renders it and the
 * Ctrl+K palette searches it, so the two can never drift apart. "Sessions" has
 * its own expandable section in the sidebar and is added to the palette
 * separately (see `PALETTE_PAGES`). */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: null,
    items: [{ to: '/chat', label: 'New run', icon: PlusCircle, keywords: 'chat start ask agent', end: true }],
  },
  {
    label: 'Workspace',
    items: [
      { to: '/memory', label: 'Memory', icon: Brain, keywords: 'remember recall facts long-term' },
      { to: '/services', label: 'Services', icon: Pulse, keywords: 'status health degraded down' },
      { to: '/incidents', label: 'Incidents', icon: Warning, keywords: 'acknowledge resolve outage' },
      { to: '/knowledge', label: 'Knowledge base', icon: BookOpen, keywords: 'docs runbooks retrieval search' },
      { to: '/settings/integrations', label: 'Integrations', icon: Plug, keywords: 'tools timeout retry schema' },
      { to: '/guardrails', label: 'Guardrails', icon: ShieldCheck, keywords: 'safety rules block sandbox' },
      { to: '/automations', label: 'Automations', icon: Lightning, keywords: 'triggers rules events' },
    ],
  },
  {
    label: 'Build',
    items: [
      { to: '/agents', label: 'Agents', icon: Robot, keywords: 'assistants clone test chat' },
      { to: '/skills', label: 'Skills', icon: Wrench, keywords: 'router routing capabilities' },
      { to: '/prompts', label: 'Prompts', icon: FileText, keywords: 'versions playground verify' },
      { to: '/dashboards', label: 'Dashboards', icon: ChartBar, keywords: 'widgets charts' },
      { to: '/evals', label: 'Evals', icon: ClipboardText, keywords: 'judge scores feedback quality' },
      { to: '/logs', label: 'Logs', icon: ListMagnifyingGlass, keywords: 'audit trace export runs' },
    ],
  },
]

/** Every page the palette can open, including the sessions list. */
export const PALETTE_PAGES: { to: string; label: string; keywords: string }[] = [
  NAV_GROUPS[0].items[0],
  { to: '/sessions', label: 'Sessions', keywords: 'history chats conversations search archive' },
  ...NAV_GROUPS.slice(1).flatMap((g) => g.items),
].map(({ to, label, keywords }) => ({ to, label, keywords }))
