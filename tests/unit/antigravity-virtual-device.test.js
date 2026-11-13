import { describe, it, expect } from "vitest";
import { getAntigravityDeviceProfile } from "open-sse/services/antigravityDevice.js";

describe("Antigravity Dynamic Virtual Device Profile Engine", () => {
  it("generates deterministic and unique profiles for distinct accounts", () => {
    const profileA = getAntigravityDeviceProfile("account_a@gmail.com");
    const profileB = getAntigravityDeviceProfile("account_b@gmail.com");
    const profileA2 = getAntigravityDeviceProfile("account_a@gmail.com");

    expect(profileA.machineId).toHaveLength(64);
    expect(profileB.machineId).toHaveLength(64);
    expect(profileA.machineId).not.toBe(profileB.machineId);
    expect(profileA.machineId).toBe(profileA2.machineId);

    expect(profileA.sqmId).toMatch(/^\{[0-9A-F-]{36}\}$/);
    expect(profileB.sqmId).toMatch(/^\{[0-9A-F-]{36}\}$/);
    expect(profileA.sqmId).not.toBe(profileB.sqmId);

    expect(profileA.devDeviceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(profileB.devDeviceId).not.toBe(profileA.devDeviceId);
  });

  it("automatically generates valid profiles for newly added arbitrary accounts without hardcoding", () => {
    const randomAccC = "random_new_account_" + Date.now() + "@domain.com";
    const profileC = getAntigravityDeviceProfile(randomAccC);

    expect(profileC.machineId).toBeDefined();
    expect(profileC.machineId).toHaveLength(64);
    expect(profileC.userAgent).toContain("antigravity/hub/2.31.1");
    expect(profileC.userAgent).toContain("cl=1012564305");
    expect(profileC.userAgent).toContain("os_type=windows");
    expect(profileC.userAgent).toContain("arch=amd64");
    expect(profileC.userAgent).toContain("auth_method=oauth");
    expect(profileC.userAgent).toContain("datacollection_opt_in=false");
    expect(profileC.clientMetadata).toEqual({
      ideType: 9,
      ideVersion: "2.31.1",
      pluginVersion: "2.31.1",
      platform: 5,
      pluginType: 2,
      ideName: "antigravity"
    });
  });

  it("handles null or missing connectionId safely with stable fallback", () => {
    const fallbackProfile = getAntigravityDeviceProfile(null);
    expect(fallbackProfile.machineId).toBeDefined();
    expect(fallbackProfile.machineId).toHaveLength(64);
    expect(fallbackProfile.userAgent).toContain("antigravity/hub/2.31.1");
  });
});
