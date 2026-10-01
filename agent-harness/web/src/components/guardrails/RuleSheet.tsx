import { Prohibit, ShieldWarning } from '@phosphor-icons/react'
import { Link } from 'react-router-dom'
import { useDocumentTitle } from '../../hooks/useDocumentTitle'
import type { Guardrail, GuardrailTrigger } from '../../lib/api-types'
import { describeTrigger, kindLabel } from '../../lib/guardrail-sandbox'
import { guardrailPatterns, triggersForRule } from '../../lib/guardrails-validation'
import { Chip, CopyId, FactList, RelativeTime, Sheet, SheetSection, Switch } from '../ui'

interface RuleSheetProps {
  guardrail: Guardrail | null
  loading: boolean
  triggers: GuardrailTrigger[]
  canMutate: boolean
  reason?: string
  pending: boolean
  onToggle: (enabled: boolean) => void
  onClose: () => void
  onPrev?: () => void
  onNext?: () => void
}

/** One rule: facts, its banned patterns, the enable switch, and the times it
 * fired. Deep link: `/guardrails?open=<id>`. */
export function RuleSheet({ guardrail, loading, triggers, canMutate, reason, pending, onToggle, onClose, onPrev, onNext }: RuleSheetProps) {
  useDocumentTitle(guardrail?.name ?? null)
  const patterns = guardrail ? guardrailPatterns(guardrail) : []
  const fired = guardrail ? triggersForRule(triggers, guardrail) : []
  return (
    <Sheet
      open
      onClose={onClose}
      onPrev={onPrev}
      onNext={onNext}
      eyebrow="Guardrails"
      label={guardrail?.name ?? 'Guardrail'}
      title={guardrail?.name ?? 'Guardrail'}
      status={guardrail ? <Chip tone={guardrail.enabled ? 'ok' : 'muted'} dot>{guardrail.enabled ? 'Enabled' : 'Disabled'}</Chip> : undefined}
      meta={
        guardrail && (
          <>
            <span>{kindLabel(guardrail.kind)}</span>
            <span aria-hidden="true">·</span>
            <CopyId value={guardrail.id} label="guardrail ID" />
          </>
        )
      }
    >
      {!guardrail ? (
        <p className="text-[13px] text-zinc-500">{loading ? 'Loading the rule…' : 'This guardrail no longer exists.'}</p>
      ) : (
        <>
          <SheetSection title="Overview">
            <div className="flex items-center justify-between gap-3 rounded-[10px] bg-zinc-950/[0.03] px-3 py-2.5">
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-zinc-900">Enforced on every run</p>
                <p className="text-xs text-zinc-600">{reason ?? 'Takes effect on the very next run or tool call.'}</p>
              </div>
              <Switch checked={guardrail.enabled} onChange={onToggle} label={`${guardrail.enabled ? 'Disable' : 'Enable'} ${guardrail.name}`} disabled={!canMutate} title={reason} pending={pending} />
            </div>
            <div className="mt-3">
              <FactList
                items={[
                  { label: 'Created', value: <RelativeTime value={guardrail.created_at} /> },
                  { label: 'Times fired', value: <span className="tabular-nums">{fired.length}</span> },
                ]}
              />
            </div>
          </SheetSection>

          <SheetSection title={guardrail.kind === 'objective_pattern_block' ? `Banned patterns · ${patterns.length}` : 'Behaviour'}>
            {guardrail.kind === 'objective_pattern_block' ? (
              patterns.length > 0 ? (
                <ul className="flex flex-wrap gap-1.5">
                  {patterns.map((p) => (
                    <li key={p}>
                      <Chip mono>{p}</Chip>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[13px] text-zinc-500">No patterns are configured, so this rule never fires.</p>
              )
            ) : (
              <p className="text-[13px] text-zinc-700">Caps an unsupported critical incident severity to high, next to the approval gate, unless the latest service status supports it.</p>
            )}
          </SheetSection>

          <SheetSection title={`Recent triggers · ${fired.length}`}>
            {fired.length === 0 ? (
              <p className="text-[13px] text-zinc-500">This rule has not fired yet. When it does, the run appears here.</p>
            ) : (
              <ul className="space-y-1.5">
                {fired.slice(0, 8).map((t, i) => (
                  <li key={`${t.run_id}-${t.step}-${i}`}>
                    <Link to={`/runs/${encodeURIComponent(t.run_id)}`} className="ui-card ui-card-hover flex items-start gap-2.5 p-3">
                      {t.event_type === 'guardrail_blocked' ? <Prohibit size={16} weight="fill" className="mt-0.5 shrink-0 text-rose-600" aria-hidden="true" /> : <ShieldWarning size={16} weight="fill" className="mt-0.5 shrink-0 text-amber-600" aria-hidden="true" />}
                      <span className="min-w-0 text-[13px]">
                        <span className="block text-zinc-900 [overflow-wrap:anywhere]">{describeTrigger(t)}</span>
                        <span className="block truncate text-xs text-zinc-500">{t.objective ?? 'Objective not recorded'}</span>
                        <RelativeTime value={t.timestamp} className="text-xs text-zinc-500" />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </SheetSection>
        </>
      )}
    </Sheet>
  )
}
