import { ArrowsLeftRight, ChatCircleDots, PaperPlaneTilt, Stop, Trash } from '@phosphor-icons/react'
import { useEffect, useMemo, useState } from 'react'
import { useRunStream } from '../../hooks/useRunStream'
import { api, errorText } from '../../lib/api'
import { TERMINAL_STATUSES, type PlaygroundSpec, type PromptDetail, type RunSnapshot } from '../../lib/api-types'
import { compareRuns } from '../../lib/playground-compare'
import { ChatTurn } from '../chat/ChatTurn'
import { Button, Card, CardHeader, ErrorBanner, Field, Select, Skeleton, Switch, Table, Textarea } from '../ui'

/** Which prompt text a playground side runs with. */
type Source = { kind: 'draft' } | { kind: 'version'; versionId: string }

function sourceKey(source: Source): string {
  return source.kind === 'draft' ? 'draft' : source.versionId
}

function specFor(source: Source, draft: string, promptId: string): PlaygroundSpec {
  return source.kind === 'draft' ? { system_prompt: draft } : { prompt_id: promptId, prompt_version_id: source.versionId }
}

/** One live turn of a playground thread: a real run streamed over SSE, with
 * the real approval gate and a Stop button. Reports its snapshot upward so
 * the compare table can read the finished runs. */
function PlaygroundTurn({ runId, onSnapshot }: { runId: string; onSnapshot: (runId: string, snapshot: RunSnapshot) => void }) {
  const { snapshot, live, refresh, streamingFinalAnswer, streamingToolArgs, error } = useRunStream(runId)
  const [stopping, setStopping] = useState(false)
  const [stopError, setStopError] = useState<string | null>(null)

  useEffect(() => {
    if (snapshot) onSnapshot(runId, snapshot)
  }, [snapshot, runId, onSnapshot])

  if (!snapshot) return error ? <ErrorBanner message={error} /> : <Skeleton className="h-16 w-full" />
  const running = !TERMINAL_STATUSES.has(snapshot.status)
  return (
    <div className="space-y-2">
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
      {running && (
        <Button
          size="sm"
          icon={<Stop size={12} weight="fill" />}
          loading={stopping}
          onClick={() => {
            setStopping(true)
            setStopError(null)
            api
              .cancelRun(snapshot.run_id)
              .catch((err: unknown) => setStopError(errorText(err, 'Could not stop the run.')))
              .finally(() => {
                setStopping(false)
                refresh()
              })
          }}
        >
          {stopping ? 'Stopping' : 'Stop'}
        </Button>
      )}
      {stopError && <p className="text-xs text-rose-700">{stopError}</p>}
    </div>
  )
}

function SourcePicker({ label, detail, value, hasDraft, onChange }: { label: string; detail: PromptDetail; value: Source; hasDraft: boolean; onChange: (source: Source) => void }) {
  return (
    <Field label={label}>
      {({ id }) => (
        <Select id={id} value={sourceKey(value)} onChange={(e) => onChange(e.target.value === 'draft' ? { kind: 'draft' } : { kind: 'version', versionId: e.target.value })} className="w-full">
          {hasDraft && <option value="draft">Draft (unsaved)</option>}
          {detail.versions.map((v) => (
            <option key={v.id} value={v.id}>
              v{v.version}
              {v.id === detail.active_version?.id ? ' (active)' : ''}
            </option>
          ))}
        </Select>
      )}
    </Field>
  )
}

interface Thread {
  sessionId: string | null
  runIds: string[]
}

const EMPTY_THREAD: Thread = { sessionId: null, runIds: [] }

/** Prompt Playground: chat with a real agent using any version of this prompt
 * (or the unsaved draft) against the real tools - the approval gate still
 * applies - or run two versions side by side on the same input and compare.
 * Every message is a normal run (visible in Sessions, titled "[Playground]"),
 * so what you see here is exactly what production would do. */
export function PlaygroundPanel({
  detail,
  draft,
  onDraftChange,
  canRun,
  runDisabledReason,
}: {
  detail: PromptDetail
  draft: string
  onDraftChange: (value: string) => void
  canRun: boolean
  /** Why running is off for this role (shown beside the composer). */
  runDisabledReason?: string
}) {
  const hasDraft = draft.trim().length > 0
  const activeVersionId = detail.active_version?.id ?? detail.versions[0]?.id
  const [compare, setCompare] = useState(false)
  const [sourceA, setSourceA] = useState<Source>(hasDraft ? { kind: 'draft' } : { kind: 'version', versionId: activeVersionId })
  const [sourceB, setSourceB] = useState<Source>({ kind: 'version', versionId: activeVersionId })
  const [message, setMessage] = useState('')
  const [threadA, setThreadA] = useState<Thread>(EMPTY_THREAD)
  const [threadB, setThreadB] = useState<Thread>(EMPTY_THREAD)
  const [snapshots, setSnapshots] = useState<Record<string, RunSnapshot>>({})
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // If the draft disappears while it is selected, fall back to the active version.
  const fallback: Source = { kind: 'version', versionId: activeVersionId }
  const effectiveA: Source = sourceA.kind === 'draft' && !hasDraft ? fallback : sourceA
  const effectiveB: Source = sourceB.kind === 'draft' && !hasDraft ? fallback : sourceB

  const recordSnapshot = useMemo(() => (runId: string, snapshot: RunSnapshot) => setSnapshots((prev) => (prev[runId] === snapshot ? prev : { ...prev, [runId]: snapshot })), [])

  const send = async () => {
    const text = message.trim()
    if (!text || sending) return
    setSending(true)
    setError(null)
    try {
      const start = async (source: Source, thread: Thread): Promise<Thread> => {
        const response = await api.startRun({
          objective: text,
          session_id: thread.sessionId ?? undefined,
          playground: specFor(source, draft, detail.id),
        })
        return { sessionId: response.session_id, runIds: [...thread.runIds, response.run_id] }
      }
      const [nextA, nextB] = await Promise.all([start(effectiveA, threadA), compare ? start(effectiveB, threadB) : Promise.resolve(threadB)])
      setThreadA(nextA)
      if (compare) setThreadB(nextB)
      setMessage('')
    } catch (err) {
      setError(errorText(err, 'Failed to start the playground run.'))
    } finally {
      setSending(false)
    }
  }

  const reset = () => {
    setThreadA(EMPTY_THREAD)
    setThreadB(EMPTY_THREAD)
    setSnapshots({})
    setError(null)
  }

  const lastA = threadA.runIds[threadA.runIds.length - 1]
  const lastB = threadB.runIds[threadB.runIds.length - 1]
  const comparison = useMemo(() => {
    const a = lastA ? snapshots[lastA] : null
    const b = lastB ? snapshots[lastB] : null
    return a && b && TERMINAL_STATUSES.has(a.status) && TERMINAL_STATUSES.has(b.status) ? compareRuns(a, b) : []
  }, [lastA, lastB, snapshots])

  const renderThread = (thread: Thread, title: string) => (
    <div className="min-w-0 space-y-6">
      <p className="text-xs font-medium text-zinc-500">{title}</p>
      {thread.runIds.length === 0 ? (
        <p className="rounded-[14px] border border-dashed border-[var(--color-line-strong)] p-4 text-center text-xs text-zinc-500">Nothing yet. Send a message below.</p>
      ) : (
        thread.runIds.map((id) => <PlaygroundTurn key={id} runId={id} onSnapshot={recordSnapshot} />)
      )}
    </div>
  )

  return (
    <div className="space-y-4" data-testid="playground-panel">
      <Card className="space-y-3">
        <CardHeader
          title={
            <span className="flex items-center gap-1.5">
              <ChatCircleDots size={16} weight="bold" className="text-sky-600" />
              Playground
            </span>
          }
          actions={
            <>
              <span className="flex items-center gap-2 text-xs text-zinc-600">
                <ArrowsLeftRight size={13} weight="bold" aria-hidden="true" />
                Compare two versions
                <Switch
                  label="Compare two versions"
                  checked={compare}
                  onChange={(next) => {
                    setCompare(next)
                    reset()
                  }}
                />
              </span>
              <Button size="sm" icon={<Trash size={12} weight="bold" />} onClick={reset}>
                Clear
              </Button>
            </>
          }
        />

        <div className={`grid gap-3 ${compare ? 'sm:grid-cols-2' : ''}`}>
          <SourcePicker label={compare ? 'Version A' : 'Prompt to chat with'} detail={detail} value={effectiveA} hasDraft={hasDraft} onChange={setSourceA} />
          {compare && <SourcePicker label="Version B" detail={detail} value={effectiveB} hasDraft={hasDraft} onChange={setSourceB} />}
        </div>

        <Field label="Draft (unsaved)" hint="Shared with the draft tab. Type or paste a prompt to try it before saving it as a version." optional>
          {({ id, ...aria }) => <Textarea id={id} {...aria} name="draft" autoComplete="off" value={draft} onChange={(e) => onDraftChange(e.target.value)} rows={4} className="w-full" />}
        </Field>
        <p className="text-xs text-zinc-500">Runs use the real, enabled tools for your role. Anything that needs approval (creating an incident or a dashboard) still pauses for you to approve or deny.</p>
      </Card>

      {error && <ErrorBanner message={error} />}

      <div className={`grid gap-6 ${compare ? 'lg:grid-cols-2' : ''}`}>
        {renderThread(threadA, compare ? 'A' : 'Conversation')}
        {compare && renderThread(threadB, 'B')}
      </div>

      {comparison.length > 0 && (
        <div data-testid="compare-table" className="space-y-2">
          <p className="text-xs font-medium text-zinc-500">Side by side (latest message)</p>
          <Table label="Side by side comparison">
            <thead>
              <tr>
                <th>
                  <span className="sr-only">Metric</span>
                </th>
                <th>A</th>
                <th>B</th>
              </tr>
            </thead>
            <tbody>
              {comparison.map((row) => (
                <tr key={row.label}>
                  <td className="text-xs text-zinc-500">{row.label}</td>
                  <td className={`font-data ${row.lowerIsBetter === 'a' ? 'font-semibold text-emerald-700' : 'text-zinc-800'}`}>{row.a}</td>
                  <td className={`font-data ${row.lowerIsBetter === 'b' ? 'font-semibold text-emerald-700' : 'text-zinc-800'}`}>{row.b}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}

      <div className="sticky bottom-2 z-10 rounded-[20px] border border-[var(--color-line)] bg-white p-2 shadow-[var(--shadow-lift)]">
        <div className="flex items-end gap-2">
          <Textarea
            aria-label="Playground message"
            name="message"
            autoComplete="off"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
            rows={2}
            disabled={!canRun}
            title={canRun ? undefined : runDisabledReason}
            placeholder={compare ? 'One message, sent to both versions' : 'Message the agent with this prompt'}
            className="max-h-32 min-h-0 flex-1 resize-none !border-transparent !shadow-none"
          />
          <Button variant="primary" iconOnly icon={<PaperPlaneTilt size={16} weight="bold" />} aria-label="Send playground message" title={canRun ? 'Send (Enter)' : runDisabledReason} loading={sending} disabled={!canRun || !message.trim()} onClick={() => void send()} />
        </div>
        {!canRun && runDisabledReason && <p className="px-2 pt-1 text-xs text-zinc-500">{runDisabledReason}</p>}
      </div>
    </div>
  )
}
