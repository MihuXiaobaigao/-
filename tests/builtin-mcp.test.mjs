import assert from "node:assert/strict";
import test from "node:test";

import { createBuiltinMcpHost } from "../src/web/builtin-mcp.js";

test("built-in MCP completes initialize, tools/list and tools/call", async () => {
  const host = createBuiltinMcpHost();
  host.registerTool({
    name: "knowledge.search",
    title: "Search",
    description: "Search private evidence.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    handler: async ({ query }) => ({ summary: `found:${query}`, results: [query] }),
  });

  const initialized = await host.rpc("initialize");
  assert.equal(initialized.result.serverInfo.name, "biandu-builtin-knowledge");
  assert.equal(initialized.result.protocolVersion, "2025-03-26");

  const listed = await host.rpc("tools/list");
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ["knowledge.search"]);

  const called = await host.rpc("tools/call", {
    name: "knowledge.search",
    arguments: { query: "attention" },
  });
  assert.equal(called.result.isError, false);
  assert.equal(called.result.structuredContent.summary, "found:attention");
  assert.deepEqual(host.status().calls.map((call) => call.name), ["knowledge.search"]);
});

test("built-in MCP returns an error result for unknown tools", async () => {
  const host = createBuiltinMcpHost();
  const called = await host.rpc("tools/call", { name: "missing.tool", arguments: {} });
  assert.equal(called.result.isError, true);
  assert.match(called.result.content[0].text, /未知的内置 MCP 工具/);
});
