import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "appwalk-output",
  timeout: 30_000,
  reporter: "list",
});
