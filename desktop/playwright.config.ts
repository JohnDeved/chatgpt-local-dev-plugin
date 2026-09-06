import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./test-ui",
  timeout: 45000,
  workers: 1,
  reporter: "list",
  outputDir: "../build/desktop-test-results",
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
});
