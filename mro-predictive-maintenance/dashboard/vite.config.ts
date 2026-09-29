import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Static dashboard, no backend required: `vite build` emits dist/, `vite preview`
// serves it locally. See dashboard/README section in the project README.md.
export default defineConfig({
  plugins: [react()],
  base: "./",
});
