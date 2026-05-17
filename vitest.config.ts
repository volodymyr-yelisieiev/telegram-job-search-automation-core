import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
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
      "@job-search/automation": "/Users/v.yelisieiev/Documents/Personal/job-search/packages/automation/src/index.ts",
      "@job-search/config": "/Users/v.yelisieiev/Documents/Personal/job-search/packages/config/src/index.ts",
      "@job-search/db": "/Users/v.yelisieiev/Documents/Personal/job-search/packages/db/src/index.ts",
      "@job-search/domain": "/Users/v.yelisieiev/Documents/Personal/job-search/packages/domain/src/index.ts",
      "@job-search/llm": "/Users/v.yelisieiev/Documents/Personal/job-search/packages/llm/src/index.ts",
      "@job-search/observability": "/Users/v.yelisieiev/Documents/Personal/job-search/packages/observability/src/index.ts",
      "@job-search/providers": "/Users/v.yelisieiev/Documents/Personal/job-search/packages/providers/src/index.ts",
      "@job-search/telegram-ui": "/Users/v.yelisieiev/Documents/Personal/job-search/packages/telegram-ui/src/index.ts",
      "@job-search/testing": "/Users/v.yelisieiev/Documents/Personal/job-search/packages/testing/src/index.ts"
    }
  }
});
