import { describe, it, expect } from "vitest";
import { isTelemetrySinkhole, handleTelemetrySinkhole } from "@/mitm/telemetrySinkhole.js";

describe("MITM Telemetry Sinkhole", () => {
  it("correctly identifies all telemetry and analytics endpoints", () => {
    expect(isTelemetrySinkhole("/v1internal:recordCodeAssistMetrics")).toBe(true);
    expect(isTelemetrySinkhole("/v1internal:recordTrajectoryAnalytics")).toBe(true);
    expect(isTelemetrySinkhole("/v1internal:fetchAdminControls")).toBe(true);
    expect(isTelemetrySinkhole("/v1internal:listExperiments")).toBe(true);
    expect(isTelemetrySinkhole("https://play.googleapis.com/log")).toBe(true);
    expect(isTelemetrySinkhole("/log", "play.googleapis.com")).toBe(true);
    expect(isTelemetrySinkhole("/v1/feedback/products/5398468/web:submit", "feedback-pa.googleapis.com")).toBe(true);
    expect(isTelemetrySinkhole("https://feedback-pa.googleapis.com/v1/feedback")).toBe(true);

    // Chat and models must NEVER be sinkholed
    expect(isTelemetrySinkhole("/v1internal:streamGenerateContent?alt=sse")).toBe(false);
    expect(isTelemetrySinkhole("/v1internal:generateContent")).toBe(false);
    expect(isTelemetrySinkhole("/v1internal:loadCodeAssist")).toBe(false);
    expect(isTelemetrySinkhole("/v1internal:fetchAvailableModels")).toBe(false);
  });

  it("generates synthetic 200 response without network traffic", () => {
    let statusCode = 0;
    let headers = {};
    let responseBody = "";

    const mockRes = {
      writeHead(code, h) { statusCode = code; headers = h; },
      end(data) { responseBody = data; }
    };

    handleTelemetrySinkhole({ url: "/v1internal:recordCodeAssistMetrics" }, mockRes);
    expect(statusCode).toBe(200);
    expect(headers["Content-Type"]).toBe("application/json");
    const json = JSON.parse(responseBody);
    expect(json.status).toBe("OK");
  });
});
