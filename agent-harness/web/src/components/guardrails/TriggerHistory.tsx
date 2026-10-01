import { ArrowSquareOut, Prohibit, ShieldWarning } from '@phosphor-icons/react'
import type { GuardrailTrigger } from '../../lib/api-types'
import { describeTrigger } from '../../lib/guardrail-sandbox'

function formatEpoch(value: number): string {
  return new Date(value * 1000).toLocaleString()
}

/** Each row is one recorded guardrail event, linked to the run it fired on. */
export function TriggerHistory({ triggers }: { triggers: GuardrailTrigger[] }) {
  return (
    <ul className="ui-list ui-card divide-y divide-zinc-200 overflow-hidden">
      {triggers.map((trigger, i) => {
        const blocked = trigger.event_type === 'guardrail_blocked'
        const Icon = blocked ? Prohibit : ShieldWarning
        const ruleName = typeof trigger.data.guardrail_name === 'string' ? trigger.data.guardrail_name : null
        const kind = blocked ? 'Objective pattern block' : 'Severity evidence cap'
        return (
          <li key={`${trigger.run_id}-${trigger.step}-${i}`} className="flex items-start gap-3 px-4 py-3">
            <Icon size={16} weight="fill" className="mt-0.5 shrink-0 text-rose-600" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
                <span className="font-medium text-zinc-900 [overflow-wrap:anywhere]">{ruleName ?? kind}</span>
                {ruleName && <span className="text-xs text-zinc-600">{kind}</span>}
                <span className="text-xs text-zinc-600 tabular-nums">{formatEpoch(trigger.timestamp)}</span>
              </p>
              <p className="mt-0.5 text-[13px] text-zinc-700 [overflow-wrap:anywhere]">{describeTrigger(trigger)}</p>
              <p className="mt-0.5 truncate text-xs text-zinc-600" title={trigger.objective ?? undefined}>
                Objective: {trigger.objective ? trigger.objective : 'not recorded'}
              </p>
            </div>
            <a href={`/runs/${encodeURIComponent(trigger.run_id)}`} className="ui-btn-link inline-flex shrink-0 items-center gap-1 text-xs">
              Open run
              <ArrowSquareOut size={12} aria-hidden="true" />
            </a>
          </li>
        )
      })}
    </ul>
  )
}
