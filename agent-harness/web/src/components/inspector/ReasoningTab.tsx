import { Info } from '@phosphor-icons/react'
import { useMemo } from 'react'
import type { AgentEvent } from '../../lib/api-types'
import { buildReasoning } from '../../lib/trace-model'

/** Honest framing: this tab shows the model's own pre-tool-call text
 * (`llm_decision.rationale`) and the skill router's stated rationale
 * (`skill_routed`) — both are real provider output, never fabricated. It
 * does NOT claim to expose the provider's hidden chain-of-thought
 * (OpenAI/Anthropic reasoning models redact that by design); this label is
 * always shown so the distinction is never ambiguous. */
export function ReasoningTab({ events }: { events: AgentEvent[] }) {
  const { routed, decisions } = useMemo(() => buildReasoning(events), [events])
  const hasAnyDecisionText = decisions.some((d) => d.text)

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-md bg-zinc-50 p-2.5 text-xs text-zinc-600 ring-1 ring-zinc-200">
        <Info size={14} weight="fill" className="mt-0.5 shrink-0 text-zinc-500" />
        <p>
          This shows model-visible decisions — text the model produced before calling a tool or answering, and the
          skill router's own stated rationale. <strong>Provider-hidden reasoning is not exposed</strong> by the
          OpenAI/Anthropic APIs this harness calls, so nothing here is a reconstruction or guess at it.
        </p>
      </div>

      {routed.length > 0 && (
        <section>
          <h3 className="ui-section-label mb-2">Skill routing</h3>
          <ul className="space-y-2">
            {routed.map((r, i) => (
              <li key={i} className="rounded-lg border border-violet-200 bg-violet-50/50 p-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-violet-800">step {r.step}</span>
                  <span className="font-data text-violet-600">confidence {r.confidence.toFixed(2)}</span>
                </div>
                <p className="mt-1 text-xs text-zinc-500">
                  candidates: {r.candidates.join(', ') || 'none'} → selected:{' '}
                  <strong>{r.selected.join(', ') || 'none (below threshold)'}</strong>
                </p>
                {r.rationale && <p className="mt-2 text-sm text-zinc-800">{r.rationale}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h3 className="ui-section-label mb-2">Model decisions</h3>
        {hasAnyDecisionText ? (
          <ul className="space-y-2">
            {decisions
              .filter((d) => d.text)
              .map((d, i) => (
                <li key={i} className="rounded-lg border border-sky-200 bg-sky-50/50 p-3">
                  <p className="text-xs font-medium text-sky-800">
                    step {d.step} · {d.action === 'tool_call' ? 'before calling a tool' : 'final answer'}
                  </p>
                  <p className="mt-1 text-sm text-zinc-800 whitespace-pre-wrap">{d.text}</p>
                </li>
              ))}
          </ul>
        ) : (
          <p className="text-sm text-zinc-500">
            No pre-tool-call text was produced in this run — the model went straight to tool calls without narrating.
          </p>
        )}
      </section>
    </div>
  )
}
