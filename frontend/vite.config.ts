import { copyFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

/** Also save the build as Sift.html: the one file to share, open from disk, or email. */
function namedCopy(): Plugin {
  return {
    name: 'sift-named-copy',
    apply: 'build',
    closeBundle() {
      copyFileSync(resolve('dist/index.html'), resolve('dist/Sift.html'))
    },
  }
}

// Everything (app, statistics engine worker, Plotly, styles, images) is inlined into one
// HTML file that works offline, straight from disk.
export default defineConfig({
  plugins: [react(), viteSingleFile(), namedCopy()],
  build: {
    chunkSizeWarningLimit: 4000,
  },
  worker: {
    // Classic, not module: module workers from blob URLs don't start on file:// pages.
    format: 'iife',
  },
  server: {
    port: 5173,
  },
})
