import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      // Preserve the browser Origin for backend CSRF checks.
      '/api': { target: process.env.API_PROXY_TARGET || 'http://localhost:3000', changeOrigin: false },
    },
  },
})
