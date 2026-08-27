import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts$/,
  respectGitIgnore: false,
  timeout: 30_000,
  reporter: "list",
});
