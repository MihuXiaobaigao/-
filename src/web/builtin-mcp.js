const PROTOCOL_VERSION = "2025-03-26";

export class BuiltinMcpHost {
  constructor() {
    this.tools = new Map();
    this.nextRequestId = 1;
    this.callLog = [];
  }

  registerTool({ name, title, description, inputSchema, handler }) {
    if (!name || typeof handler !== "function") throw new Error("MCP 工具定义不完整。");
    this.tools.set(name, {
      name,
      title: title || name,
      description: description || "",
      inputSchema: inputSchema || { type: "object", properties: {} },
      handler,
    });
    return this;
  }

  listTools() {
    return [...this.tools.values()].map(({ name, title, description, inputSchema }) => ({
      name,
      title,
      description,
      inputSchema,
    }));
  }

  async callTool(name, args = {}) {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`未知的内置 MCP 工具：${name}`);
    this.callLog.push({ name, calledAt: new Date().toISOString() });
    if (this.callLog.length > 50) this.callLog.shift();
    return tool.handler(args);
  }

  status() {
    return {
      protocolVersion: PROTOCOL_VERSION,
      tools: this.listTools(),
      calls: [...this.callLog],
    };
  }

  async request(method, params = {}) {
    if (method === "initialize") {
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "biandu-builtin-knowledge", version: "1.0.0" },
      };
    }
    if (method === "notifications/initialized") return {};
    if (method === "ping") return {};
    if (method === "tools/list") return { tools: this.listTools() };
    if (method === "tools/call") {
      const name = String(params?.name || "");
      try {
        const structuredContent = await this.callTool(name, params?.arguments || {});
        return {
          content: [{ type: "text", text: structuredContent?.summary || `${name} 已执行。` }],
          structuredContent,
          isError: false,
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        };
      }
    }
    throw new Error(`不支持的 MCP 方法：${method}`);
  }

  async rpc(method, params = {}) {
    const id = this.nextRequestId++;
    const response = await this.request(method, params);
    return { jsonrpc: "2.0", id, result: response };
  }
}

export function createBuiltinMcpHost() {
  return new BuiltinMcpHost();
}
