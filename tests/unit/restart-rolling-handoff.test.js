import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(REPO_ROOT, "customizations", "runtime", "restart-rolling.ps1");

describe("rolling gateway versioned handoff", () => {
  it("accepts and validates independent slot server paths", () => {
    const source = fs.readFileSync(SCRIPT, "utf8");

    expect(source).toContain("[string]$SlotServerPathA");
    expect(source).toContain("[string]$SlotServerPathB");
    expect(source).toContain("Test-Path $SlotServerPathA");
    expect(source).toContain("Test-Path $SlotServerPathB");
    expect(source).toContain("$env:SLOT_SERVER_PATH_A");
    expect(source).toContain("$env:SLOT_SERVER_PATH_B");
  });

  it("keeps hot reload conditional on no versioned paths", () => {
    const source = fs.readFileSync(SCRIPT, "utf8");

    expect(source).toContain("if ($isGateway -and -not $hasVersionedPaths)");
  });
});
