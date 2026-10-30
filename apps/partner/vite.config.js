import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  server: { host: true, port: 5174 },
  build: { target: "es2019", chunkSizeWarningLimit: 700 },
  test: { environment: "jsdom", include: ["test/**/*.test.{js,jsx}"] },
});
