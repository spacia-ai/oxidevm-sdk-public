import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["src/runtime/**/*.core-test.ts"] } });
