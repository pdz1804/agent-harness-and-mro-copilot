import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from './components/AppShell'
import { HistoryPage } from './pages/HistoryPage'
import { IncidentsPage } from './pages/IncidentsPage'
import { KnowledgeBasePage } from './pages/KnowledgeBasePage'
import { LogsPage } from './pages/LogsPage'
import { NewRunPage } from './pages/NewRunPage'
import { RunPage } from './pages/RunPage'
import { ServicesPage } from './pages/ServicesPage'

// Hash-based routing (`/#/runs/<id>`) is deliberate: api.py serves this
// build as static files mounted at "/" with html=True, which only
// resolves index.html for the literal root path, not arbitrary deep
// links. Hash routes never hit the server's router at all, so refreshing
// or deep-linking to a run always works without a SPA-fallback route.
function App() {
  return (
    <HashRouter>
      <AppShell>
        <Routes>
          <Route path="/" element={<NewRunPage />} />
          <Route path="/runs/:runId" element={<RunPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/services" element={<ServicesPage />} />
          <Route path="/incidents" element={<IncidentsPage />} />
          <Route path="/kb" element={<KnowledgeBasePage />} />
          <Route path="/logs" element={<LogsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AppShell>
    </HashRouter>
  )
}

export default App
