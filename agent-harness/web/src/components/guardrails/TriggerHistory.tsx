import { ArrowSquareOut } from '@phosphor-icons/react'
import { Link, useNavigate } from 'react-router-dom'
import type { GuardrailTrigger } from '../../lib/api-types'
import { describeTrigger } from '../../lib/guardrail-sandbox'
import { Chip, RelativeTime, Row, Table } from '../ui'

/** Each row is one recorded guardrail event; the row (or its link) opens the
 * run it fired on. */
export function TriggerHistory({ triggers }: { triggers: GuardrailTrigger[] }) {
  const navigate = useNavigate()
  return (
    <Table label="Guardrail trigger history">
      <thead>
        <tr>
          <th>Rule</th>
          <th>What happened</th>
          <th className="hidden md:table-cell">Objective</th>
          <th className="hidden sm:table-cell">When</th>
          <th className="w-10">
            <span className="sr-only">Open run</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {triggers.map((trigger, i) => {
          const blocked = trigger.event_type === 'guardrail_blocked'
          const ruleName = typeof trigger.data.guardrail_name === 'string' ? trigger.data.guardrail_name : null
          const kind = blocked ? 'Objective pattern block' : 'Severity evidence cap'
          return (
            <Row key={`${trigger.run_id}-${trigger.step}-${i}`} onOpen={() => navigate(`/runs/${encodeURIComponent(trigger.run_id)}`)}>
              <td className="max-w-0 min-w-[9rem]">
                <p className="truncate font-medium text-zinc-900">{ruleName ?? kind}</p>
                <Chip tone={blocked ? 'violet' : 'warn'} className="mt-0.5">
                  {kind}
                </Chip>
              </td>
              <td className="text-[13px] text-zinc-700 [overflow-wrap:anywhere]">{describeTrigger(trigger)}</td>
              <td className="hidden max-w-[16rem] md:table-cell">
                <span className="block truncate text-xs text-zinc-600" title={trigger.objective ?? undefined}>
                  {trigger.objective ? trigger.objective : 'Not recorded'}
                </span>
              </td>
              <td className="hidden text-zinc-600 sm:table-cell">
                <RelativeTime value={trigger.timestamp} />
              </td>
              <td className="text-right">
                <Link to={`/runs/${encodeURIComponent(trigger.run_id)}`} className="ui-btn-link inline-flex items-center" aria-label={`Open run ${trigger.run_id}`} title="Open run">
                  <ArrowSquareOut size={14} aria-hidden="true" />
                </Link>
              </td>
            </Row>
          )
        })}
      </tbody>
    </Table>
  )
}
