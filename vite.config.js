import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), {
    name: 'staging-development-context', apply: 'serve',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { name: 'rentsphere-staging', content: 'true' }, injectTo: 'head' }]
  }],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
      },
      '/uploads': {
        target: 'http://localhost:5000',
        changeOrigin: true,
      },
    },
  },
});
