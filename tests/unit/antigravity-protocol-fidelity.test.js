import { describe, it, expect } from "vitest";
import { AntigravityExecutor } from "open-sse/executors/antigravity.js";
import { ANTIGRAVITY_IDE_VERSION, ANTIGRAVITY_IDE_USER_AGENT } from "open-sse/providers/shared.js";
import { CLIENT_METADATA } from "open-sse/config/appConstants.js";

describe("Antigravity Protocol Fidelity", () => {
  it("uses canonical 2.31.1 version and formatted User-Agent", () => {
    expect(ANTIGRAVITY_IDE_VERSION).toBe("2.31.1");
    expect(ANTIGRAVITY_IDE_USER_AGENT).toContain("antigravity/hub/2.31.1");
    expect(ANTIGRAVITY_IDE_USER_AGENT).toContain("cl=1012564305");
    expect(CLIENT_METADATA.ideVersion).toBe("2.31.1");
  });

  it("builds headers without X-Client-Version and with dynamic User-Agent", () => {
    const executor = new AntigravityExecutor();
    const headers = executor.buildHeaders({
      credentials: {
        accessToken: "ya29.test-token",
        email: "new_acc_d@gmail.com",
        id: "conn-acc-d-uuid"
      }
    });

    expect(headers["Authorization"]).toBe("Bearer ya29.test-token");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Client-Version"]).toBeUndefined();
    expect(headers["User-Agent"]).toContain("antigravity/hub/2.31.1");
    expect(headers["User-Agent"]).toContain("os_type=windows");
  });

  it("isolates sessionId and requestId per account even when client sends identical conversation identifiers", () => {
    const executor = new AntigravityExecutor();
    const sharedClientBody = {
      requestId: "agent/11111111-1111-1111-1111-111111111111/1700000000000/22222222-2222-2222-2222-222222222222/1",
      request: {
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
        sessionId: "-3750763034362895579"
      }
    };

    const outA = executor.transformRequest("gemini-3.8-flash", structuredClone(sharedClientBody), true, {
      projectId: "proj-a",
      email: "acc_a@gmail.com"
    });
    const outB = executor.transformRequest("gemini-3.8-flash", structuredClone(sharedClientBody), true, {
      projectId: "proj-b",
      email: "acc_b@gmail.com"
    });
    const outC = executor.transformRequest("gemini-3.8-flash", structuredClone(sharedClientBody), true, {
      projectId: "proj-c",
      email: "acc_c_new@gmail.com"
    });

    // Different accounts MUST receive completely isolated sessionId & conversationId
    expect(outA.request.sessionId).not.toBe(outB.request.sessionId);
    expect(outB.request.sessionId).not.toBe(outC.request.sessionId);
    expect(outA.requestId).not.toBe(outB.requestId);
    expect(outB.requestId).not.toBe(outC.requestId);

    // Same account across consecutive turns MUST preserve identical sessionId & conversationId for prompt caching
    const outA2 = executor.transformRequest("gemini-3.8-flash", structuredClone(sharedClientBody), true, {
      projectId: "proj-a",
      email: "acc_a@gmail.com"
    });
    expect(outA2.request.sessionId).toBe(outA.request.sessionId);
    expect(outA2.requestId.split("/")[1]).toBe(outA.requestId.split("/")[1]);
  });
});
