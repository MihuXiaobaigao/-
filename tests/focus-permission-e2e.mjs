import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const baseUrl = process.env.BIANDU_BASE_URL || "http://127.0.0.1:4173";
const browser = await chromium.launch({
  headless: true,
  executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
});

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(baseUrl, { waitUntil: "networkidle" });

  const granted = await page.evaluate(async () => {
    localStorage.removeItem("biandu.dnd-permission-prompt.v1");
    let opened = 0;
    Object.defineProperty(window, "Capacitor", {
      configurable: true,
      value: {
        Plugins: {
          BianduFocus: {
            enterFocusMode: async () => ({ dndAccess: true, needsDndAccess: false }),
            exitFocusMode: async () => ({ dndAccess: true }),
            openDndSettings: async () => { opened += 1; },
          },
        },
      },
    });
    await window.BianDuFeatures.setReaderFocusMode(true);
    await new Promise((resolve) => setTimeout(resolve, 450));
    return { opened, toast: document.getElementById("toastRoot")?.innerText || "" };
  });
  assert.equal(granted.opened, 0, "The system settings page must not open when DND access is already granted");
  assert.doesNotMatch(granted.toast, /勿扰模式/, "The app must not repeatedly ask for an already granted permission");

  const deniedFirst = await page.evaluate(async () => {
    localStorage.removeItem("biandu.dnd-permission-prompt.v1");
    let opened = 0;
    Object.defineProperty(window, "Capacitor", {
      configurable: true,
      value: {
        Plugins: {
          BianduFocus: {
            enterFocusMode: async () => ({ dndAccess: false, needsDndAccess: true }),
            exitFocusMode: async () => ({ dndAccess: false }),
            openDndSettings: async () => { opened += 1; },
          },
        },
      },
    });
    await window.BianDuFeatures.setReaderFocusMode(false);
    await window.BianDuFeatures.setReaderFocusMode(true);
    await new Promise((resolve) => setTimeout(resolve, 450));
    return {
      opened,
      promptedAt: Number(localStorage.getItem("biandu.dnd-permission-prompt.v1") || 0),
    };
  });
  assert.equal(deniedFirst.opened, 1, "A missing DND permission should be explained once");
  assert.ok(deniedFirst.promptedAt > 0, "The prompt timestamp should suppress repeated interruptions");

  console.log("Focus permission behavior passed: granted access is respected and missing access is not repeatedly prompted.");
} finally {
  await browser.close();
}
