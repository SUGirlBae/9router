import { describe, expect, it } from "vitest";
import { ZeroDowntimeGateway } from "../../customizations/gateway/9r-zero-downtime-gateway.js";

describe("ZeroDowntimeGateway versioned slot paths", () => {
  it("keeps independent server paths for blue and green slots", () => {
    const gateway = new ZeroDowntimeGateway({
      serverPath: "default-server.js",
      slotServerPathA: "blue/server.js",
      slotServerPathB: "green/server.js",
    });

    expect(gateway.getServerPathForSlot("A")).toBe("blue/server.js");
    expect(gateway.getServerPathForSlot("B")).toBe("green/server.js");
    expect(gateway.getStatus()).toMatchObject({
      serverPathA: "blue/server.js",
      serverPathB: "green/server.js",
    });
  });
});
