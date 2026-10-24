import assert from "node:assert/strict";
import { mkdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const baseUrl = process.env.BIANDU_BASE_URL || "http://127.0.0.1:4173";
const outputDir = resolve("output", "knowledge-agent-e2e");
await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
});

try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    hasTouch: true,
    acceptDownloads: true,
    serviceWorkers: "block",
  });
  await context.route("https://api.deepseek.com/chat/completions", async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } });
      return;
    }
    const payload = route.request().postDataJSON();
    const system = String(payload.messages?.find((message) => message.role === "system")?.content || "");
    const userText = String(payload.messages?.at(-1)?.content || "");
    let user;
    try { user = JSON.parse(userText); } catch { user = {}; }
    let content;
    if (system.includes("便读知识交付 Agent")) {
      if (user.targetFormat === "pptx") {
        content = JSON.stringify({
          title: "便读知识交付演示",
          subtitle: "基于私人知识库",
          summary: "DeepSeek Flash 负责问答，BGE-M3 负责语义检索。",
          slides: [
            { title: "默认模型", points: ["DeepSeek Flash 负责知识库问答"], citationIds: [user.evidence?.[0]?.id].filter(Boolean) },
            { title: "检索组件", points: ["BGE-M3 只负责语义向量检索"], citationIds: [user.evidence?.[0]?.id].filter(Boolean) },
          ],
          sourceLabels: ["便读模型说明"],
        });
      } else {
        content = JSON.stringify({
          title: "便读知识交付报告",
          subtitle: "基于私人知识库",
          summary: "DeepSeek Flash 是默认知识库问答模型。",
          sections: [{
            heading: "模型分工",
            paragraphs: ["DeepSeek Flash 负责知识库问答，BGE-M3 负责语义向量检索。"],
            citationIds: [user.evidence?.[0]?.id].filter(Boolean),
          }],
          sourceLabels: ["便读模型说明"],
        });
      }
    } else {
      const block = user.evidenceBlocks?.[0];
      const quote = String(block?.excerpt || "DeepSeek Flash 负责知识库问答。").slice(0, 18);
      content = JSON.stringify({
        answer: "DeepSeek Flash 是默认的知识库问答模型，BGE-M3 负责语义检索。",
        claims: [{ statement: "默认问答模型是 DeepSeek Flash。", evidenceIds: [block?.evidenceId].filter(Boolean) }],
        citations: [{ evidenceId: block?.evidenceId, quote }],
        insufficientEvidence: false,
        language: "zh-CN",
      });
    }
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
      body: JSON.stringify({ model: payload.model, choices: [{ message: { content } }] }),
    });
  });
  await context.route("https://api.siliconflow.cn/v1/embeddings", async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } });
      return;
    }
    const payload = route.request().postDataJSON();
    const texts = Array.isArray(payload.input) ? payload.input : [payload.input];
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
      body: JSON.stringify({
        model: payload.model,
        data: texts.map((text, index) => ({ index, embedding: [1, String(text).length % 7, 0.5, 0.25] })),
      }),
    });
  });
  let qwenRequests = 0;
  await context.route("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } });
      return;
    }
    qwenRequests += 1;
    assert.match(route.request().headers().authorization || "", /^Bearer sk-/);
    const payload = route.request().postDataJSON();
    const source = String(payload.messages?.at(-1)?.content || "");
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
      body: JSON.stringify({
        model: payload.model,
        choices: [{ message: { content: `译文：${source}` } }],
      }),
    });
  });

  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  const translated = await page.evaluate(async () => {
    const models = await import("./src/web/deepseek.js");
    return models.translateTextsWithSpecializedModel(["Attention is limited.", "Reading needs focus."]);
  });
  assert.deepEqual(translated, ["译文：Attention is limited.", "译文：Reading needs focus."]);
  assert.equal(qwenRequests, 2, "Qwen-MT must receive a usable decrypted key for every segment");
  await page.evaluate(async () => {
    const repository = await import("./src/web/repository.js");
    await repository.saveEvidence({
      id: "ev-agent-e2e",
      kind: "source-excerpt",
      sourceId: "agent-e2e-source",
      sourceTitle: "便读模型说明",
      page: 2,
      excerpt: "DeepSeek Flash 负责知识库问答，SiliconFlow BGE-M3 负责语义向量检索。",
      permanent: true,
    });
  });
  await page.locator('[data-nav="kb"]:visible').first().click();
  await page.waitForSelector(".kb-agent-page");
  assert.equal(await page.locator(".kb-agent-page select").count(), 0,
    "Knowledge page must not expose model selection");
  assert.equal(await page.locator("[data-kb-filter]").count(), 0,
    "Knowledge page should keep only the conversation agent surface");

  await page.fill("#realKbQuestion", "知识库默认使用哪个问答模型？");
  await page.press("#realKbQuestion", "Enter");
  await page.waitForSelector(".kb-chat-message.is-assistant");
  assert.match(await page.locator(".kb-chat-message.is-assistant").last().innerText(), /DeepSeek Flash/);
  assert.equal(await page.locator(".kb-agent-answer").count(), 0,
    "Knowledge answers should remain a plain conversation instead of a complex answer card");
  await page.fill("#realKbQuestion", "那 BGE-M3 负责什么？");
  await page.press("#realKbQuestion", "Enter");
  await page.waitForFunction(() => document.querySelectorAll(".kb-chat-message.is-user").length === 2 &&
    document.querySelectorAll(".kb-chat-message.is-assistant").length === 2);
  assert.match(await page.locator(".kb-chat-message.is-assistant").last().innerText(), /BGE-M3/);
  const mcpStatus = await page.evaluate(() => window.BianDuRuntime.pages.getMcpStatus());
  assert.deepEqual(mcpStatus.tools.map((tool) => tool.name), ["knowledge.answer", "artifact.create"]);
  assert.ok(mcpStatus.calls.some((call) => call.name === "knowledge.answer"));
  assert.equal(await page.locator("[data-kb-conversation-id]").count(), 1);

  await page.click("#realKbNewChatBtn");
  assert.equal(await page.locator(".kb-chat-message").count(), 0);
  await page.fill("#realKbQuestion", "新对话里再问一次：谁负责语义检索？");
  await page.press("#realKbQuestion", "Enter");
  await page.waitForFunction(() => document.querySelectorAll(".kb-chat-message.is-assistant").length === 1);
  assert.equal(await page.locator("[data-kb-conversation-id]").count(), 2);
  const conversationIds = await page.locator("[data-kb-conversation-id]").evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-kb-conversation-id")));
  await page.locator(`[data-kb-conversation-id="${conversationIds.at(-1)}"]`).click();
  await page.waitForFunction(() => document.querySelectorAll(".kb-chat-message.is-user").length === 2);
  await page.click("#realKbSidebarToggle");
  assert.equal(await page.locator(".kb-chat-sidebar.is-collapsed").count(), 1);
  await page.click("#realKbSidebarReopenBtn");
  assert.equal(await page.locator(".kb-chat-sidebar.is-collapsed").count(), 0);
  await page.click("#realKbNewChatBtn");

  await page.click('[data-kb-mode="task"]');
  await page.fill("#realKbQuestion", "知识库默认使用哪个问答模型？");
  await page.press("#realKbQuestion", "Enter");
  await page.waitForFunction(() => document.querySelectorAll(".kb-chat-message.is-assistant").length === 1);
  assert.equal(await page.locator("#realKbDownloadArtifact").count(), 0,
    "Task mode must not create a file when the user only asks a question");

  const downloaded = [];
  for (const task of ["pdf", "docx", "pptx"]) {
    await page.click('[data-kb-mode="task"]');
    await page.click("#realKbTaskMenuBtn");
    await page.click(`[data-kb-task="${task}"]`);
    await page.fill("#realKbQuestion", "把默认模型和检索组件的分工整理成简短成稿");
    const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
    await page.click("#realKbAskBtn");
    const download = await downloadPromise;
    const filename = download.suggestedFilename();
    assert.match(filename, new RegExp(`\\.${task}$`, "i"));
    const path = resolve(outputDir, filename);
    await download.saveAs(path);
    assert.ok((await stat(path)).size > 500);
    downloaded.push(filename);
  }
  const finalMcpStatus = await page.evaluate(() => window.BianDuRuntime.pages.getMcpStatus());
  assert.ok(finalMcpStatus.calls.some((call) => call.name === "artifact.create"),
    "Explicit file tasks must use the built-in MCP artifact tool");
  assert.equal(errors.length, 0, `Browser errors: ${errors.join(" | ")}`);
  console.log(`Knowledge agent passed: conversation, citations and ${downloaded.length} downloadable formats.`);
} finally {
  await browser.close();
}
