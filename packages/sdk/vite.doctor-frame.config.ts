import { productionJavaScript } from "../../scripts/production-javascript.ts";
import { defineConfig } from "vite";
// The doctor's probe for frame-hosted applications: one classic script, without imports, that the doctor evaluates in
// the application's page (src/browser-test/doctor-frame-client.ts). It stays outside assets/doctor, which
// `assets install` stages into self-hosted applications.
export default defineConfig({ plugins: [productionJavaScript()], root: import.meta.dirname, base: "./", build: { outDir: "assets/doctor-frame", emptyOutDir: true, sourcemap: false, lib: { entry: "src/browser-test/doctor-frame-client.ts", formats: ["iife"], name: "OxideVMDoctorFrame", fileName: () => "client.js" } } });
