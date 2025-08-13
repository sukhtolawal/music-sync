import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/socket.io': {
        target: process.env.VITE_SERVER_URL || 'http://localhost:4000',
        ws: true,
        changeOrigin: true,
      },
      '/health': {
        target: process.env.VITE_SERVER_URL || 'http://localhost:4000',
        changeOrigin: true,
      },
      '/proxy': {
        target: process.env.VITE_SERVER_URL || 'http://localhost:4000',
        changeOrigin: true,
      },
      '/media': {
        target: process.env.VITE_SERVER_URL || 'http://localhost:4000',
        changeOrigin: true,
      },
      '/songs': {
        target: process.env.VITE_SERVER_URL || 'http://localhost:4000',
        changeOrigin: true,
      },
    }
  },
  envPrefix: ['VITE_']
})
