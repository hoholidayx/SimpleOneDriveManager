import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const host = env.HOST || '0.0.0.0';
  const backendHost = host === '0.0.0.0' || host === 'localhost' ? '127.0.0.1' : host === '::' ? '::1' : host;
  const target = `http://${backendHost.includes(':') ? `[${backendHost}]` : backendHost}:${env.PORT || 3000}`;
  return {
  plugins: [react()],
  build: {
    outDir: 'dist/client', chunkSizeWarningLimit: 1000,
    rolldownOptions: { output: { codeSplitting: { groups: [
      { name: 'react', test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/, priority: 20 },
      { name: 'ui', test: /node_modules[\\/]/, priority: 10 }
    ] } } }
  },
  server: {
    host, port: 5173, strictPort: true,
    allowedHosts: env.APP_ORIGIN ? [new URL(env.APP_ORIGIN).hostname] : [],
    proxy: { '/api': target, '/health': target }
  }
  };
});
