import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const useProxy = env.VITE_USE_PROXY === "true";
  console.log(`[Vite] Using proxy: ${useProxy}`);

  return {
    server: {
      proxy: useProxy
        ? {
            "/api": {
              target: "http://localhost:8000",
              changeOrigin: true,
              rewrite: (p) => p.replace(/^\/api/, ""), // /api/auth/login -> /auth/login
            },
          }
        : undefined,
    },
    plugins: [react()],
  };
});
