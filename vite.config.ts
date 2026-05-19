import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  root: 'src/renderer',
  base: './',
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src/renderer/src') }
  },
  build: {
    outDir: '../../dist',
    emptyOutDir: true
  },
  server: { port: 5173 }
})
