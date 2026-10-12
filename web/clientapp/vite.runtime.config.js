import { defineConfig } from 'vite'

// `npm run build` runs this after the SPA build: bundles the template engine (src/lib/runtime.js) into one
// plain script, wwwroot/template-runtime.js, that the backend runs in Jint for the MCP template tools.
export default defineConfig({
  build: {
    outDir: '../wwwroot',
    emptyOutDir: false,
    minify: false,
    lib: { entry: 'src/lib/runtime.js', name: 'DingoTpl', formats: ['iife'], fileName: () => 'template-runtime.js' },
  },
})
