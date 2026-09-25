import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  // These files each run terrain workers, WebGL and physics. Parallel browsers
  // can starve preview rebuilds on software-rendered or busy desktop hosts.
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:6173",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          // GitHub's Linux runners have no physical GPU. Chromium requires an
          // explicit opt-in before Three.js can use its SwiftShader WebGL
          // fallback, which keeps the real render/physics loop under test.
          args: ["--enable-unsafe-swiftshader"],
        },
      },
    },
  ],
});
