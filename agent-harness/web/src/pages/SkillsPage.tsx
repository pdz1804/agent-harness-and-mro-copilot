import { ArrowsClockwise, Lock, PencilSimple, PlusCircle, ShareNetwork, Wrench } from '@phosphor-icons/react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ForbiddenState } from '../components/prompts/ForbiddenState'
import { RoutingTester } from '../components/skills/RoutingTester'
import { SkillDetailSheet } from '../components/skills/SkillDetailSheet'
import { SkillFormSheet } from '../components/skills/SkillFormSheet'
import {
  Button,
  Card,
  CardGridSkeleton,
  Chip,
  EmptyState,
  ErrorState,
  FilteredEmpty,
  PageHeader,
  SearchInput,
  Segmented,
  Sheet,
  Switch,
  useToast,
} from '../components/ui'
import { canWriteResource, disabledReason, useMe } from '../hooks/useMe'
import { useClearUrlParams, useUrlEnum, useUrlState } from '../hooks/useUrlState'
import { api, errorText } from '../lib/api'
import { getCurrentUserId } from '../lib/identity'
import type { Skill, ToolCatalogEntry } from '../lib/api-types'
import { isForbidden } from '../lib/prompts-access'
import { filterSkills, type EnabledFilter } from '../lib/skills-form'

const TABS = ['skills', 'routing'] as const
type Tab = (typeof TABS)[number]
const ENABLED_VALUES = ['all', 'enabled', 'disabled'] as const
const FILTER_KEYS = ['q', 'enabled']
const MAX_CARD_TOOLS = 4

/** Skills: reusable capability packages (instructions plus a scoped tool set).
 * Tabs (skills / routing tester), search, the enabled filter and the open
 * skill live in the URL. Every mutation toasts with Undo: enable <-> disable,
 * delete -> restore, create -> delete, edit -> the previous values. */
export function SkillsPage() {
  const navigate = useNavigate()
  const toast = useToast()
  const { me, loading: meLoading } = useMe()
  const [tab, setTab] = useUrlEnum<Tab>('tab', TABS, 'skills')
  const [q, setQ] = useUrlState('q')
  const [enabledFilter, setEnabledFilter] = useUrlEnum<EnabledFilter>('enabled', ENABLED_VALUES, 'all')
  const [openId, setOpenId] = useUrlState('open')
  const [objective] = useUrlState('objective')
  const clearParams = useClearUrlParams()

  const [skills, setSkills] = useState<Skill[] | null>(null)
  const [tools, setTools] = useState<ToolCatalogEntry[]>([])
  const [error, setError] = useState<unknown>(null)
  const [refreshToken, setRefreshToken] = useState(0)
  const [editing, setEditing] = useState<Skill | 'new' | null>(null)
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set())

  const reload = useCallback(() => setRefreshToken((n) => n + 1), [])

  useEffect(() => {
    let cancelled = false
    Promise.all([api.listSkills(), api.listTools()]).then(
      ([skillData, toolData]) => {
        if (cancelled) return
        setSkills(skillData)
        setTools(toolData)
        setError(null)
      },
      (err: unknown) => {
        if (!cancelled) setError(err)
      },
    )
    return () => {
      cancelled = true
    }
  }, [refreshToken])

  const currentUserId = getCurrentUserId()
  const hasMutate = me ? me.permissions.includes('mutate_skills') : true
  const createReason = hasMutate ? undefined : disabledReason(me, 'mutate_skills')
  const canWriteSkill = (s: Skill) => hasMutate && canWriteResource(me, s)
  const writeReasonFor = (s: Skill) => (!hasMutate ? disabledReason(me, 'mutate_skills') : canWriteResource(me, s) ? '' : `Only the owner (${s.owner_id}) or an admin can edit this skill.`)

  const rows = useMemo(() => filterSkills(skills ?? [], q, enabledFilter), [skills, q, enabledFilter])
  const active = q !== '' || enabledFilter !== 'all'
  const clearFilters = () => clearParams(FILTER_KEYS)

  const openSkill = skills?.find((s) => s.id === openId) ?? null
  const openIndex = rows.findIndex((s) => s.id === openId)
  const step = (delta: 1 | -1) => {
    if (!rows.length) return
    setOpenId(rows[(Math.max(0, openIndex) + delta + rows.length) % rows.length].id)
  }

  const markBusy = (id: string, on: boolean) =>
    setBusyIds((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })

  /** Flip `enabled` optimistically; Undo flips it back. */
  const setEnabled = async (skill: Skill, enabled: boolean) => {
    const apply = (value: boolean) => setSkills((list) => list && list.map((s) => (s.id === skill.id ? { ...s, enabled: value } : s)))
    apply(enabled)
    markBusy(skill.id, true)
    try {
      await api.updateSkill(skill.id, { enabled })
      toast({
        title: `${enabled ? 'Enabled' : 'Disabled'} “${skill.name}”`,
        action: {
          label: 'Undo',
          run: async () => {
            await api.updateSkill(skill.id, { enabled: !enabled })
            reload()
          },
        },
      })
    } catch (err) {
      apply(!enabled)
      toast({ tone: 'error', title: `Couldn't ${enabled ? 'enable' : 'disable'} “${skill.name}”`, description: errorText(err, 'Try again.') })
    } finally {
      markBusy(skill.id, false)
    }
  }

  const remove = async (skill: Skill) => {
    try {
      await api.deleteSkill(skill.id)
    } catch (err) {
      toast({ tone: 'error', title: `Couldn't delete “${skill.name}”`, description: errorText(err, 'Try again.') })
      return
    }
    if (openId === skill.id) setOpenId('')
    reload()
    toast({
      title: `Deleted “${skill.name}”`,
      description: 'Kept in the trash for a while.',
      action: {
        label: 'Undo',
        run: async () => {
          await api.restoreSkill(skill.id)
          reload()
          toast({ title: 'Delete undone' })
        },
      },
    })
  }

  const saved = (next: Skill, previous: Skill | null) => {
    setEditing(null)
    reload()
    if (!previous) {
      setOpenId(next.id)
      toast({
        title: `Created “${next.name}”`,
        action: {
          label: 'Undo',
          run: async () => {
            await api.deleteSkill(next.id)
            setOpenId('')
            reload()
            toast({ title: 'Creation undone' })
          },
        },
      })
      return
    }
    toast({
      title: `Saved “${next.name}”`,
      action: {
        label: 'Undo',
        run: async () => {
          await api.updateSkill(previous.id, {
            name: previous.name,
            description: previous.description,
            instructions: previous.instructions,
            allowed_tools: previous.allowed_tools,
            examples: previous.examples,
            visibility: previous.visibility,
            enabled: previous.enabled,
          })
          reload()
          toast({ title: 'Edit undone' })
        },
      },
    })
  }

  const testRouting = (text: string) => navigate(`/skills?tab=routing&objective=${encodeURIComponent(text)}`)

  const newSkillButton = (
    <Button variant="primary" icon={<PlusCircle size={14} weight="bold" />} disabled={!hasMutate} title={createReason} onClick={() => setEditing('new')}>
      New skill
    </Button>
  )

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Skills"
        description="Reusable instructions plus an allowed tool set. The router picks one per objective, or an agent pins its own."
        actions={
          <div className="flex flex-col items-end gap-1">
            <div className="flex items-center gap-2">
              <Button icon={<ArrowsClockwise size={14} weight="bold" />} onClick={reload}>
                Refresh
              </Button>
              {newSkillButton}
            </div>
            {createReason && !meLoading && <span className="max-w-xs text-right text-xs text-zinc-500">{createReason}</span>}
          </div>
        }
        toolbar={
          <>
            <Segmented
              label="Skills view"
              value={tab}
              onChange={setTab}
              options={[
                { value: 'skills', label: 'Skills', count: skills?.length },
                { value: 'routing', label: 'Routing tester' },
              ]}
            />
            {tab === 'skills' && (
              <>
                <SearchInput label="Search skills" placeholder="Search name, slug, description" value={q} onValueChange={setQ} className="w-full sm:w-64" />
                <Segmented
                  label="Enabled"
                  value={enabledFilter}
                  onChange={setEnabledFilter}
                  options={[
                    { value: 'all', label: 'All' },
                    { value: 'enabled', label: 'Enabled' },
                    { value: 'disabled', label: 'Disabled' },
                  ]}
                />
                {active && (
                  <Button variant="ghost" size="sm" onClick={clearFilters}>
                    Clear filters
                  </Button>
                )}
              </>
            )}
          </>
        }
      />

      {tab === 'routing' ? (
        <RoutingTester key={objective} skills={skills} initialObjective={objective} />
      ) : error && skills === null ? (
        isForbidden(error) ? (
          <ForbiddenState what="skills" backTo="/sessions" backLabel="Back to sessions" />
        ) : (
          <ErrorState message={`${errorText(error, 'Could not load skills.')} Check that the backend is running.`} onRetry={reload} />
        )
      ) : skills === null ? (
        <CardGridSkeleton count={6} />
      ) : rows.length === 0 ? (
        active ? (
          <FilteredEmpty query={q || undefined} what="skills" onClear={clearFilters} />
        ) : (
          <EmptyState
            icon={<Wrench size={22} weight="duotone" />}
            title="No skills yet"
            description="A skill scopes an agent's tools and instructions for a class of objective, and becomes a /slug command in chat."
            action={newSkillButton}
            example="Try: slug “triage-outage” with get_service_status and search_knowledge_base."
          />
        )
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((skill) => {
            const writable = canWriteSkill(skill)
            const reason = writeReasonFor(skill)
            return (
              <li key={skill.id} className="contents">
                <Card className="relative flex flex-col gap-2" interactive selected={skill.id === openId} onClick={() => setOpenId(skill.id)}>
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-data truncate text-xs text-sky-700">/{skill.slug}</p>
                    <span className="relative z-10 flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                      {skill.visibility === 'private' ? <Lock size={12} className="text-zinc-500" aria-label="Private" /> : <ShareNetwork size={12} className="text-zinc-500" aria-label="Shared" />}
                      <Switch
                        label={`${skill.enabled ? 'Disable' : 'Enable'} ${skill.name}`}
                        checked={skill.enabled}
                        pending={busyIds.has(skill.id)}
                        disabled={!writable}
                        title={writable ? (skill.enabled ? 'Enabled' : 'Disabled') : reason}
                        onChange={(next) => void setEnabled(skill, next)}
                      />
                    </span>
                  </div>
                  <div className="min-w-0">
                    {/* The name is the card's keyboard and screen-reader entry; its ::after stretches over the card. */}
                    <button type="button" onClick={(e) => { e.stopPropagation(); setOpenId(skill.id) }} className="block max-w-full truncate rounded-md text-left text-sm font-semibold text-zinc-900 after:absolute after:inset-0 after:content-['']">
                      {skill.name}
                    </button>
                    <p className="mt-1 line-clamp-2 text-xs text-zinc-600">{skill.description}</p>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {skill.allowed_tools.slice(0, MAX_CARD_TOOLS).map((t) => (
                      <Chip key={t} mono icon={<Wrench size={9} />}>
                        {t}
                      </Chip>
                    ))}
                    {skill.allowed_tools.length > MAX_CARD_TOOLS && <Chip tone="muted">+{skill.allowed_tools.length - MAX_CARD_TOOLS}</Chip>}
                  </div>
                  <div className="mt-auto flex items-center justify-between gap-2 border-t border-[var(--color-line)] pt-2 text-xs text-zinc-500">
                    <span className="truncate">{skill.owner_id === currentUserId ? 'You' : skill.owner_id}</span>
                    <Button
                      size="sm"
                      className="relative z-10"
                      icon={<PencilSimple size={13} />}
                      disabled={!writable}
                      title={writable ? undefined : reason}
                      onClick={(e) => {
                        e.stopPropagation()
                        setOpenId(skill.id)
                        setEditing(skill)
                      }}
                    >
                      Edit
                    </Button>
                  </div>
                </Card>
              </li>
            )
          })}
        </ul>
      )}

      {openId && editing === null && tab === 'skills' && skills !== null && (
        openSkill ? (
          <SkillDetailSheet
            skill={openSkill}
            tools={tools}
            canWrite={canWriteSkill(openSkill)}
            writeReason={writeReasonFor(openSkill)}
            togglePending={busyIds.has(openSkill.id)}
            onClose={() => setOpenId('')}
            onPrev={rows.length > 1 ? () => step(-1) : undefined}
            onNext={rows.length > 1 ? () => step(1) : undefined}
            onEdit={() => setEditing(openSkill)}
            onToggle={(next) => void setEnabled(openSkill, next)}
            onDelete={() => remove(openSkill)}
            onTestRouting={testRouting}
          />
        ) : (
          <Sheet open onClose={() => setOpenId('')} eyebrow="Skills" title="Skill not found">
            <ErrorState message="This skill doesn't exist, was deleted, or you can't see it." />
          </Sheet>
        )
      )}

      {editing !== null && (
        <SkillFormSheet
          key={editing === 'new' ? 'new' : editing.id}
          skill={editing === 'new' ? null : editing}
          tools={tools}
          canWrite={editing === 'new' ? hasMutate : canWriteSkill(editing)}
          writeReason={editing === 'new' ? (createReason ?? '') : writeReasonFor(editing)}
          onClose={() => setEditing(null)}
          onSaved={saved}
        />
      )}
    </div>
  )
}
