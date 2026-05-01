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
      includeAssets: ["icons/icon.svg", "offline.html"],
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
        //
        // navigateFallback serves /index.html for SPA deep links while
        // online. When the SW can't reach the network at all (server
        // down, laptop offline, reverse proxy borked), the fetch
        // handler below catches the resulting failure and serves the
        // branded /offline.html instead — usable, in-theme, with a
        // reload button — rather than the browser's chromeless
        // "no-internet" page or the SPA shell with a red error banner.
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//],
        globPatterns: ["**/*.{js,css,html,svg,png,ico,webmanifest}"],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith("/api/v1/"),
            handler: "NetworkOnly",
          },
          {
            // Catches navigation requests when both the network AND
            // the precached /index.html navigateFallback fail. In
            // practice this fires when the SW itself can't reach the
            // server (no network, server down) — workbox falls
            // through to the precache, and if THAT misses too the
            // request errors out. The handler returns the precached
            // /offline.html for any navigation request as a final
            // fallback. NetworkFirst with a short timeout so we don't
            // make the user wait for a network round-trip when the
            // network's clearly down.
            urlPattern: ({ request }) => request.mode === "navigate",
            handler: "NetworkFirst",
            options: {
              cacheName: "pi-navigation",
              networkTimeoutSeconds: 3,
              precacheFallback: { fallbackURL: "/offline.html" },
            },
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
        // Forward WebSocket upgrades for `/api/v1/terminal` (Phase 11).
        // Without `ws: true`, Vite falls through to its own ws server
        // and the upgrade handshake fails.
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
