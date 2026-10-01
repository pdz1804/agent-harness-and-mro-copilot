import { IconContext } from '@phosphor-icons/react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import './index.css'
import App from './App.tsx'

// Old hash links (`/#/runs/<id>`, `/#/kb`) predate clean URLs: rewrite them
// to the equivalent path before the router mounts, so bookmarks keep working.
if (window.location.hash.startsWith('#/')) {
  window.history.replaceState(null, '', window.location.hash.slice(1))
}

// Every Phosphor icon in the app is decorative (icon-only buttons carry their
// own aria-label), so hide them from assistive tech by default.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <IconContext.Provider value={{ 'aria-hidden': true }}>
      <App />
    </IconContext.Provider>
  </StrictMode>,
)
