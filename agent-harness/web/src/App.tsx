import { useEffect, useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useParams } from 'react-router-dom'
import { AppShell } from './components/AppShell'
import { LinkButton } from './components/ui/Button'
import { EmptyState } from './components/ui/EmptyState'
import { TimelineSkeleton } from './components/ui/Skeleton'
import { api } from './lib/api'
import { AgentEditorRoute, AgentsPage } from './pages/AgentsPage'
import { AutomationsPage } from './pages/AutomationsPage'
import { DashboardPage } from './pages/DashboardPage'
import { DashboardsPage } from './pages/DashboardsPage'
import { EvalRunPage } from './pages/EvalRunPage'
import { EvalsPage } from './pages/EvalsPage'
import { GuardrailsPage } from './pages/GuardrailsPage'
import { IncidentDetailPage } from './pages/IncidentDetailPage'
import { IncidentsPage } from './pages/IncidentsPage'
import { IntegrationsPage } from './pages/IntegrationsPage'
import { KnowledgeBasePage } from './pages/KnowledgeBasePage'
import { LogsPage } from './pages/LogsPage'
import { MemoryPage } from './pages/MemoryPage'
import { NewRunPage } from './pages/NewRunPage'
import { PromptLibraryPage } from './pages/PromptLibraryPage'
import { RunPage } from './pages/RunPage'
import { ServicesPage } from './pages/ServicesPage'
import { SessionsPage } from './pages/SessionsPage'
import { SkillsPage } from './pages/SkillsPage'
import { ChatsCircle } from '@phosphor-icons/react'

/** `/sessions/:sessionId` — the conversation thread at its latest turn. The
 * thread view is keyed by a run (`RunPage`), so resolve the session's newest
 * run and render it in place (the URL stays the clean session URL). */
function SessionThreadRoute() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const [state, setState] = useState<{ sessionId: string; runId: string | null } | 'missing' | null>(null)

  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    api
      .getSession(sessionId)
      .then((detail) => {
        if (cancelled) return
        const latest = [...detail.runs].sort((a, b) => b.started_at - a.started_at)[0]
        setState({ sessionId, runId: latest?.run_id ?? detail.last_run_id ?? null })
      })
      .catch(() => {
        if (!cancelled) setState('missing')
      })
    return () => {
      cancelled = true
    }
  }, [sessionId])

  if (state === 'missing' || (state && state.sessionId === sessionId && !state.runId)) {
    return (
      <EmptyState
        icon={<ChatsCircle size={22} weight="duotone" />}
        title="Session not found"
        description="It may have been deleted, or it belongs to another user."
        action={
          <LinkButton to="/sessions" variant="secondary">
            View sessions
          </LinkButton>
        }
      />
    )
  }
  if (!state || state.sessionId !== sessionId || !state.runId) {
    return (
      <div className="mx-auto max-w-[72rem]">
        <TimelineSkeleton />
      </div>
    )
  }
  return <RunPage runIdOverride={state.runId} key={state.runId} />
}

/** Clean, resource-shaped URLs (served by api.py's SPA history fallback):
 *
 *   /chat                                new run
 *   /sessions                            session list
 *   /sessions/:sessionId                 conversation thread (latest turn)
 *   /sessions/:sessionId/runs/:runId     one specific turn of a thread
 *   /runs/:runId                         run permalink → canonical session URL
 *   /dashboards[/:id]  /evals[/runs/:id]  /prompts[/:id]  /knowledge[/:docId]
 *   /incidents[/:id]  /agents[/:id|new]  /memory  /services  /skills  /guardrails
 *   /automations  /logs  /settings/integrations
 *
 * Old links keep working: `/#/x` hash URLs are rewritten before the router
 * mounts (see main.tsx), and renamed paths redirect below. */
function App() {
  return (
    <BrowserRouter>
      <AppShell>
        <Routes>
          <Route path="/" element={<Navigate to="/chat" replace />} />
          <Route path="/chat" element={<NewRunPage />} />
          <Route path="/runs/:runId" element={<RunPage />} />
          <Route path="/sessions" element={<SessionsPage />} />
          <Route path="/sessions/:sessionId" element={<SessionThreadRoute />} />
          <Route path="/sessions/:sessionId/runs/:runId" element={<RunPage />} />
          <Route path="/memory" element={<MemoryPage />} />
          <Route path="/services" element={<ServicesPage />} />
          <Route path="/incidents" element={<IncidentsPage />} />
          <Route path="/incidents/:incidentId" element={<IncidentDetailPage />} />
          <Route path="/knowledge" element={<KnowledgeBasePage />} />
          <Route path="/knowledge/:docId" element={<KnowledgeBasePage />} />
          <Route path="/settings/integrations" element={<IntegrationsPage />} />
          <Route path="/prompts" element={<PromptLibraryPage />} />
          <Route path="/prompts/:promptId" element={<PromptLibraryPage />} />
          <Route path="/skills" element={<SkillsPage />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/agents/:agentId" element={<AgentEditorRoute />} />
          <Route path="/guardrails" element={<GuardrailsPage />} />
          <Route path="/automations" element={<AutomationsPage />} />
          <Route path="/dashboards" element={<DashboardsPage />} />
          <Route path="/dashboards/:dashboardId" element={<DashboardPage />} />
          <Route path="/evals" element={<EvalsPage />} />
          <Route path="/evals/runs/:evalRunId" element={<EvalRunPage />} />
          <Route path="/logs" element={<LogsPage />} />
          {/* Renamed paths: keep old bookmarks working. */}
          <Route path="/history" element={<Navigate to="/sessions" replace />} />
          <Route path="/artifacts" element={<Navigate to="/dashboards" replace />} />
          <Route path="/kb" element={<Navigate to="/knowledge" replace />} />
          <Route path="/kb/:docId" element={<LegacyKbDoc />} />
          <Route path="/integrations" element={<Navigate to="/settings/integrations" replace />} />
          <Route path="*" element={<Navigate to="/chat" replace />} />
        </Routes>
      </AppShell>
    </BrowserRouter>
  )
}

function LegacyKbDoc() {
  const { docId } = useParams<{ docId: string }>()
  return <Navigate to={`/knowledge/${docId ?? ''}`} replace />
}

export default App
