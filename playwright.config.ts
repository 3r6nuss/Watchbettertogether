import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  timeout: 45_000,
  workers: 1,
  use: { baseURL: "http://127.0.0.1:3100", browserName: "chromium", headless: true },
  webServer: {
    command: "npm start",
    url: "http://127.0.0.1:3100/api/health",
    reuseExistingServer: false,
    env: {
      PORT: "3100",
      NODE_ENV: "production",
      APP_ORIGIN: "http://127.0.0.1:3100",
      DATABASE_PATH: ":memory:",
    },
  },
});
