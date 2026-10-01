import { PencilSimple, Path, ShieldWarning, Trash, Wrench } from '@phosphor-icons/react'
import type { Skill, ToolCatalogEntry } from '../../lib/api-types'
import { useDocumentTitle } from '../../hooks/useDocumentTitle'
import { Button, Chip, CopyId, FactList, RelativeTime, RowActions, Sheet, SheetSection, Switch, type RowAction } from '../ui'

interface SkillDetailSheetProps {
  skill: Skill
  tools: ToolCatalogEntry[]
  canWrite: boolean
  writeReason: string
  togglePending: boolean
  onClose: () => void
  onPrev?: () => void
  onNext?: () => void
  onEdit: () => void
  onToggle: (enabled: boolean) => void
  onDelete: () => Promise<unknown> | void
  onTestRouting: (objective: string) => void
}

/** Quick-inspect sheet for one skill: what it is, how the router and the
 * `/slug` command reach it, and the shortcuts to edit, enable and test it.
 * Deep link: `/skills?open=<id>`. */
export function SkillDetailSheet({ skill, tools, canWrite, writeReason, togglePending, onClose, onPrev, onNext, onEdit, onToggle, onDelete, onTestRouting }: SkillDetailSheetProps) {
  useDocumentTitle(skill.name)
  const toolByName = new Map(tools.map((t) => [t.name, t]))

  const menu: RowAction[] = [
    { label: 'Edit', icon: <PencilSimple size={14} />, onSelect: onEdit, disabled: !canWrite, disabledReason: writeReason },
    { label: 'Test routing', icon: <Path size={14} />, onSelect: () => onTestRouting(skill.examples[0] ?? skill.description) },
    {
      label: 'Delete',
      icon: <Trash size={14} />,
      destructive: true,
      disabled: !canWrite,
      disabledReason: writeReason,
      confirm: { title: `Delete skill “${skill.name}”?`, description: 'You can undo for a few seconds; it stays in the trash.' },
      onSelect: onDelete,
    },
  ]

  return (
    <Sheet
      open
      onClose={onClose}
      onPrev={onPrev}
      onNext={onNext}
      width="lg"
      eyebrow="Skills"
      title={skill.name}
      status={
        <Chip tone={skill.enabled ? 'ok' : 'neutral'} dot>
          {skill.enabled ? 'Enabled' : 'Disabled'}
        </Chip>
      }
      meta={
        <>
          <CopyId value={`/${skill.slug}`} label="slash command" />
          <span aria-hidden="true">·</span>
          <span>{skill.visibility === 'private' ? 'Private' : 'Shared'}</span>
          <span aria-hidden="true">·</span>
          <RelativeTime value={skill.updated_at} />
        </>
      }
      headerActions={<RowActions visibility="always" label={`More actions for “${skill.name}”`} items={menu} />}
      footer={
        <>
          <span className="mr-auto flex items-center gap-2 text-[13px] text-zinc-700">
            <Switch label={`${skill.enabled ? 'Disable' : 'Enable'} ${skill.name}`} checked={skill.enabled} pending={togglePending} disabled={!canWrite} title={canWrite ? undefined : writeReason} onChange={onToggle} />
            {skill.enabled ? 'Enabled' : 'Disabled'}
          </span>
          <Button variant="primary" icon={<PencilSimple size={14} />} disabled={!canWrite} title={canWrite ? undefined : writeReason} onClick={onEdit}>
            Edit skill
          </Button>
        </>
      }
    >
      <SheetSection title="Overview">
        {!canWrite && <p className="rounded-[10px] bg-amber-50 px-3 py-2 text-xs text-amber-800">Read-only. {writeReason}</p>}
        <p className="text-[13px] text-zinc-800 [overflow-wrap:anywhere]">{skill.description}</p>
        <FactList
          items={[
            { label: 'Owner', value: <span className="font-data text-xs">{skill.owner_id}</span> },
            { label: 'Created', value: <RelativeTime value={skill.created_at} /> },
            { label: 'Last edit', value: <span>{skill.updated_by}, <RelativeTime value={skill.updated_at} /></span> },
          ]}
        />
      </SheetSection>

      <SheetSection title="Instructions">
        {skill.instructions.trim() ? (
          // A deliberately bounded text viewer: long instructions scroll inside it.
          <pre className="max-h-56 overflow-auto rounded-[10px] border border-[var(--color-line)] bg-zinc-50 p-3 text-[13px] whitespace-pre-wrap text-zinc-800">{skill.instructions}</pre>
        ) : (
          <p className="text-[13px] text-zinc-500">No extra instructions: the skill only scopes the tools.</p>
        )}
      </SheetSection>

      <SheetSection title={`Allowed tools · ${skill.allowed_tools.length}`}>
        <div className="flex flex-wrap gap-1.5">
          {skill.allowed_tools.map((name) => {
            const tool = toolByName.get(name)
            return (
              <Chip key={name} mono icon={<Wrench size={10} />} tone={tool && !tool.enabled ? 'muted' : 'neutral'} title={tool?.description}>
                {name}
                {tool?.requires_approval && ' · needs approval'}
                {tool && !tool.enabled && ' · off in Integrations'}
              </Chip>
            )
          })}
        </div>
        {skill.allowed_tools.some((n) => toolByName.get(n)?.requires_approval) && (
          <p className="flex items-center gap-1.5 text-xs text-zinc-500">
            <ShieldWarning size={12} aria-hidden="true" /> Tools that need approval pause the run until someone decides.
          </p>
        )}
      </SheetSection>

      <SheetSection title="Routing and commands">
        <p className="text-[13px] text-zinc-700">
          {skill.enabled ? (
            <>
              The auto router can pick this skill when an objective matches its description, and typing <span className="font-data">/{skill.slug}</span> in chat forces it.
            </>
          ) : (
            <>Disabled skills are skipped by the router and by the slash command. Enable it to route to it.</>
          )}
        </p>
        {skill.examples.length > 0 ? (
          <div className="space-y-1.5">
            <p className="text-xs text-zinc-500">Example objectives. Test one against the router:</p>
            <ul className="space-y-1.5">
              {skill.examples.map((example) => (
                <li key={example} className="flex items-start justify-between gap-2 rounded-[10px] border border-[var(--color-line)] px-3 py-2">
                  <span className="min-w-0 text-[13px] text-zinc-800 [overflow-wrap:anywhere]">{example}</span>
                  <Button size="sm" variant="ghost" icon={<Path size={13} />} onClick={() => onTestRouting(example)}>
                    Test
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-xs text-zinc-500">No example objectives yet. Add some in Edit to give the router and the tester shortcuts.</p>
        )}
      </SheetSection>
    </Sheet>
  )
}
