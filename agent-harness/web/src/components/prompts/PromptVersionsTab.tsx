import { ArrowCounterClockwise, CaretDown, CaretRight, GitDiff } from '@phosphor-icons/react'
import { Fragment } from 'react'
import type { PromptDetail } from '../../lib/api-types'
import { activationLabel, summarizeVerification } from '../../lib/prompt-verification'
import { Button, Card, CardHeader, Chip, RelativeTime, Table } from '../ui'
import { VerificationBadge, VerificationPanel } from './VerificationPanel'

interface PromptVersionsTabProps {
  detail: PromptDetail
  canWrite: boolean
  /** Why write controls are off (title text on each disabled control). */
  writeReason: string
  /** Version being activated right now (spinner on that button). */
  activatingId: string | null
  /** Version being re-verified right now. */
  reverifyingId: string | null
  expanded: ReadonlySet<string>
  onToggleChecks: (versionId: string) => void
  onActivate: (versionId: string) => void
  onDiff: (versionId: string) => void
  onReverify: (versionId: string, withReview: boolean) => void
}

/** The active content plus the immutable version history: who wrote what,
 * its lint status, how many runs and agents use it, and the way to activate,
 * roll back or diff it. */
export function PromptVersionsTab({ detail, canWrite, writeReason, activatingId, reverifyingId, expanded, onToggleChecks, onActivate, onDiff, onReverify }: PromptVersionsTabProps) {
  const activeId = detail.active_version?.id
  const activeContent = detail.versions.find((v) => v.id === activeId)?.content ?? ''

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title={`Active content (v${detail.active_version?.version ?? '—'})`} meta="What every new run of this prompt starts from." />
        {/* A deliberately bounded code viewer: long prompts scroll inside it. */}
        <pre className="mt-3 max-h-64 overflow-auto rounded-[10px] border border-[var(--color-line)] bg-zinc-50 p-3 text-[13px] whitespace-pre-wrap text-zinc-800">{activeContent || '(no active version)'}</pre>
      </Card>

      <div className="space-y-2">
        <p className="text-xs font-medium text-zinc-500">Version history · {detail.versions.length}</p>
        <Table label="Prompt versions">
          <thead>
            <tr>
              <th>Version</th>
              <th className="hidden sm:table-cell">Checks</th>
              <th className="hidden md:table-cell">Usage</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {detail.versions.map((v) => {
              const isActive = v.id === activeId
              const summary = summarizeVerification(v.verification)
              const open = expanded.has(v.id)
              const runs = v.run_count ?? 0
              const pinned = v.pinned_agents ?? 0
              const activateTitle = !canWrite ? writeReason : !summary.activatable ? 'Lint failed: fix the errors in a new version first' : undefined
              return (
                <Fragment key={v.id}>
                  <tr aria-selected={isActive || undefined}>
                    <td className="min-w-[10rem]">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-zinc-900">v{v.version}</span>
                        {isActive && (
                          <Chip tone="ok" dot>
                            Active
                          </Chip>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs text-zinc-500">
                        <RelativeTime value={v.created_at} /> · {v.created_by}
                      </p>
                      {v.change_note && <p className="mt-0.5 text-xs text-zinc-600 [overflow-wrap:anywhere]">{v.change_note}</p>}
                      <p className="mt-1 text-xs text-zinc-500 md:hidden">
                        {runs} run{runs === 1 ? '' : 's'} · {pinned} pinned
                      </p>
                    </td>
                    <td className="hidden sm:table-cell">
                      <VerificationBadge verification={v.verification} />
                    </td>
                    <td className="hidden text-xs text-zinc-500 md:table-cell" data-testid="version-usage">
                      Used by {runs} run{runs === 1 ? '' : 's'} · pinned by {pinned} agent{pinned === 1 ? '' : 's'}
                    </td>
                    <td>
                      <div className="flex flex-wrap items-center justify-end gap-1.5">
                        <Button variant="ghost" size="sm" icon={open ? <CaretDown size={12} weight="bold" /> : <CaretRight size={12} weight="bold" />} aria-expanded={open} onClick={() => onToggleChecks(v.id)}>
                          Checks
                        </Button>
                        {!isActive && (
                          <>
                            <Button variant="ghost" size="sm" icon={<GitDiff size={13} />} onClick={() => onDiff(v.id)}>
                              Diff vs active
                            </Button>
                            <Button
                              size="sm"
                              icon={<ArrowCounterClockwise size={13} />}
                              loading={activatingId === v.id}
                              disabled={!canWrite || !summary.activatable || activatingId !== null}
                              title={activateTitle}
                              onClick={() => onActivate(v.id)}
                            >
                              {activationLabel(v.version, detail.active_version?.version ?? null)}
                            </Button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                  {open && (
                    <tr>
                      <td colSpan={4} className="!bg-zinc-50/60">
                        {v.verification ? (
                          <VerificationPanel verification={v.verification} />
                        ) : (
                          <p className="text-xs text-zinc-500">No verification stored for this version yet (it predates verification). It is linted when you activate it.</p>
                        )}
                        {canWrite && (
                          <div className="mt-3 flex gap-2">
                            <Button size="sm" disabled={reverifyingId === v.id} onClick={() => onReverify(v.id, false)}>
                              Re-run lint
                            </Button>
                            <Button size="sm" loading={reverifyingId === v.id} onClick={() => onReverify(v.id, true)}>
                              {reverifyingId === v.id ? 'Reviewing' : 'Lint + LLM review'}
                            </Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </Table>
      </div>
    </div>
  )
}
