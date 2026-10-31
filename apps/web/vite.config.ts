import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const CONTROL_URL = process.env.NAV_CONTROL_URL ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5180,
    strictPort: true,
    proxy: {
      '/api': {
        target: CONTROL_URL,
        changeOrigin: false,
        ws: false,
        // Keep Server-Sent Events flowing: never buffer or compress event streams.
        configure(proxy) {
          proxy.on('proxyReq', (proxyReq, req) => {
            if (req.headers.accept?.includes('text/event-stream')) {
              proxyReq.setHeader('Accept-Encoding', 'identity');
            }
          });
          proxy.on('proxyRes', (proxyRes, _req, res) => {
            const type = proxyRes.headers['content-type'] ?? '';
            if (type.includes('text/event-stream')) {
              proxyRes.headers['cache-control'] = 'no-cache, no-transform';
              proxyRes.headers['x-accel-buffering'] = 'no';
              delete proxyRes.headers['content-length'];
              res.flushHeaders?.();
              proxyRes.socket?.setNoDelay?.(true);
            }
          });
        },
      },
    },
  },
  preview: { port: 4173 },
  build: { target: 'es2022', sourcemap: true },
});
