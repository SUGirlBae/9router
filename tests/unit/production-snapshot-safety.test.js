import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SNAPSHOT_SCRIPT = path.join(REPO_ROOT, "scripts/create-production-snapshot.mjs");

describe("production snapshot safety", () => {
  it("fails closed instead of deleting an existing rollback or snapshot", () => {
    const source = fs.readFileSync(SNAPSHOT_SCRIPT, "utf8");

    expect(source).toContain("if (fs.existsSync(SNAPSHOT_DIR))");
    expect(source).toContain("if (fs.existsSync(LOCAL_BAK_DIR))");
    expect(source).not.toContain("fs.rmSync(LOCAL_BAK_DIR");
  });

  it("does not embed stale production process IDs in the manifest", () => {
    const source = fs.readFileSync(SNAPSHOT_SCRIPT, "utf8");

    expect(source).not.toMatch(/cliPid:\s*\d+/);
    expect(source).not.toMatch(/serverPid:\s*\d+/);
  });
});
