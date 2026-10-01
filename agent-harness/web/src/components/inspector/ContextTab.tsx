import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import type { Agent, AgentEvent, RunSnapshot, RunTokenTotals } from '../../lib/api-types'

export function ContextTab({ snapshot }: { snapshot: RunSnapshot }) {
  const [agent, setAgent] = useState<Agent | null>(null)
  const [tokens, setTokens] = useState<RunTokenTotals | null>(null)

  useEffect(() => {
    if (snapshot.agent_id) {
      api
        .getAgent(snapshot.agent_id)
        .then(setAgent)
        .catch(() => setAgent(null))
    } else {
      setAgent(null)
    }
    api
      .getRunTokens(snapshot.run_id)
      .then(setTokens)
      .catch(() => setTokens(null))
  }, [snapshot.agent_id, snapshot.run_id])

  const compactionEvents = snapshot.history.filter((e: AgentEvent) => e.event_type === 'context_compacted')
  const guardrailEvents = snapshot.history.filter(
    (e: AgentEvent) => e.event_type === 'guardrail_blocked' || e.event_type === 'guardrail_severity_downgraded',
  )

  return (
    <div className="space-y-4 text-sm">
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
        <div>
          <dt className="text-xs text-zinc-500">Agent</dt>
          <dd className="font-medium text-zinc-800">{agent ? agent.name : snapshot.agent_id ?? 'default'}</dd>
        </div>
        <div>
          <dt className="text-xs text-zinc-500">Prompt version</dt>
          <dd className="font-data text-xs text-zinc-700">{snapshot.prompt_version_id ?? 'follows active'}</dd>
        </div>
        <div>
          <dt className="text-xs text-zinc-500">Active skills</dt>
          <dd className="text-xs text-zinc-700">{snapshot.skill_ids.length > 0 ? snapshot.skill_ids.join(', ') : 'none'}</dd>
        </div>
        <div>
          <dt className="text-xs text-zinc-500">Tool set</dt>
          <dd className="text-xs text-zinc-700">{agent?.base_tools.join(', ') || '—'}</dd>
        </div>
      </dl>

      {tokens && (
        <div>
          <h3 className="ui-section-label mb-1">Token totals</h3>
          <p className="font-data text-xs text-zinc-700">
            {tokens.total_tokens.toLocaleString()} total ({tokens.prompt_tokens} prompt + {tokens.completion_tokens}{' '}
            completion) across {tokens.llm_calls} LLM call{tokens.llm_calls === 1 ? '' : 's'}
          </p>
        </div>
      )}

      <div>
        <h3 className="ui-section-label mb-1">Compaction events ({compactionEvents.length})</h3>
        {compactionEvents.length === 0 ? (
          <p className="text-xs text-zinc-500">None — context never exceeded the autocompact budget.</p>
        ) : (
          <ul className="space-y-1 text-xs text-zinc-700">
            {compactionEvents.map((e, i) => (
              <li key={i}>
                step {e.step}: {String(e.data.messages_summarized ?? '?')} message(s), {String(e.data.tokens_before ?? '?')} →{' '}
                {String(e.data.tokens_after ?? '?')} tokens
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h3 className="ui-section-label mb-1">Guardrail hits ({guardrailEvents.length})</h3>
        {guardrailEvents.length === 0 ? (
          <p className="text-xs text-zinc-500">None triggered in this run.</p>
        ) : (
          <ul className="space-y-1 text-xs text-zinc-700">
            {guardrailEvents.map((e, i) => (
              <li key={i}>
                step {e.step}: {e.event_type === 'guardrail_blocked' ? 'blocked' : 'severity downgraded'} —{' '}
                {String(e.data.guardrail_name ?? '')}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
