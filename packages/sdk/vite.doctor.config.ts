import { productionJavaScript } from "../../scripts/production-javascript.ts";
import { defineConfig } from "vite";
export default defineConfig({ plugins: [productionJavaScript()], root: import.meta.dirname, base: "./", build: { outDir: "assets/doctor", emptyOutDir: true, sourcemap: false, lib: { entry: "src/browser-test/doctor-client.ts", formats: ["es"], fileName: "client" } }, worker: { format: "es", plugins: () => [productionJavaScript()] } });
