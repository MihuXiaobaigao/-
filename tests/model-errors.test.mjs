import assert from "node:assert/strict";
import test from "node:test";

import { describeModelHttpError, postModelRequest } from "../src/web/deepseek.js";

const profile = { label: "主力模型" };

test("expired or invalid API keys are explained with recovery steps", () => {
  const error = describeModelHttpError(profile, 401, "Authentication Fails");
  assert.match(error.message, /API Key 无效、已过期或被撤销/);
  assert.match(error.message, /HTTP 401/);
  assert.match(error.message, /重新填写/);
  assert.doesNotMatch(error.message, /Authentication Fails/);
  assert.equal(error.providerDetail, "Authentication Fails");
});

test("billing and quota failures are distinguished from rate limiting", () => {
  const billing = describeModelHttpError(profile, 402, "Insufficient Balance");
  assert.match(billing.message, /账户余额不足/);
  assert.match(billing.message, /充值/);
  const quota = describeModelHttpError(profile, 429, "quota exhausted");
  assert.match(quota.message, /(?:账户|免费)额度已经耗尽/);
  const rateLimit = describeModelHttpError(profile, 429, "rate limited");
  assert.match(rateLimit.message, /请求太频繁|限流/);
  assert.doesNotMatch(rateLimit.message, /账户额度已经耗尽/);
});

test("wrong endpoints and model IDs are named explicitly", () => {
  const endpoint = describeModelHttpError(profile, 404, "Not Found");
  assert.match(endpoint.message, /接口地址或模型 ID 不正确/);
  const model = describeModelHttpError(profile, 400, "Model Not Exist");
  assert.match(model.message, /模型 ID 或请求参数不正确/);
});

test("provider outages remain actionable", () => {
  const error = describeModelHttpError(profile, 503, "Service Unavailable");
  assert.match(error.message, /模型服务商暂时故障/);
  assert.match(error.message, /HTTP 503/);
  assert.match(error.message, /稍后重试/);
});

test("native Android transport bypasses WebView CORS for model requests", async () => {
  let payload;
  globalThis.Capacitor = {
    Plugins: {
      BianduNetwork: {
        async postJson(input) {
          payload = input;
          return {
            status: 200,
            body: '{"ok":true}',
            headers: { "retry-after": "1" },
          };
        },
      },
    },
  };
  try {
    const response = await postModelRequest({
      url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      headers: {
        Authorization: "Bearer test",
        "Content-Type": "application/json",
      },
      body: '{"model":"qwen-mt-plus"}',
      timeoutMs: 30_000,
    });
    assert.equal(payload.url, "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '{"ok":true}');
    assert.equal(response.headers.get("Retry-After"), "1");
  } finally {
    delete globalThis.Capacitor;
  }
});

test("aborting a native model request disconnects the active Android request", async () => {
  let cancelledId = "";
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  globalThis.Capacitor = {
    Plugins: {
      BianduNetwork: {
        async postJson(input) {
          await pending;
          return { status: 499, body: "", headers: {} };
        },
        async cancel({ requestId }) {
          cancelledId = requestId;
          release();
        },
      },
    },
  };
  const controller = new AbortController();
  try {
    const request = postModelRequest({
      url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      headers: { Authorization: "Bearer test" },
      body: "{}",
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(request, (error) => error.name === "AbortError" && error.cancelled === true);
    assert.ok(cancelledId);
  } finally {
    delete globalThis.Capacitor;
  }
});
