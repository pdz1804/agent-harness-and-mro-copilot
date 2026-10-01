import { defineConfig } from 'vitest/config'

// Separate from vite.config.ts on purpose: the app build has no test-only
// concerns (jsdom, globals) and this keeps `vite build`'s config untouched.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
