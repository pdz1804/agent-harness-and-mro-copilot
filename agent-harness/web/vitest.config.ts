import { defineConfig } from 'vitest/config'

// Separate from vite.config.ts on purpose: the app build has no test-only
// concerns and this keeps `vite build`'s config untouched. Component tests
// render to static markup with react-dom/server, so no DOM shim is needed.
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
  },
})
