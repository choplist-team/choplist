import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "Choplist",
        short_name: "Choplist",
        description: "Simple weekly food ordering for local food businesses.",
        theme_color: "#2f6348",
        background_color: "#f8f8f3",
        display: "standalone",
        start_url: "/",
        scope: "/",
        icons: [
          {
            src: "/choplist-pwa-192x192.png",
            sizes: "192x192",
            type: "image/png",
          },

          {
            src: "/choplist-pwa-512x512.png",
            sizes: "512x512",
            type: "image/png",
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      "@": import.meta.dirname + "/src",
    },
  },
});
