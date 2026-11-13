// Fixes Cloudflare Relay Worker automated upload in 9router:
// Replaces cross-realm FormData with an explicit Buffer multipart payload
// with a declared boundary, preventing Cloudflare API 10012:
// "Content-Type must be one of: application/javascript, text/javascript, multipart/form-data"
//
// Usage:
//   node patch-9r-cloudflare-deploy.js [--dry-run] [--revert]

const fs = require("fs");
const path = require("path");

const DRY_RUN = process.argv.includes("--dry-run");
const REVERT = process.argv.includes("--revert");

const BAK_EXT = ".pre-cfdeploy.bak";

const TARGETS = [
  // 1. Source repo
  {
    name: "Source route.js",
    path: path.resolve(__dirname, "../../src/app/api/proxy-pools/cloudflare-deploy/route.js"),
    marker: "----cfBoundary",
    patch: (content) => {
      const isCrlf = content.includes("\r\n");
      const eol = isCrlf ? "\r\n" : "\n";
      const needle = [
        '    // Cloudflare requires multipart/form-data for worker script upload',
        '    const formData = new FormData();',
        '    formData.append("index.js", new Blob([RELAY_WORKER_CODE], { type: "application/javascript+module" }), "index.js");',
        '    formData.append("metadata", new Blob([JSON.stringify({',
        '      main_module: "index.js",',
        '      compatibility_date: "2024-03-20",',
        '      observability: { enabled: true }',
        '    })], { type: "application/json" }), "metadata.json");',
        '',
        '    const uploadRes = await fetch(workerScriptUrl, {',
        '      method: "PUT",',
        '      headers: {',
        '        Authorization: `Bearer ${apiToken}`,',
        '      },',
        '      body: formData;',
        '    });'
      ].join(eol).replace("body: formData;", "body: formData,");

      const replacement = [
        '    // Cloudflare requires multipart/form-data for worker script upload.',
        '    // Use Buffer with explicit boundary to avoid cross-realm FormData serialization bugs in Node/Undici.',
        '    const boundary = `----cfBoundary${Date.now().toString(16)}`;',
        '    const metadataStr = JSON.stringify({',
        '      main_module: "index.js",',
        '      compatibility_date: "2024-03-20",',
        '      observability: { enabled: true }',
        '    });',
        '    const bodyBuffer = Buffer.from(',
        '      `--${boundary}\\r\\n` +',
        '      `Content-Disposition: form-data; name="metadata"; filename="metadata.json"\\r\\n` +',
        '      `Content-Type: application/json\\r\\n\\r\\n` +',
        '      `${metadataStr}\\r\\n` +',
        '      `--${boundary}\\r\\n` +',
        '      `Content-Disposition: form-data; name="index.js"; filename="index.js"\\r\\n` +',
        '      `Content-Type: application/javascript+module\\r\\n\\r\\n` +',
        '      `${RELAY_WORKER_CODE}\\r\\n` +',
        '      `--${boundary}--\\r\\n`',
        '    );',
        '',
        '    const uploadRes = await fetch(workerScriptUrl, {',
        '      method: "PUT",',
        '      headers: {',
        '        Authorization: `Bearer ${apiToken}`,',
        '        "Content-Type": `multipart/form-data; boundary=${boundary}`,',
        '      },',
        '      body: bodyBuffer,',
        '    });'
      ].join(eol);

      if (!content.includes(needle)) {
        throw new Error("Could not find needle in source route.js");
      }
      return content.replace(needle, replacement);
    }
  },
  // 2. Compiled standalone test instance in D:\9router\app
  {
    name: "Test build route.js",
    path: path.resolve(__dirname, "../../app/.next-cli-build/server/app/api/proxy-pools/cloudflare-deploy/route.js"),
    marker: "----cfBoundary",
    patch: (content) => {
      const needle = ',j=new FormData;j.append("index.js",new Blob([f],{type:"application/javascript+module"}),"index.js"),j.append("metadata",new Blob([JSON.stringify({main_module:"index.js",compatibility_date:"2024-03-20",observability:{enabled:!0}})],{type:"application/json"}),"metadata.json");let k=await fetch(i,{method:"PUT",headers:{Authorization:`Bearer ${g}`},body:j});';
      const replacement = ';let B="----cfBoundary"+Date.now().toString(16),M=JSON.stringify({main_module:"index.js",compatibility_date:"2024-03-20",observability:{enabled:!0}}),j=Buffer.from(`--${B}\\r\\nContent-Disposition: form-data; name="metadata"; filename="metadata.json"\\r\\nContent-Type: application/json\\r\\n\\r\\n${M}\\r\\n--${B}\\r\\nContent-Disposition: form-data; name="index.js"; filename="index.js"\\r\\nContent-Type: application/javascript+module\\r\\n\\r\\n${f}\\r\\n--${B}--\\r\\n`);let k=await fetch(i,{method:"PUT",headers:{Authorization:`Bearer ${g}`,"Content-Type":`multipart/form-data; boundary=${B}`},body:j});';
      if (!content.includes(needle)) {
        throw new Error("Could not find needle in compiled test route.js");
      }
      return content.replace(needle, replacement);
    }
  },
  // 3. Compiled production instance on port 20128
  {
    name: "Production build route.js",
    path: "C:/Users/Administrator/AppData/Roaming/npm/node_modules/9router/app/.next-cli-build/server/app/api/proxy-pools/cloudflare-deploy/route.js",
    marker: "----cfBoundary",
    patch: (content) => {
      const needle = ',j=new FormData;j.append("index.js",new Blob([f],{type:"application/javascript+module"}),"index.js"),j.append("metadata",new Blob([JSON.stringify({main_module:"index.js",compatibility_date:"2024-03-20",observability:{enabled:!0}})],{type:"application/json"}),"metadata.json");let k=await fetch(i,{method:"PUT",headers:{Authorization:`Bearer ${g}`},body:j});';
      const replacement = ';let B="----cfBoundary"+Date.now().toString(16),M=JSON.stringify({main_module:"index.js",compatibility_date:"2024-03-20",observability:{enabled:!0}}),j=Buffer.from(`--${B}\\r\\nContent-Disposition: form-data; name="metadata"; filename="metadata.json"\\r\\nContent-Type: application/json\\r\\n\\r\\n${M}\\r\\n--${B}\\r\\nContent-Disposition: form-data; name="index.js"; filename="index.js"\\r\\nContent-Type: application/javascript+module\\r\\n\\r\\n${f}\\r\\n--${B}--\\r\\n`);let k=await fetch(i,{method:"PUT",headers:{Authorization:`Bearer ${g}`,"Content-Type":`multipart/form-data; boundary=${B}`},body:j});';
      if (!content.includes(needle)) {
        throw new Error("Could not find needle in compiled prod route.js");
      }
      return content.replace(needle, replacement);
    }
  }
];

if (REVERT) {
  console.log("Reverting cloudflare-deploy patches...");
  for (const t of TARGETS) {
    const bak = t.path + BAK_EXT;
    if (fs.existsSync(bak)) {
      fs.copyFileSync(bak, t.path);
      fs.unlinkSync(bak);
      console.log(`[RESTORED] ${t.name}: ${t.path}`);
    }
  }
  process.exit(0);
}

console.log("Applying Cloudflare Deploy multipart patch...");
console.log(`Dry run: ${DRY_RUN}`);

let total = 0;
for (const t of TARGETS) {
  if (!fs.existsSync(t.path)) {
    console.log(`[SKIP] File not found: ${t.path}`);
    continue;
  }
  const content = fs.readFileSync(t.path, "utf8");
  if (content.includes(t.marker)) {
    console.log(`[ALREADY] ${t.name}`);
    continue;
  }
  try {
    const newContent = t.patch(content);
    if (!DRY_RUN) {
      const bak = t.path + BAK_EXT;
      if (!fs.existsSync(bak)) fs.copyFileSync(t.path, bak);
      fs.writeFileSync(t.path, newContent, "utf8");
      console.log(`[PATCHED] ${t.name}: ${t.path}`);
      total++;
    } else {
      console.log(`[WOULD PATCH] ${t.name}: ${t.path}`);
      total++;
    }
  } catch (err) {
    console.error(`[ERROR] ${t.name}: ${err.message}`);
    process.exit(1);
  }
}

console.log(`\nFinished. Patched ${total} locations.`);
