import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const baseUrl = "http://127.0.0.1:4173";
const browser = await chromium.launch({ headless: true, executablePath: edgePath });

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(`${baseUrl}/index.html?view=kb`, { waitUntil: "networkidle" });
  await page.waitForSelector(".kb-agent-page");
  assert.equal(await page.locator(".kb-agent-heading p").count(), 0, "Knowledge heading should not have a subtitle");
  assert.equal(await page.locator("#realKbTaskMenuBtn").count(), 0, "The plus button must not duplicate task selection");
  assert.equal(await page.getAttribute("#realKbAttachBtn", "aria-label"), "上传图片或文档");

  const chooserPromise = page.waitForEvent("filechooser");
  await page.click("#realKbAttachBtn");
  const chooser = await chooserPromise;
  assert.match(await chooser.element().getAttribute("accept"), /image\/\*|application\/pdf/);
  await chooser.setFiles({
    name: "知识附件.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("附件证据：深度阅读需要主动降低认知干扰。\n\n另一段：笔记与阅读应互相链接。"),
  });
  await page.waitForFunction(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("biandu-local-v1", 4);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const evidence = await new Promise((resolve, reject) => {
      const request = db.transaction("evidence", "readonly").objectStore("evidence").getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return evidence.some((item) => item.sourceTitle === "知识附件.md");
  }, null, { timeout: 15_000 });

  await page.click('[data-kb-mode="task"]');
  assert.equal(await page.locator("#realKbTaskSelect").count(), 1, "Task formatting belongs inside task mode");
  assert.equal(await page.locator("#realKbAttachBtn").count(), 1, "The plus button remains available for uploads");

  await page.click('[data-nav="graph"]');
  await page.waitForSelector(".pg-node");
  await page.fill("#realGraphSearch", "知识附件");
  await page.waitForTimeout(100);
  assert.ok(await page.locator(".pg-node").count() >= 1, "Graph search should find the imported attachment page");
  await page.fill("#realGraphSearch", "不存在的知识页面");
  await page.waitForTimeout(100);
  assert.equal(await page.locator(".pg-node").count(), 0, "Graph search should actually filter nodes");

  await page.click('[data-nav="board"]');
  const blank = page.locator("#boardGalleryCreateBtn, #boardGalleryEmptyCreateBtn").first();
  await blank.click();
  await page.waitForSelector("#bdStage");
  await page.waitForFunction(() => Boolean(window.BianDuRuntime?.board?.getActive()));
  const stage = await page.locator("#bdStage").boundingBox();
  assert.ok(stage);

  await page.locator(".bd-marker").first().click();
  await page.mouse.move(stage.x + 180, stage.y + 170);
  await page.mouse.down();
  await page.mouse.move(stage.x + 380, stage.y + 170, { steps: 8 });
  await page.mouse.up();

  await page.click("#boardMoreToolsBtn");
  await page.locator('[data-board-tool="rectangle"]').click();
  await page.mouse.move(stage.x + 470, stage.y + 260);
  await page.mouse.down();
  await page.mouse.move(stage.x + 640, stage.y + 390, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(450);

  let active = await page.evaluate(() => window.BianDuRuntime.board.getActive());
  assert.ok(active.elements.some((item) => item.type === "stroke" && item.brush === "highlighter"));
  const rectangle = active.elements.find((item) => item.type === "rectangle");
  assert.ok(rectangle, "Shape tool should create a rectangle");
  const beforeX = rectangle.x;
  const beforeY = rectangle.y;

  await page.click('[data-board-tool="select"]');
  await page.mouse.move(stage.x + 555, stage.y + 325);
  await page.mouse.down();
  await page.mouse.move(stage.x + 605, stage.y + 355, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(450);
  active = await page.evaluate(() => window.BianDuRuntime.board.getActive());
  const moved = active.elements.find((item) => item.id === rectangle.id);
  assert.ok(moved.x > beforeX + 35 && moved.y > beforeY + 18, "Selected objects should move with the selection tool");
  assert.ok(await page.locator(".bd-selection-box").count() >= 1);

  await page.selectOption("#boardPaperStyle", "grid");
  await page.waitForTimeout(450);
  active = await page.evaluate(() => window.BianDuRuntime.board.getActive());
  assert.equal(active.paperStyle, "grid");
  assert.deepEqual(errors, [], `Page errors: ${errors.join(" | ")}`);
  console.log("Knowledge upload/task separation, graph search, board selection, shapes, highlighter and paper styles passed.");
} finally {
  await browser.close();
}
