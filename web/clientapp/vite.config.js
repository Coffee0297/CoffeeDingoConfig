import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// Dev:   `npm run dev`   -> Vite on :5173, proxies /api + /hub to the .NET backend on :5000.
// Build: `npm run build` -> emits the SPA straight into the backend's wwwroot, so the
//                           .NET app serves everything single-process on :5000.
export default defineConfig({
  plugins: [svelte()],
  build: {
    outDir: '../wwwroot',
    emptyOutDir: true,
    rollupOptions: {
      // @microsoft/signalr ships /*#__PURE__*/ comments the bundler can't place — harmless, hush it.
      onwarn(warning, warn) {
        if (warning.code === 'INVALID_ANNOTATION' && /signalr/.test(warning.id ?? warning.message ?? '')) return
        warn(warning)
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:5000', changeOrigin: true },
      '/hub': { target: 'http://localhost:5000', ws: true, changeOrigin: true },
    },
  },
})
