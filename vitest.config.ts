import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "packages/providers/generated/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["apps/**/*.ts", "packages/**/*.ts"],
      exclude: [
        "apps/**/src/index.ts",
        "packages/db/src/migrations.ts",
        "packages/providers/src/fixtures.ts",
        "packages/providers/src/selector-packs.ts",
        "packages/domain/src/defaults.ts",
        "packages/domain/src/types.ts",
        "packages/testing/src/index.ts"
      ],
      thresholds: {
        statements: 95,
        lines: 95,
        functions: 95,
        branches: 90
      }
    }
  },
  resolve: {
    alias: {
      "@job-search/automation": new URL("packages/automation/src/index.ts", `file://${root}`).pathname,
      "@job-search/config": new URL("packages/config/src/index.ts", `file://${root}`).pathname,
      "@job-search/db": new URL("packages/db/src/index.ts", `file://${root}`).pathname,
      "@job-search/domain": new URL("packages/domain/src/index.ts", `file://${root}`).pathname,
      "@job-search/llm": new URL("packages/llm/src/index.ts", `file://${root}`).pathname,
      "@job-search/observability": new URL("packages/observability/src/index.ts", `file://${root}`).pathname,
      "@job-search/providers": new URL("packages/providers/src/index.ts", `file://${root}`).pathname,
      "@job-search/telegram-ui": new URL("packages/telegram-ui/src/index.ts", `file://${root}`).pathname,
      "@job-search/testing": new URL("packages/testing/src/index.ts", `file://${root}`).pathname
    }
  }
});
