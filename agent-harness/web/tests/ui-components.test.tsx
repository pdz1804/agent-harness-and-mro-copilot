import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { ApprovalBar } from '../src/components/chat/ApprovalBar'
import { Button, LinkButton, buttonClass } from '../src/components/ui/Button'
import { BulkBar } from '../src/components/ui/BulkBar'
import { Chip } from '../src/components/ui/Chip'
import { EmptyState, FilteredEmpty } from '../src/components/ui/EmptyState'
import { Segmented, Switch } from '../src/components/ui/Input'
import { NavGroup } from '../src/components/ui/NavGroup'
import { TableSkeleton } from '../src/components/ui/Skeleton'
import { StatusBadge } from '../src/components/StatusBadge'

const html = (node: React.ReactElement) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>)

describe('Button', () => {
  it('maps variant and size onto the one button class system', () => {
    expect(buttonClass({ variant: 'primary', size: 'sm' })).toBe('ui-btn ui-btn-primary ui-btn-sm')
    expect(buttonClass({ variant: 'ghost', iconOnly: true })).toBe('ui-btn ui-btn-ghost ui-btn-icon')
    expect(buttonClass({ variant: 'link' })).toContain('ui-btn-link')
    expect(buttonClass({})).toBe('ui-btn ui-btn-secondary')
  })
  it('defaults to type=button and secondary', () => {
    const out = html(<Button>Save</Button>)
    expect(out).toContain('type="button"')
    expect(out).toContain('ui-btn-secondary')
  })
  it('loading disables, sets aria-busy and swaps the icon for a spinner', () => {
    const out = html(
      <Button loading icon={<i data-icon="" />}>
        Save
      </Button>,
    )
    expect(out).toContain('disabled=""')
    expect(out).toContain('aria-busy="true"')
    expect(out).not.toContain('data-icon')
    expect(out).toContain('animate-spin')
  })
  it('renders a keyboard hint and router links with the same look', () => {
    expect(html(<Button kbd="A">Approve</Button>)).toContain('<kbd')
    const link = html(
      <LinkButton to="/chat" variant="primary">
        New run
      </LinkButton>,
    )
    expect(link).toContain('href="/chat"')
    expect(link).toContain('ui-btn-primary')
  })
})

describe('Chip and StatusBadge', () => {
  it('renders tone, dot and live pulse', () => {
    const out = html(
      <Chip tone="warn" dot live>
        Waiting
      </Chip>,
    )
    expect(out).toContain('bg-amber-50')
    expect(out).toContain('ui-live-dot')
  })
  it('pulses only live run states', () => {
    expect(html(<StatusBadge status="running" />)).toContain('ui-live-dot')
    expect(html(<StatusBadge status="completed" />)).not.toContain('ui-live-dot')
    expect(html(<StatusBadge status="pending_approval" />)).toContain('Waiting for approval')
  })
})

describe('Empty states', () => {
  it('truly empty explains, offers one action and an example', () => {
    const out = html(<EmptyState icon={<i />} title="No sessions yet" description="Start a run." action={<Button>New run</Button>} example="Try: x" />)
    expect(out).toContain('No sessions yet')
    expect(out).toContain('New run')
    expect(out).toContain('Try: x')
  })
  it('filtered-empty names the query and offers Clear filters', () => {
    const out = html(<FilteredEmpty query="payments" what="sessions" onClear={() => {}} />)
    expect(out).toContain('No sessions')
    expect(out).toContain('payments')
    expect(out).toContain('Clear filters')
  })
})

describe('Inputs', () => {
  it('Switch is a role=switch button with aria-checked', () => {
    const out = html(<Switch checked label="Enable tool" onChange={() => {}} />)
    expect(out).toContain('role="switch"')
    expect(out).toContain('aria-checked="true"')
    expect(out).toContain('aria-label="Enable tool"')
  })
  it('Segmented exposes tabs with a single tab stop', () => {
    const out = html(
      <Segmented
        label="View"
        value="b"
        onChange={() => {}}
        options={[
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B', count: 3 },
        ]}
      />,
    )
    expect(out).toContain('role="tablist"')
    expect(out.match(/tabindex="0"/g)).toHaveLength(1)
    expect(out).toMatch(/aria-selected="true"[^>]*>B/)
  })
})

describe('NavGroup', () => {
  it('is a real disclosure button, open by default', () => {
    const out = html(
      <NavGroup label="Build" count={6} active={false}>
        <a href="/agents">Agents</a>
      </NavGroup>,
    )
    expect(out).toContain('aria-expanded="true"')
    expect(out).toMatch(/aria-controls="[^"]+"/)
    expect(out).toContain('Agents')
  })
})

describe('BulkBar', () => {
  it('renders nothing with no selection and a labelled toolbar otherwise', () => {
    expect(html(<BulkBar count={0} noun="session" onClear={() => {}}>x</BulkBar>)).toBe('')
    const out = html(
      <BulkBar count={3} noun="session" onClear={() => {}}>
        <Button>Archive</Button>
      </BulkBar>,
    )
    expect(out).toContain('role="toolbar"')
    expect(out).toContain('3 sessions selected')
    expect(out).toContain('ui-glass')
  })
})

describe('ApprovalBar', () => {
  it('shows elapsed waiting time and no expiry countdown', () => {
    const out = html(<ApprovalBar toolName="create_dashboard" requestedAt={null} onDecide={async () => {}} onReview={() => {}} />)
    expect(out).toContain('create_dashboard')
    expect(out).toContain('Waiting for approval')
    expect(out).not.toMatch(/expires/i)
    expect(out).toContain('Approve')
    expect(out).toContain('Deny')
  })
  it('disables both decisions for a role that cannot decide, and says why', () => {
    const out = html(<ApprovalBar toolName="x" requestedAt={null} onDecide={async () => {}} onReview={() => {}} disabledReason="Your role (viewer) can't chat." />)
    expect(out.match(/disabled=""/g)?.length).toBe(2)
    expect(out).toContain('Your role (viewer)')
  })
})

describe('Skeletons', () => {
  it('table skeleton is a loading status shaped like a table', () => {
    const out = html(<TableSkeleton rows={2} columns={3} />)
    expect(out).toContain('role="status"')
    expect(out).toContain('ui-table-wrap')
  })
})
