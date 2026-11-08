import { defineConfig, devices } from "@playwright/test";

// Every run leaves an evidence pack: video, trace, screenshots, HTML + JSON report.
// DEMO=1: 1080p video in slow motion for the recorded walkthrough (same test, same assertions).
const demo = !!process.env.DEMO;
// QA_SHOW=1: headed on the run's own desktop (QA_DISPLAY from tools/e2e-env.sh), so the agent's and the
// test's browser can be watched live next to the Java client and end up in the run's screen recording.
const show = process.env.QA_SHOW === "1" && !!process.env.QA_DISPLAY;
if (show) process.env.DISPLAY = process.env.QA_DISPLAY;

export default defineConfig({
  testDir: "tests/e2e",
  outputDir: "evidence/test-results",
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0, // a flaky test is a defect to fix, not to retry away
  reporter: [
    ["list"],
    ["html", { outputFolder: "evidence/playwright-report", open: "never" }],
    ["json", { outputFile: "evidence/results.json" }],
  ],
  use: {
    ...devices["Desktop Chrome"],
    locale: "en-US",
    timezoneId: "Europe/Berlin",
    viewport: demo ? { width: 1920, height: 1080 } : { width: 1440, height: 900 },
    video: demo ? { mode: "on", size: { width: 1920, height: 1080 } } : "on",
    headless: !show,
    launchOptions: { slowMo: demo ? 350 : 0, args: show ? ["--window-position=0,0"] : [] },
    trace: "on",
    screenshot: "on",
    actionTimeout: 15_000,
  },
});
