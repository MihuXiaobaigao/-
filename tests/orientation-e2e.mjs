import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";

const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const configuredBaseUrl = process.env.BIANDU_BASE_URL || "";
const baseUrl = configuredBaseUrl || "http://127.0.0.1:4176";
let server;

async function waitForServer(url) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {
      // The static server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Static server did not start at ${url}`);
}

async function openPage(browser, viewport) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
    serviceWorkers: "block",
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForSelector("#sideNavList [data-nav]", { state: "attached" });
  return { context, page, errors };
}

async function layoutState(page) {
  return page.evaluate(() => {
    const side = document.querySelector(".side-nav");
    const bottom = document.querySelector(".bottom-nav");
    const app = document.getElementById("app");
    const visibleBottomItems = Array.from(bottom.querySelectorAll("[data-nav]"));
    const viewportWidth = window.innerWidth;
    return {
      viewportWidth,
      viewportHeight: window.innerHeight,
      sideDisplay: getComputedStyle(side).display,
      bottomDisplay: getComputedStyle(bottom).display,
      rootOverflow: document.documentElement.scrollWidth - viewportWidth,
      bodyOverflow: document.body.scrollWidth - viewportWidth,
      appRight: app.getBoundingClientRect().right,
      bottomRight: bottom.getBoundingClientRect().right,
      bottomWidth: bottom.getBoundingClientRect().width,
      navCount: visibleBottomItems.length,
    };
  });
}

function assertLayout(state, expected) {
  assert.equal(state.sideDisplay, expected.sideDisplay);
  assert.equal(state.bottomDisplay, expected.bottomDisplay);
  assert.ok(state.rootOverflow <= 1, `document overflowed by ${state.rootOverflow}px`);
  assert.ok(state.bodyOverflow <= 1, `body overflowed by ${state.bodyOverflow}px`);
  assert.ok(state.appRight <= state.viewportWidth + 1, "app exceeded the viewport width");
  if (expected.bottomDisplay === "flex") {
    assert.equal(state.navCount, 6, "portrait navigation should expose every section");
    assert.ok(state.bottomWidth <= state.viewportWidth + 1, "bottom navigation exceeded the viewport");
    assert.ok(state.bottomRight <= state.viewportWidth + 1, "bottom navigation moved outside the viewport");
  }
}

async function visitEverySection(page, selector) {
  const labels = ["library", "kb", "graph", "dict", "board", "settings"];
  for (const label of labels) {
    const item = page.locator(`${selector}[data-nav="${label}"]`);
    await item.click();
    await page.waitForTimeout(120);
    await page.waitForSelector("#mainContent > *", { state: "attached" });
    if (label === "board") {
      await page.evaluate(() => window.BianDuRuntime.app.switchView("library"));
      await page.waitForTimeout(120);
    }
  }
}

async function assertPortraitKnowledgeDrawer(page, selector) {
  await page.locator(`${selector}[data-nav="kb"]`).click();
  await page.waitForSelector(".kb-agent-shell");
  if (await page.locator("#realKbSidebarReopenBtn").count()) {
    await page.click("#realKbSidebarReopenBtn");
  }
  await page.waitForSelector(".kb-agent-shell.is-sidebar-open");
  const geometry = await page.evaluate(() => {
    const sidebar = document.querySelector(".kb-chat-sidebar").getBoundingClientRect();
    const composer = document.querySelector(".kb-agent-composer").getBoundingClientRect();
    return {
      sidebarRight: sidebar.right,
      composerLeft: composer.left,
      sidebarDisplay: getComputedStyle(document.querySelector(".kb-chat-sidebar")).display,
    };
  });
  assert.equal(geometry.sidebarDisplay, "flex");
  assert.ok(geometry.sidebarRight <= geometry.composerLeft + 1, "Portrait chat composer must not overlap the conversation sidebar");
  await page.click("#realKbSidebarToggle");
  await page.waitForFunction(() => !document.querySelector(".kb-agent-shell.is-sidebar-open"));
}

async function assertBoardToolRail(page, selector) {
  await page.locator(`${selector}[data-nav="board"]`).click();
  await page.waitForSelector("#boardGalleryCreateBtn, #boardGalleryEmptyCreateBtn");
  await page.locator("#boardGalleryCreateBtn, #boardGalleryEmptyCreateBtn").first().click();
  await page.waitForSelector(".bd-board-rail");
  const rail = await page.evaluate(() => {
    const rail = document.querySelector(".bd-board-rail").getBoundingClientRect();
    const tools = [...document.querySelectorAll(".bd-rail-tool, .bd-more-tool")].map((item) => item.getBoundingClientRect());
    return {
      right: rail.right,
      top: rail.top,
      bottom: rail.bottom,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      minToolWidth: Math.min(...tools.map((item) => item.width)),
      count: tools.length,
      markers: document.querySelectorAll(".bd-marker").length,
      navHidden: getComputedStyle(document.querySelector(".side-nav")).display === "none" &&
        getComputedStyle(document.querySelector(".bottom-nav")).display === "none",
    };
  });
  assert.ok(rail.right <= rail.viewportWidth + 1);
  assert.ok(rail.top >= 0 && rail.bottom <= rail.viewportHeight + 1);
  assert.ok(rail.minToolWidth >= 40);
  assert.ok(rail.count >= 10, "Board rail should retain every drawing tool");
  assert.equal(rail.markers, 8);
  assert.equal(rail.navHidden, true, "Board editor should use the full tablet canvas");
  await page.evaluate(() => window.BianDuRuntime.app.switchView("library"));
  await page.waitForTimeout(120);
}

try {
  if (!configuredBaseUrl) {
    server = spawn(process.execPath, ["tools/serve.mjs"], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: "4176" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    await waitForServer(baseUrl);
  }

  const browser = await chromium.launch({ headless: true, executablePath: edgePath });
  try {
    const xiaomi = await openPage(browser, { width: 1600, height: 1000 });
    assertLayout(await layoutState(xiaomi.page), { sideDisplay: "flex", bottomDisplay: "none" });
    await visitEverySection(xiaomi.page, ".nav-item");
    await xiaomi.page.setViewportSize({ width: 1068, height: 1600 });
    await xiaomi.page.waitForTimeout(350);
    assertLayout(await layoutState(xiaomi.page), { sideDisplay: "none", bottomDisplay: "flex" });
    await visitEverySection(xiaomi.page, ".bottom-nav-item");
    await assertPortraitKnowledgeDrawer(xiaomi.page, ".bottom-nav-item");
    await assertBoardToolRail(xiaomi.page, ".bottom-nav-item");
    assert.deepEqual(xiaomi.errors, []);
    await xiaomi.context.close();

    const ipad = await openPage(browser, { width: 834, height: 1112 });
    assertLayout(await layoutState(ipad.page), { sideDisplay: "none", bottomDisplay: "flex" });
    await visitEverySection(ipad.page, ".bottom-nav-item");
    await assertPortraitKnowledgeDrawer(ipad.page, ".bottom-nav-item");
    await assertBoardToolRail(ipad.page, ".bottom-nav-item");
    await ipad.page.setViewportSize({ width: 1112, height: 834 });
    await ipad.page.waitForTimeout(350);
    assertLayout(await layoutState(ipad.page), { sideDisplay: "flex", bottomDisplay: "none" });
    await visitEverySection(ipad.page, ".nav-item");
    assert.deepEqual(ipad.errors, []);
    await ipad.context.close();

    console.log("Xiaomi and iPad landscape/portrait layouts, navigation and overflow checks passed.");
  } finally {
    await browser.close();
  }
} finally {
  if (server) {
    server.kill();
    await new Promise((resolve) => server.once("exit", resolve));
  }
}
