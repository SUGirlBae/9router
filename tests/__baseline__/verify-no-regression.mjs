// Gate: so kết quả test hiện tại với baseline known-fails.
// PASS nếu KHÔNG có test nào pass(baseline) → fail(now). Test mới được phép.
// Usage: node tests/__baseline__/verify-no-regression.mjs <current-results.json>
import { readFileSync } from "fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const normalizePath = (value) => path.relative(REPO_ROOT, value).replaceAll(path.sep, "/");

const knownFails = new Set(
  readFileSync(new URL("./known-fails.txt", import.meta.url), "utf8")
    .split("\n").map(s => s.trim()).filter(Boolean)
);

const resultsPath = process.argv[2];
if (!resultsPath) { console.error("Missing results.json path"); process.exit(2); }

const r = JSON.parse(readFileSync(resultsPath, "utf8"));
const nowFails = r.testResults.flatMap(f => {
  const file = normalizePath(f.name || f.testFilePath || "");
  const assertionFailures = (f.assertionResults || [])
    .filter(a => a.status === "failed")
    .map(a => `${file} :: ${a.fullName}`);
  // Vitest uses an empty assertionResults array for collection/import failures.
  // Preserve the existing known-fails convention for those suite-level failures.
  return assertionFailures.length > 0
    ? assertionFailures
    : (f.status === "failed" && f.message ? [`${file} :: <suite failed to load>`] : []);
});

// Regression = fail bây giờ NHƯNG không có trong baseline known-fails
const regressions = nowFails.filter(f => !knownFails.has(f));

if (regressions.length) {
  console.error(`\n❌ REGRESSION: ${regressions.length} test pass→fail:\n`);
  regressions.forEach(f => console.error("  - " + f));
  process.exit(1);
}
console.log(`✅ No regression. (now fails=${nowFails.length}, baseline known=${knownFails.size}, all known)`);
