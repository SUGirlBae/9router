import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PATCH_DIR = path.join(REPO_ROOT, "customizations", "patches");

function runWithDuplicateAnchor(scriptName, relativeFile, anchor) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "9router-patch-safety-"));
  try {
    const target = path.join(root, "app", ".next-cli-build", "server", "chunks", relativeFile);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${anchor}${anchor}`, "utf8");
    return spawnSync(
      process.execPath,
      [path.join(PATCH_DIR, scriptName), "--dry-run", "--root", root],
      { encoding: "utf8" },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("patch installer safety", () => {
  it("rejects duplicate model-power anchors", () => {
    const result = runWithDuplicateAnchor(
      "patch-9r-model-power.js",
      "24.js",
      '{pattern:"*gpt-oss*",caps:{reasoning:!0,thinkingFormat:"openai",contextWindow:128e3}}',
    );
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/expected exactly (one|1) match/);
  });

  it("rejects duplicate Antigravity shield anchors", () => {
    const result = runWithDuplicateAnchor(
      "patch-9r-antigravity-shield.js",
      "915.js",
      'd(`setx NODE_EXTRA_CA_CERTS "${a}"`',
    );
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/expected exactly (one|1) match/);
  });

  it("patches both declared quota header occurrences", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "9router-patch-safety-"));
    try {
      const target = path.join(root, "app", ".next-cli-build", "server", "chunks", "8416.js");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const anchor = '"X-Client-Name":"antigravity","X-Client-Version":e.Tr},body:JSON.stringify';
      fs.writeFileSync(target, `${anchor}${anchor}`, "utf8");
      const result = spawnSync(
        process.execPath,
        [path.join(PATCH_DIR, "patch-9r-antigravity-shield.js"), "--dry-run", "--root", root],
        { encoding: "utf8" },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Complete. Patched 1 operations across 1 files");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects duplicate orchestrator anchors", () => {
    const result = runWithDuplicateAnchor(
      "patch-9r-orchestrator.js",
      "238.js",
      ",j=c(7803);let k=Promise.resolve();",
    );
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/expected exactly (one|1) match/);
  });
});
