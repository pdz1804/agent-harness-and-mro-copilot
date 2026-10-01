import { defineConfig } from "vitest/config";

// Minimal vitest setup: the dashboard's src/ had no test runner before this
// pass. Coverage here is deliberately scoped to pure, DOM-free logic (e.g.
// `useCopilotStream`'s `nextLastEventId`) so no jsdom environment or
// testing-library dependency is needed -- "node" environment is sufficient
// and keeps the added dependency surface to just `vitest` itself.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
