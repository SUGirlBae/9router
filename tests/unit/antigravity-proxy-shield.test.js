import { describe, it, expect } from "vitest";
import { refreshGoogleToken } from "open-sse/services/tokenRefresh/providers.js";
import { getAntigravityDeviceProfile } from "open-sse/services/antigravityDevice.js";

describe("Antigravity Proxy & Dynamic Anti-Abuse Shield", () => {
  it("exports proxyAware refreshGoogleToken function", () => {
    expect(typeof refreshGoogleToken).toBe("function");
  });

  it("dynamically generates isolated device profile for new accounts without hardcoding", () => {
    const acc1 = "acc1_test@gmail.com";
    const acc2 = "acc2_test@gmail.com";
    const acc3 = "acc3_brand_new_account@gmail.com";

    const p1 = getAntigravityDeviceProfile(acc1);
    const p2 = getAntigravityDeviceProfile(acc2);
    const p3 = getAntigravityDeviceProfile(acc3);

    expect(p1.machineId).not.toBe(p2.machineId);
    expect(p2.machineId).not.toBe(p3.machineId);
    expect(p1.machineId).not.toBe(p3.machineId);

    // Each profile has unique UUIDs
    expect(p1.sqmId).not.toBe(p2.sqmId);
    expect(p2.sqmId).not.toBe(p3.sqmId);
    expect(p1.devDeviceId).not.toBe(p2.devDeviceId);
    expect(p2.devDeviceId).not.toBe(p3.devDeviceId);

    // All profiles simulate authentic Google 2.31.1 client parameters
    expect(p3.userAgent).toContain("antigravity/hub/2.31.1");
    expect(p3.userAgent).toContain("cl=1012564305");
    expect(p3.clientMetadata.ideType).toBe(9);
    expect(p3.clientMetadata.platform).toBe(5);
    expect(p3.clientMetadata.pluginType).toBe(2);
    expect(p3.clientMetadata.ideName).toBe("antigravity");
  });
});
