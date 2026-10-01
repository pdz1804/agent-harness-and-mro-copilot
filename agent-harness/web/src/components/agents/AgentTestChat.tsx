import { ArrowSquareOut, ChatCircleDots, Trash } from '@phosphor-icons/react'
import { useCallback, useEffect, useState } from 'react'
import { useRunStream } from '../../hooks/useRunStream'
import { useStickToBottom } from '../../hooks/useStickToBottom'
import { ApiError, api } from '../../lib/api'
import { TERMINAL_STATUSES, type Agent, type RunSnapshot, type RunStatus, type StarterPrompt } from '../../lib/api-types'
import { ChatTurn } from '../chat/ChatTurn'
import { Composer } from '../chat/Composer'
import { ErrorBanner } from '../ErrorBanner'

const MODE_LABEL: Record<Agent['skill_mode'], string> = { none: 'None', assigned: 'Assigned', auto: 'Auto' }

interface Thread {
  sessionId: string | null
  runIds: string[]
}

const EMPTY_THREAD: Thread = { sessionId: null, runIds: [] }

/** One streamed turn: live tokens, tool rows, inline approval card. */
function TestTurn({
  runId,
  onSnapshot,
}: {
  runId: string
  onSnapshot: (runId: string, snapshot: RunSnapshot) => void
}) {
  const { snapshot, live, refresh, streamingFinalAnswer, streamingToolArgs, error } = useRunStream(runId)

  useEffect(() => {
    if (snapshot) onSnapshot(runId, snapshot)
  }, [snapshot, runId, onSnapshot])

  if (!snapshot) return error ? <ErrorBanner message={error} /> : <p className="text-xs text-zinc-600">Starting…</p>
  return (
    <ChatTurn
      snapshot={snapshot}
      live={live}
      streamingFinalAnswer={streamingFinalAnswer}
      streamingToolArgs={streamingToolArgs}
      approval={
        snapshot.status === 'pending_approval' && snapshot.pending_approval
          ? {
              pending: snapshot.pending_approval,
              onDecide: async (approved) => {
                await api.approveRun(snapshot.run_id, approved)
                refresh()
              },
            }
          : undefined
      }
    />
  )
}

/** A chat bound to one agent. The first message starts a "[Test]" session for
 * that agent; follow-ups reuse the session so the thread continues. Every
 * message is a real run, visible in Sessions. */
export function AgentTestChat({ agent, promptLabel }: { agent: Agent; promptLabel: string }) {
  const [thread, setThread] = useState<Thread>(EMPTY_THREAD)
  const [statuses, setStatuses] = useState<Record<string, RunStatus>>({})
  const [value, setValue] = useState('')
  const [sending, setSending] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [starters, setStarters] = useState<StarterPrompt[]>([])
  const { scrollRef, contentRef, onScroll } = useStickToBottom(thread.sessionId ?? undefined)

  useEffect(() => {
    let cancelled = false
    api
      .getAgentStarters(agent.id)
      .then((list) => {
        if (!cancelled) setStarters(list)
      })
      .catch(() => {
        if (!cancelled) setStarters([])
      })
    return () => {
      cancelled = true
    }
  }, [agent.id])

  const recordSnapshot = useCallback(
    (runId: string, snapshot: RunSnapshot) =>
      setStatuses((prev) => (prev[runId] === snapshot.status ? prev : { ...prev, [runId]: snapshot.status })),
    [],
  )

  const lastRunId = thread.runIds[thread.runIds.length - 1]
  const lastStatus = lastRunId ? statuses[lastRunId] : undefined
  const running = lastRunId !== undefined && (lastStatus === undefined || !TERMINAL_STATUSES.has(lastStatus))

  const send = async (text: string) => {
    if (sending) return
    setSending(true)
    setError(null)
    try {
      const response = await api.startRun(
        thread.sessionId
          ? { objective: text, session_id: thread.sessionId }
          : { objective: text, agent_id: agent.id, agent_test: true },
      )
      setThread((t) => ({ sessionId: response.session_id, runIds: [...t.runIds, response.run_id] }))
    } catch (err) {
      setValue(text)
      setError(err instanceof ApiError ? err.message : 'Failed to start the test run.')
    } finally {
      setSending(false)
    }
  }

  const stop = () => {
    if (!lastRunId) return
    setStopping(true)
    api
      .cancelRun(lastRunId)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : 'Failed to stop the run.'))
      .finally(() => setStopping(false))
  }

  const reset = () => {
    setThread(EMPTY_THREAD)
    setStatuses({})
    setError(null)
  }

  return (
    <div className="flex flex-col gap-3" data-testid="agent-test-chat">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-zinc-900">
          <ChatCircleDots size={16} weight="bold" className="shrink-0 text-sky-700" aria-hidden="true" />
          <span className="truncate">Testing {agent.name}</span>
        </p>
        <div className="flex items-center gap-2">
          {lastRunId && (
            <a href={`/runs/${lastRunId}`} className="ui-btn-link inline-flex items-center gap-1 text-xs">
              Open full chat
              <ArrowSquareOut size={12} weight="bold" aria-hidden="true" />
            </a>
          )}
          <button
            type="button"
            onClick={reset}
            disabled={thread.runIds.length === 0 || running}
            className="ui-btn ui-btn-ghost ui-btn-sm"
          >
            <Trash size={12} weight="bold" aria-hidden="true" />
            New test
          </button>
        </div>
      </div>

      <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-600">
        <div className="flex gap-1">
          <dt>Prompt</dt>
          <dd className="font-data text-zinc-900 [overflow-wrap:anywhere]">{promptLabel}</dd>
        </div>
        <div className="flex gap-1">
          <dt>Skill mode</dt>
          <dd className="text-zinc-900">{MODE_LABEL[agent.skill_mode]}</dd>
        </div>
      </dl>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="max-h-[52vh] min-h-48 overflow-y-auto rounded-md border border-zinc-200 bg-white p-3"
      >
        <div ref={contentRef} className="space-y-5">
          {thread.runIds.length === 0 ? (
            <div className="space-y-2 py-4 text-center">
              <p className="text-sm text-zinc-700">Send a message to try this agent for real.</p>
              <p className="text-xs text-zinc-600">
                Runs use the agent's prompt, skills and tools. Anything that needs approval still pauses for you.
              </p>
            </div>
          ) : (
            thread.runIds.map((id) => <TestTurn key={id} runId={id} onSnapshot={recordSnapshot} />)
          )}
        </div>
      </div>

      {error && <ErrorBanner message={error} />}

      {starters.length > 0 && thread.runIds.length === 0 && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Starter prompts">
          {starters.map((s) => (
            <button
              key={`${s.skill_slug}:${s.text}`}
              type="button"
              onClick={() => setValue(s.text)}
              title={s.skill_slug ? `Suggested for /${s.skill_slug}` : undefined}
              className="ui-btn ui-btn-secondary ui-btn-sm h-auto max-w-full whitespace-normal py-1 text-left [overflow-wrap:anywhere]"
            >
              {s.text}
            </button>
          ))}
        </div>
      )}

      <Composer
        agents={null}
        agentId={agent.id}
        onAgentChange={() => undefined}
        onSubmit={(text) => void send(text)}
        submitting={sending}
        value={value}
        onValueChange={setValue}
        running={running}
        onStop={stop}
        stopping={stopping}
        placeholder={`Message ${agent.name}…`}
      />
    </div>
  )
}
