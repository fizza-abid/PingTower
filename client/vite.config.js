import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    // Arena's live preview uses a dynamic *.e2b.app hostname. Keep the allowlist
    // narrow instead of setting allowedHosts: true for every arbitrary host.
    allowedHosts: [".e2b.app"],
    proxy: { "/api": "http://localhost:5000" },
  },
});
