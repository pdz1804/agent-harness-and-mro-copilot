import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // api.py mounts this at "/" and serves it as static files from the
    // same FastAPI process (see agent-harness/README.md "Run the app").
    outDir: 'dist',
  },
})
