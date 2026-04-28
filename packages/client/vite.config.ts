import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icons/icon.svg"],
      manifest: {
        name: "pi web ui",
        short_name: "pi",
        description: "Browser interface for the pi coding agent",
        theme_color: "#0a0a0a",
        background_color: "#0a0a0a",
        display: "standalone",
        start_url: "/",
        scope: "/",
        // SVG icon with `purpose: any maskable` covers Chrome, Edge,
        // Firefox, and Android. iOS Safari home-screen install prefers
        // an apple-touch-icon (PNG) — we add that link tag in
        // index.html. Phase 18 swaps in real raster icons.
        icons: [
          {
            src: "/icons/icon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any maskable",
          },
        ],
      },
      workbox: {
        // The shell + hashed assets are cached on install. Anything
        // under /api/v1/* is dynamic and should be network-first so we
        // never serve a stale session list. The /api/v1/sessions/:id/
        // /stream SSE endpoint is excluded — caching a streaming
        // response would break it.
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//],
        globPatterns: ["**/*.{js,css,html,svg,png,ico,webmanifest}"],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith("/api/v1/"),
            handler: "NetworkOnly",
          },
        ],
      },
      devOptions: {
        // Keep the service worker disabled in `npm run dev` so HMR
        // works normally; the SW only activates on the built bundle.
        enabled: false,
      },
    }),
  ],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
