import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In development the FastAPI backend runs on :8000; in production it serves the built app.
export default defineConfig({
  plugins: [react()],
  build: {
    // Plotly (~1.4 MB) is lazy-loaded into its own chunk; the app chunk stays small.
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8000',
    },
  },
})
