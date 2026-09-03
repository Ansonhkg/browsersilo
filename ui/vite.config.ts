import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: new URL(".", import.meta.url).pathname,
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "../dist/ui",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("@heroui") || id.includes("@internationalized") || id.includes("react-aria")) return "heroui";
          if (id.includes("@tanstack")) return "tanstack";
          if (id.includes("/effect/") || id.includes("fast-check")) return "effect";
          if (id.includes("/react/") || id.includes("react-dom") || id.includes("react-is")) return "react";
          return "vendor";
        },
      },
    },
  },
});
