// Adds QoDuck (lmodel) with 1M context window and thinking effort (low/high/extra high) support to 9router.
// Usage: node patch-9r-qoduck.js [--dry-run] [--revert]
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = "C:/Users/Administrator/AppData/Roaming/npm/node_modules/9router";
const BUILD_SERVER = path.join(ROOT, "app/.next-cli-build/server");
const BUILD_STATIC = path.join(ROOT, "app/.next-cli-build/static");
const DRY_RUN = process.argv.includes("--dry-run");
const REVERT = process.argv.includes("--revert");

if (REVERT) {
  console.log("Reverting files from .pre-qoduck.bak...");
  for (const dir of [BUILD_SERVER, BUILD_STATIC]) {
    function scan(d) {
      if (!fs.existsSync(d)) return;
      for (const f of fs.readdirSync(d)) {
        const p = path.join(d, f);
        if (fs.statSync(p).isDirectory()) scan(p);
        else if (f.endsWith(".pre-qoduck.bak")) {
          const orig = p.slice(0, -15);
          fs.copyFileSync(p, orig);
          console.log(`[RESTORED] ${orig}`);
        }
      }
    }
    scan(dir);
  }
  process.exit(0);
}

let patchedCount = 0;

function patch(filePath, marker, needle, replacement) {
  if (!fs.existsSync(filePath)) {
    console.log(`[SKIP] Missing file: ${filePath}`);
    return;
  }
  let s = fs.readFileSync(filePath, "utf8");
  if (s.includes(marker)) {
    console.log(`[OK] Already patched: ${path.basename(filePath)} (${marker.slice(0, 30)})`);
    return;
  }
  const occurrences = s.split(needle).length - 1;
  if (occurrences !== 1) {
    throw new Error(`Expected 1 occurrence in ${path.basename(filePath)}, found ${occurrences} for marker: ${marker}`);
  }
  if (!DRY_RUN) {
    const bak = filePath + ".pre-qoduck.bak";
    if (!fs.existsSync(bak)) fs.writeFileSync(bak, s);
    fs.writeFileSync(filePath, s.replace(needle, replacement));
  }
  console.log(`[PATCHED] ${path.basename(filePath)} (${DRY_RUN ? "dry-run" : "applied"})`);
  patchedCount++;
}

// 1. Static model config catalog in 3225.js (module 69704)
const OLD_3225_E = 'E=Object.freeze({smodel:Object.freeze({...D,key:"smodel",display_name:"Sonus",is_vl:!0,is_reasoning:!0,max_input_tokens:18e4}),cmodel:Object.freeze({...D,key:"cmodel",display_name:"Cantus",is_vl:!0,is_reasoning:!0,max_input_tokens:18e4})});';
const NEW_3225_E = 'E=Object.freeze({smodel:Object.freeze({...D,key:"smodel",display_name:"Sonus",is_vl:!0,is_reasoning:!0,max_input_tokens:18e4}),cmodel:Object.freeze({...D,key:"cmodel",display_name:"Cantus",is_vl:!0,is_reasoning:!0,max_input_tokens:18e4}),lmodel:Object.freeze({...D,key:"lmodel",display_name:"QoDuck",is_vl:!0,is_reasoning:!0,max_input_tokens:1e6,context_config:Object.freeze([Object.freeze({name:"1M",tokenCount:1e6,isDefault:!0})])}),qoduck:Object.freeze({...D,key:"lmodel",display_name:"QoDuck",is_vl:!0,is_reasoning:!0,max_input_tokens:1e6,context_config:Object.freeze([Object.freeze({name:"1M",tokenCount:1e6,isDefault:!0})])})});';
patch(path.join(BUILD_SERVER, "chunks/3225.js"), 'display_name:"QoDuck"', OLD_3225_E, NEW_3225_E);

// Fallback injection in 3225.js p() so connection models endpoint lists lmodel with 1M context
const OLD_3225_P = 'description:a.description||""})}return{models:r,rawConfigs:s}}';
const NEW_3225_P = 'description:a.description||""})}for(let[k,cfg]of Object.entries(g.Xx)){if(!s.has(k)){s.set(k,cfg);r.push({id:k,name:cfg.display_name||k,contextLength:Number(cfg.max_input_tokens)||1e6,isVL:!!cfg.is_vl,isReasoning:!!cfg.is_reasoning,maxOutputTokens:65536,description:""});}}return{models:r,rawConfigs:s}}';
patch(path.join(BUILD_SERVER, "chunks/3225.js"), 'for(let[k,cfg]of Object.entries(g.Xx))', OLD_3225_P, NEW_3225_P);

// 2. Provider capabilities (24.js, 412.js, 8402.js)
const OLD_CAPS = "smodel:{vision:!0,reasoning:!0,contextWindow:18e4,maxOutput:65536},cmodel:{vision:!0,reasoning:!0,contextWindow:18e4,maxOutput:65536}}";
const NEW_CAPS = "smodel:{vision:!0,reasoning:!0,contextWindow:18e4,maxOutput:65536},cmodel:{vision:!0,reasoning:!0,contextWindow:18e4,maxOutput:65536},lmodel:{vision:!0,reasoning:!0,thinkingFormat:\"openai\",thinkingEffortSupported:!0,contextWindow:1e6,maxOutput:65536},qoduck:{vision:!0,reasoning:!0,thinkingFormat:\"openai\",thinkingEffortSupported:!0,contextWindow:1e6,maxOutput:65536}}";
for (const f of ["chunks/24.js", "chunks/412.js", "chunks/8402.js"]) {
  patch(path.join(BUILD_SERVER, f), 'qoduck:{vision:!0,reasoning:!0', OLD_CAPS, NEW_CAPS);
}

// 3. Provider model catalog (2598.js, 4480.js, 8499.js)
const OLD_MODELS = '{id:"smodel",name:"Sonus"},{id:"cmodel",name:"Cantus"}';
const NEW_MODELS = '{id:"smodel",name:"Sonus"},{id:"cmodel",name:"Cantus"},{id:"lmodel",name:"QoDuck"},{id:"qoduck",name:"QoDuck"}';
for (const f of ["chunks/2598.js", "chunks/4480.js", "chunks/8499.js"]) {
  patch(path.join(BUILD_SERVER, f), '{id:"qoduck",name:"QoDuck"}', OLD_MODELS, NEW_MODELS);
}

// 4. Static UI chunks (1321-*.js, 5497-*.js)
patch(path.join(BUILD_STATIC, "chunks/1321-02944667ec55f586.js"), '{id:"qoduck",name:"QoDuck"}', OLD_MODELS, NEW_MODELS);
patch(path.join(BUILD_STATIC, "chunks/5497-870732fd9d818574.js"), 'qoduck:{vision:!0,reasoning:!0', OLD_CAPS, NEW_CAPS);

// 5. Model routing, normalization & effort forwarding in 5330.js
const OLD_ROUTE = String.raw`var k,l;let q=String(a||"").replace(/^qoder\//,"").replace(/(?:\([^)]*\)|\[[^\]]*\])+$/,""),r=await (0,n.X5)(c,q,{log:d,proxyOptions:e,signal:h`;
const NEW_ROUTE = String.raw`var k,l;let _effM=String(a||"").match(/\(([^)]+)\)/),_rawEff=b?.reasoning_effort||b?.reasoning?.effort||(_effM?_effM[1]:null),_effNorm=null;if(_rawEff){let _effStr=String(_rawEff).toLowerCase().replace(/[\s_-]+/g,"");_effNorm=("extrahigh"===_effStr||"xhigh"===_effStr||"max"===_effStr)?"xhigh":("high"===_effStr)?"high":("low"===_effStr)?"low":("medium"===_effStr||"med"===_effStr)?"medium":_effStr}let q=String(a||"").replace(/^qoder\//,"").replace(/(?:\([^)]*\)|\[[^\]]*\])+$/,"");q=q.replace(/^qd\//,"");q.toLowerCase()==="qoduck"&&(q="lmodel");let r=await (0,n.X5)(c,q,{log:d,proxyOptions:e,signal:h`;
patch(path.join(BUILD_SERVER, "chunks/5330.js"), 'q=q.replace(/^qd\\//,"")', OLD_ROUTE, NEW_ROUTE);

const OLD_PARAM = 'parameters:{max_tokens:y},chat_context:{chatPrompt:"",imageUrls:null,extra:{context:[],modelConfig:{key:q,is_reasoning:w},originalContent:z}';
const NEW_PARAM = 'parameters:{max_tokens:y,...(_effNorm?{reasoning_effort:_effNorm,enable_thinking:_effNorm!=="none"}:{}),...(q==="lmodel"?{context_length:1e6}:{})},chat_context:{chatPrompt:"",imageUrls:null,extra:{context:[],modelConfig:{key:q,is_reasoning:(_effNorm==="none"?!1:w),...(_effNorm?{reasoning_effort:_effNorm}:{})},ideModelConfigOverride:{...(q==="lmodel"?{max_input_tokens:1e6}:{})},originalContent:z}';
patch(path.join(BUILD_SERVER, "chunks/5330.js"), 'context_length:1e6', OLD_PARAM, NEW_PARAM);

// Syntax check
if (!DRY_RUN) {
  for (const f of ["chunks/3225.js", "chunks/24.js", "chunks/412.js", "chunks/8402.js", "chunks/2598.js", "chunks/4480.js", "chunks/8499.js", "chunks/5330.js"]) {
    const full = path.join(BUILD_SERVER, f);
    if (fs.existsSync(full)) {
      execFileSync(process.execPath, ["--check", full], { stdio: "pipe" });
    }
  }
  console.log("\nAll server chunks pass syntax check (node --check)");
}

console.log(`\nDone. Patched ${patchedCount} files.`);
