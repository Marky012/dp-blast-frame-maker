import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(async ({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  for (const [k, v] of Object.entries(env)) {
    if (process.env[k] === undefined) {
      process.env[k] = v;
    }
  }

  const plugins = [react()];
  if (command === 'serve') {
    try {
      const { default: netlify } = await import('@netlify/vite-plugin');
      plugins.push(netlify({ edgeFunctions: { enabled: false } }));
    } catch {
      // Running under netlify dev CLI directly
    }
  }

  return {
    plugins,
    server: {
      port: 8888,
      strictPort: true,
    },
  };
});
