// Idempotent patch installer for 9router 0.5.116 bundle:
// Unleashes model capabilities across Antigravity (Gemini 4, Gemini 3.8x, Claude, Image Gen, Search)
// and OpenAI Codex models.
//
// Usage: node patch-9r-model-power.js [--apply] [--dry-run] [--revert] [--root <dir>]

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const DRY_RUN = process.argv.includes("--dry-run");
const REVERT = process.argv.includes("--revert");

function getArg(name, def) {
  const idx = process.argv.indexOf(name);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : def;
}

const DEFAULT_ROOT = fs.existsSync("D:/9router/app/.next-cli-build")
  ? "D:/9router"
  : "C:/Users/Administrator/AppData/Roaming/npm/node_modules/9router";

const ROOT = getArg("--root", DEFAULT_ROOT);
const BUILD_SERVER = path.join(ROOT, "app/.next-cli-build/server");
const BUILD_STATIC = path.join(ROOT, "app/.next-cli-build/static");

console.log(`[patch-9r-model-power] Root: ${ROOT}`);
console.log(`[patch-9r-model-power] Mode: ${REVERT ? "REVERT" : DRY_RUN ? "DRY-RUN" : "APPLY"}`);

if (REVERT) {
  console.log("Reverting files from .pre-modelpower.bak...");
  for (const dir of [BUILD_SERVER, BUILD_STATIC]) {
    function scan(d) {
      if (!fs.existsSync(d)) return;
      for (const f of fs.readdirSync(d)) {
        const p = path.join(d, f);
        if (fs.statSync(p).isDirectory()) scan(p);
        else if (f.endsWith(".pre-modelpower.bak")) {
          const orig = p.slice(0, -".pre-modelpower.bak".length);
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
const patchedFiles = new Set();

function countMatches(source, needle) {
  if (needle instanceof RegExp) {
    const flags = needle.flags.includes("g") ? needle.flags : `${needle.flags}g`;
    return [...source.matchAll(new RegExp(needle.source, flags))].length;
  }
  return source.split(needle).length - 1;
}

function patchFile(filePath, marker, needle, replacement) {
  if (!fs.existsSync(filePath)) return;
  let s = fs.readFileSync(filePath, "utf8");
  if (s.includes(marker)) return;

  const matches = countMatches(s, needle);
  if (matches === 0) return;
  if (matches !== 1) throw new Error(`expected exactly one match for ${marker}, found ${matches} in ${filePath}`);

  let next;
  if (needle instanceof RegExp) {
    next = s.replace(needle, replacement);
  } else {
    next = s.replace(needle, replacement);
  }
  if (next === s) return;

  if (!DRY_RUN) {
    const bak = filePath + ".pre-modelpower.bak";
    if (!fs.existsSync(bak)) fs.writeFileSync(bak, s);
    fs.writeFileSync(filePath, next);
  }
  console.log(`[PATCHED] ${path.relative(ROOT, filePath)} (${marker.slice(0, 36)})`);
  patchedCount++;
  patchedFiles.add(filePath);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. CAPABILITIES: PDF support for Gemini 4/3.8/3.7/3.6/3.1, claude-opus-4-6-thinking,
//    gemini-pro-agent exact reasoning, gpt-6.1-sol[1m], gpt-6.1-terra[1m], gpt-oss-120b
// ─────────────────────────────────────────────────────────────────────────────

const OLD_FABLE_CAPS = '"claude-fable-5-1":{vision:!0,pdf:!0,reasoning:!0,search:!0,thinkingFormat:"claude-adaptive",thinkingCanDisable:!1,contextWindow:1e6,maxOutput:128e3},';
const NEW_FABLE_CAPS = '"claude-fable-5-1":{vision:!0,pdf:!0,reasoning:!0,search:!0,thinkingFormat:"claude-adaptive",thinkingCanDisable:!1,contextWindow:1e6,maxOutput:128e3},"claude-opus-4-6-thinking":{vision:!0,pdf:!0,reasoning:!0,search:!0,thinkingFormat:"claude-adaptive",contextWindow:1e6,maxOutput:128e3},"gemini-pro-agent":{vision:!0,audioInput:!0,videoInput:!0,pdf:!0,reasoning:!0,search:!0,thinkingFormat:"gemini-level",contextWindow:1048576,maxOutput:65536},';

const CODEX_1M_RE = /("gpt-6-luna\[1m\]":([a-zA-Z0-9_$]+),"gpt-5\.6-sol\[1m\]":\2,)/;
const CODEX_1M_REPL = (_, _full, v) => `"gpt-6-luna[1m]":${v},"gpt-6.1-sol[1m]":${v},"gpt-6.1-terra[1m]":${v},"gpt-5.6-sol[1m]":${v},`;

const OLD_GEMINI_PATTERNS = '{pattern:"*gemini-4*",caps:{vision:!0,audioInput:!0,videoInput:!0,reasoning:!0,search:!0,thinkingFormat:"gemini-level",thinkingCanDisable:!1,contextWindow:1048576,maxOutput:65536}},{pattern:"*gemini-3.8*",caps:{vision:!0,audioInput:!0,videoInput:!0,reasoning:!0,search:!0,thinkingFormat:"gemini-level",thinkingCanDisable:!1,contextWindow:1048576,maxOutput:65536}},{pattern:"*gemini-3.7*",caps:{vision:!0,audioInput:!0,videoInput:!0,reasoning:!0,search:!0,thinkingFormat:"gemini-level",thinkingCanDisable:!1,contextWindow:1048576,maxOutput:65536}},{pattern:"*gemini-3*pro*",caps:{vision:!0,audioInput:!0,videoInput:!0,reasoning:!0,search:!0,thinkingFormat:"gemini-level",thinkingCanDisable:!1,contextWindow:1048576,maxOutput:65535}},{pattern:"*gemini-3*",caps:{vision:!0,audioInput:!0,videoInput:!0,reasoning:!0,search:!0,thinkingFormat:"gemini-level",thinkingCanDisable:!1,contextWindow:1048576,maxOutput:65536}},{pattern:"*gemini-2.5*",caps:{vision:!0,audioInput:!0,videoInput:!0,reasoning:!0,search:!0,thinkingFormat:"gemini-budget",thinkingRange:{min:0,max:24576},contextWindow:1048576,maxOutput:65536}},{pattern:"*gemini-2*",caps:{vision:!0,audioInput:!0,videoInput:!0,search:!0,contextWindow:1048576,maxOutput:65536}},{pattern:"*gemini*",caps:{vision:!0,search:!0,contextWindow:1048576}}';
const NEW_GEMINI_PATTERNS = '{pattern:"*gemini-4*",caps:{vision:!0,audioInput:!0,videoInput:!0,pdf:!0,reasoning:!0,search:!0,thinkingFormat:"gemini-level",thinkingCanDisable:!1,contextWindow:1048576,maxOutput:65536}},{pattern:"*gemini-3.8*",caps:{vision:!0,audioInput:!0,videoInput:!0,pdf:!0,reasoning:!0,search:!0,thinkingFormat:"gemini-level",thinkingCanDisable:!1,contextWindow:1048576,maxOutput:65536}},{pattern:"*gemini-3.7*",caps:{vision:!0,audioInput:!0,videoInput:!0,pdf:!0,reasoning:!0,search:!0,thinkingFormat:"gemini-level",thinkingCanDisable:!1,contextWindow:1048576,maxOutput:65536}},{pattern:"*gemini-3*pro*",caps:{vision:!0,audioInput:!0,videoInput:!0,pdf:!0,reasoning:!0,search:!0,thinkingFormat:"gemini-level",thinkingCanDisable:!1,contextWindow:1048576,maxOutput:65536}},{pattern:"*gemini-3*",caps:{vision:!0,audioInput:!0,videoInput:!0,pdf:!0,reasoning:!0,search:!0,thinkingFormat:"gemini-level",thinkingCanDisable:!1,contextWindow:1048576,maxOutput:65536}},{pattern:"*gemini-2.5*",caps:{vision:!0,audioInput:!0,videoInput:!0,pdf:!0,reasoning:!0,search:!0,thinkingFormat:"gemini-budget",thinkingRange:{min:0,max:24576},contextWindow:1048576,maxOutput:65536}},{pattern:"*gemini-2*",caps:{vision:!0,audioInput:!0,videoInput:!0,pdf:!0,search:!0,contextWindow:1048576,maxOutput:65536}},{pattern:"*gemini*",caps:{vision:!0,pdf:!0,search:!0,contextWindow:1048576}}';

const OLD_GPT_OSS = '{pattern:"*gpt-oss*",caps:{reasoning:!0,thinkingFormat:"openai",contextWindow:128e3}}';
const NEW_GPT_OSS = '{pattern:"*gpt-oss*",caps:{reasoning:!0,thinkingFormat:"openai",contextWindow:131072,maxOutput:65536}}';

// Clean suffix in getCapabilitiesForModel across all chunks
const CAPS_CLEAN_RE = /let ([a-zA-Z0-9_$]+)=([a-zA-Z0-9_$]+)\.includes\("\/"\)\?\2\.split\("\/"\)\.pop\(\):\2;/;
const CAPS_CLEAN_REPL = '$2=String($2).replace(/\\([^()]+\\)\\s*$/,"").trim();let $1=$2.includes("/")?$2.split("/").pop():$2;';

for (const dir of [BUILD_SERVER, path.join(BUILD_SERVER, "chunks")]) {
  for (const f of ["24.js", "412.js", "8402.js"]) {
    const full = path.join(dir, f);
    patchFile(full, '"claude-opus-4-6-thinking"', OLD_FABLE_CAPS, NEW_FABLE_CAPS);
    patchFile(full, '"gpt-6.1-sol[1m]"', CODEX_1M_RE, CODEX_1M_REPL);
    patchFile(full, '{pattern:"*gemini-4*",caps:{vision:!0,audioInput:!0,videoInput:!0,pdf:!0', OLD_GEMINI_PATTERNS, NEW_GEMINI_PATTERNS);
    patchFile(full, 'contextWindow:131072,maxOutput:65536', OLD_GPT_OSS, NEW_GPT_OSS);
    patchFile(full, 'replace(/\\([^()]+\\)\\s*$/', CAPS_CLEAN_RE, CAPS_CLEAN_REPL);
  }
}

const staticChunksDir = path.join(BUILD_STATIC, "chunks");
if (fs.existsSync(staticChunksDir)) {
  for (const f of fs.readdirSync(staticChunksDir)) {
    if (f.startsWith("5497-") && f.endsWith(".js") && !f.endsWith(".bak")) {
      const full = path.join(staticChunksDir, f);
      patchFile(full, '"claude-opus-4-6-thinking"', OLD_FABLE_CAPS, NEW_FABLE_CAPS);
      patchFile(full, '"gpt-6.1-sol[1m]"', CODEX_1M_RE, CODEX_1M_REPL);
      patchFile(full, '{pattern:"*gemini-4*",caps:{vision:!0,audioInput:!0,videoInput:!0,pdf:!0', OLD_GEMINI_PATTERNS, NEW_GEMINI_PATTERNS);
      patchFile(full, 'contextWindow:131072,maxOutput:65536', OLD_GPT_OSS, NEW_GPT_OSS);
      patchFile(full, 'replace(/\\([^()]+\\)\\s*$/', CAPS_CLEAN_RE, CAPS_CLEAN_REPL);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. REGISTRY: gemini-3.1-pro-high -> gemini-pro-agent(high), gpt-6.1-[1m],
//    searchViaChat -> gemini-3.8-flash (both server & static registry chunks)
// ─────────────────────────────────────────────────────────────────────────────

const OLD_AG_REG = '{id:"gemini-3.1-pro-high",name:"Gemini 3.1 Pro (High)",upstreamModelId:"gemini-pro-agent"},';
const NEW_AG_REG = '{id:"gemini-3.1-pro-high",name:"Gemini 3.1 Pro (High)",upstreamModelId:"gemini-pro-agent(high)"},';

const OLD_SEARCH_MODEL = 'refreshLeadMs:3e5},searchViaChat:{defaultModel:"gemini-2.5-flash",';
const NEW_SEARCH_MODEL = 'refreshLeadMs:3e5},searchViaChat:{defaultModel:"gemini-3.8-flash",';

const CODEX_61_RE = /\{id:"gpt-6\.1-sol",name:"GPT 6\.1 Sol",responsesLite:!0,thinkingLevels:([a-zA-Z0-9_$]+)\},\{id:"gpt-6\.1-terra",name:"GPT 6\.1 Terra",responsesLite:!0,thinkingLevels:\1\},/;
const CODEX_61_REPL = (_, v) => `{id:"gpt-6.1-sol",name:"GPT 6.1 Sol",responsesLite:!0,thinkingLevels:${v}},{id:"gpt-6.1-sol[1m]",name:"GPT 6.1 Sol (extended context)",upstreamModelId:"gpt-6.1-sol",responsesLite:!0,thinkingLevels:${v}},{id:"gpt-6.1-terra",name:"GPT 6.1 Terra",responsesLite:!0,thinkingLevels:${v}},{id:"gpt-6.1-terra[1m]",name:"GPT 6.1 Terra (extended context)",upstreamModelId:"gpt-6.1-terra",responsesLite:!0,thinkingLevels:${v}},`;

for (const dir of [BUILD_SERVER, path.join(BUILD_SERVER, "chunks")]) {
  for (const f of ["2598.js", "4480.js", "8499.js", "3783.js", "3966.js", "5330.js", "6763.js", "8416.js", "8920.js", "915.js"]) {
    const full = path.join(dir, f);
    patchFile(full, 'upstreamModelId:"gemini-pro-agent(high)"', OLD_AG_REG, NEW_AG_REG);
    patchFile(full, 'searchViaChat:{defaultModel:"gemini-3.8-flash"', OLD_SEARCH_MODEL, NEW_SEARCH_MODEL);
    patchFile(full, 'id:"gpt-6.1-sol[1m]"', CODEX_61_RE, CODEX_61_REPL);
  }
}

if (fs.existsSync(staticChunksDir)) {
  for (const f of fs.readdirSync(staticChunksDir)) {
    if (f.startsWith("1321-") && f.endsWith(".js") && !f.endsWith(".bak")) {
      const full = path.join(staticChunksDir, f);
      patchFile(full, 'upstreamModelId:"gemini-pro-agent(high)"', OLD_AG_REG, NEW_AG_REG);
      patchFile(full, 'searchViaChat:{defaultModel:"gemini-3.8-flash"', OLD_SEARCH_MODEL, NEW_SEARCH_MODEL);
      patchFile(full, 'id:"gpt-6.1-sol[1m]"', CODEX_61_RE, CODEX_61_REPL);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. TRANSLATOR & EXECUTOR: Dynamic output ceiling, Claude temperature:0,
//    max_completion_tokens/max_output_tokens, stop sequences, and search/fetch tools
// ─────────────────────────────────────────────────────────────────────────────

const OLD_AG_CLAMP = 'let t={...r.generationConfig||{}};t.maxOutputTokens>64e3&&(t.maxOutputTokens=64e3);let v={...r,generationConfig:t,...k&&{contents:k},...o&&{tools:o},sessionId:g,safetySettings:void 0,...o?.length>0&&{toolConfig:{functionCallingConfig:{mode:"VALIDATED"}}}};';
const BUGGY_AG_CLAMP = 'let _caps=(0,d.getCapabilitiesForModel)("antigravity",a),_maxOut=_caps?.maxOutput||65536,t={...r.generationConfig||{}};t.maxOutputTokens>_maxOut&&(t.maxOutputTokens=_maxOut);let v={...r,generationConfig:t,...k&&{contents:k},...o?.length>0&&{tools:o},sessionId:g,safetySettings:void 0,...o?.some(a=>a?.functionDeclarations?.length>0)&&{toolConfig:{functionCallingConfig:{mode:"VALIDATED"}}}};';
const NEW_AG_CLAMP = 'let _maxOut=a?.includes("claude")?128e3:65536,t={...r.generationConfig||{}};t.maxOutputTokens>_maxOut&&(t.maxOutputTokens=_maxOut);let v={...r,generationConfig:t,...k&&{contents:k},...o?.length>0&&{tools:o},sessionId:g,safetySettings:void 0,...o?.some(a=>a?.functionDeclarations?.length>0)&&{toolConfig:{functionCallingConfig:{mode:"VALIDATED"}}}};';

const OLD_AG_IMG_EXEC = 'let i={contents:g,generationConfig:{temperature:1,topP:.95,topK:40,maxOutputTokens:8192,imageConfig:c},sessionId:h};';
const NEW_AG_IMG_EXEC = 'let i={contents:g,generationConfig:{temperature:b.temperature??b.request?.generationConfig?.temperature??1,topP:b.top_p??b.topP??b.request?.generationConfig?.topP??.95,topK:b.top_k??b.topK??b.request?.generationConfig?.topK??40,maxOutputTokens:b.max_tokens??b.max_output_tokens??b.request?.generationConfig?.maxOutputTokens??8192,imageConfig:c,...void 0!==b.seed?{seed:b.seed}:{}},sessionId:h};';

const OLD_GEMINI_TOK = ',void 0!==b.max_tokens&&(j.generationConfig.maxOutputTokens=b.max_tokens);let p={};';
const NEW_GEMINI_TOK = ',(b.max_tokens??b.max_completion_tokens??b.max_output_tokens)&&(j.generationConfig.maxOutputTokens=b.max_tokens??b.max_completion_tokens??b.max_output_tokens),void 0!==b.stop&&(j.generationConfig.stopSequences=Array.isArray(b.stop)?b.stop.map(String).slice(0,5):[String(b.stop)]);let p={};';

const OLD_FLOOR_HIGH = 'q={minimal:4096,low:8192,medium:16384,high:65535}';
const NEW_FLOOR_HIGH = 'q={minimal:4096,low:8192,medium:16384,high:65536}';
const OLD_BUDGET_FLOOR = 'j<=24576?32768:65535:32768,d);break}';
const NEW_BUDGET_FLOOR = 'j<=24576?32768:65536:32768,d);break}';

const OLD_CLAUDE_GC = 'generationConfig:{temperature:b.temperature||1,maxOutputTokens:b.max_tokens||4096}';
const NEW_CLAUDE_GC = 'generationConfig:{temperature:void 0!==b.temperature?b.temperature:1,maxOutputTokens:b.max_tokens||8192,...void 0!==b.top_p?{topP:b.top_p}:{},...void 0!==b.top_k?{topK:b.top_k}:{},...Array.isArray(b.stop_sequences)&&b.stop_sequences.length>0?{stopSequences:b.stop_sequences}:{}}';

// Avoid Google 400 when only built-in tools (googleSearch) exist in wrapInCloudCodeEnvelope
const OLD_CLI_WRAP = 'b.tools?.length>0&&(e.request.toolConfig={functionCallingConfig:{mode:"VALIDATED"}})';
const NEW_CLI_WRAP = 'b.tools?.some(a=>a?.functionDeclarations?.length>0)&&(e.request.toolConfig={functionCallingConfig:{mode:"VALIDATED"}})';

// Avoid emitting empty tools: [] in AntigravityExecutor
const OLD_AG_TOOLS_SPREAD = '...o&&{tools:o}';
const NEW_AG_TOOLS_SPREAD = '...o?.length>0&&{tools:o}';

// Support full model ceiling and sampling in claudeToOpenAIRequest
const OLD_C2O_ADJUST = 'b.max_tokens&&(f.max_tokens=(0,r.M)(b)),void 0!==b.temperature&&(f.temperature=b.temperature)';
const BUGGY_C2O_ADJUST = 'b.max_tokens&&(f.max_tokens=(0,r.M)(b,(0,c(24).getCapabilitiesForModel)(null,a)?.maxOutput||void 0)),void 0!==b.temperature&&(f.temperature=b.temperature),void 0!==b.top_p&&(f.top_p=b.top_p),void 0!==b.top_k&&(f.top_k=b.top_k),void 0!==b.stop_sequences&&(f.stop=b.stop_sequences)';
const NEW_C2O_ADJUST = 'b.max_tokens&&(f.max_tokens=(0,r.M)(b,a?.includes("claude")?128e3:65536)),void 0!==b.temperature&&(f.temperature=b.temperature),void 0!==b.top_p&&(f.top_p=b.top_p),void 0!==b.top_k&&(f.top_k=b.top_k),void 0!==b.stop_sequences&&(f.stop=b.stop_sequences)';

// Preserve googleSearch / urlContext / codeExecution built-in tools in AntigravityExecutor
const OLD_EXEC_TOOLS = String.raw`if(o&&o.length>0){let a=new Set,b=[];for(let c of o)for(let d of c.functionDeclarations||[]){let c=function(a){if(!a)return"_unknown";let b=a.replace(/[^a-zA-Z0-9_.:\-]/g,"_");return/^[a-zA-Z_]/.test(b)||(b="_"+b),b.substring(0,64)}(d.name);a.has(c)||(a.add(c),b.push({...d,name:c,parameters:d.parameters?(0,l.Yr)(structuredClone(d.parameters)):{type:"object",properties:{reason:{type:"string",description:"Brief explanation"}},required:["reason"]}}))}o=b.length>0?[{functionDeclarations:b}]:[]}`;
const NEW_EXEC_TOOLS = String.raw`if(o&&o.length>0){let a=new Set,b=[],_bt=[];for(let c of o){if(c&&(c.googleSearch||c.google_search||c.googleSearchRetrieval||c.urlContext||c.url_context||c.codeExecution||c.code_execution)){_bt.push(c);continue}for(let d of c?.functionDeclarations||[]){let c=function(a){if(!a)return"_unknown";let b=a.replace(/[^a-zA-Z0-9_.:\-]/g,"_");return/^[a-zA-Z_]/.test(b)||(b="_"+b),b.substring(0,64)}(d.name);a.has(c)||(a.add(c),b.push({...d,name:c,parameters:d.parameters?(0,l.Yr)(structuredClone(d.parameters)):{type:"object",properties:{reason:{type:"string",description:"Brief explanation"}},required:["reason"]}}))}}o=[...b.length>0?[{functionDeclarations:b}]:[],..._bt]}`;

// Translate web_search / google_search / url_context / code_execution in openaiToGeminiBase
const OLD_TRANSLATOR_TOOLS = 'if(b.tools&&Array.isArray(b.tools)&&b.tools.length>0){let a=[];for(let c of b.tools)if(c.name&&c.input_schema){let b=(0,i.Yr)(structuredClone(c.input_schema||{type:"object",properties:{}}));a.push({name:n(c.name),description:c.description||"",parameters:b})}else if(c.type===k.x4.FUNCTION&&c.function){let b=c.function,d=(0,i.Yr)(structuredClone(b.parameters||{type:"object",properties:{}}));a.push({name:n(b.name),description:b.description||"",parameters:d})}a.length>0&&(j.tools=[{functionDeclarations:a}])}';
const NEW_TRANSLATOR_TOOLS = 'if(b.tools&&Array.isArray(b.tools)&&b.tools.length>0){let a=[],_gs=!1,_uc=!1,_ce=!1;for(let c of b.tools){if(!c||"object"!=typeof c)continue;if(c.googleSearch||c.google_search||"web_search"===c.type||"google_search"===c.type||"googleSearch"===c.type){_gs=!0;continue}if(c.urlContext||c.url_context||"url_context"===c.type||"urlContext"===c.type||"web_fetch"===c.type){_uc=!0;continue}if(c.codeExecution||c.code_execution||"code_execution"===c.type||"codeExecution"===c.type){_ce=!0;continue}if(c.name&&c.input_schema){let b=(0,i.Yr)(structuredClone(c.input_schema||{type:"object",properties:{}}));a.push({name:n(c.name),description:c.description||"",parameters:b})}else if(c.type===k.x4.FUNCTION&&c.function){let b=c.function,d=(0,i.Yr)(structuredClone(b.parameters||{type:"object",properties:{}}));a.push({name:n(b.name),description:b.description||"",parameters:d})}}let _gt=[...a.length>0?[{functionDeclarations:a}]:[],..._gs?[{googleSearch:{}}]:[],..._uc?[{urlContext:{}}]:[],..._ce?[{codeExecution:{}}]:[]];_gt.length>0&&(j.tools=_gt)}';

for (const dir of [BUILD_SERVER, path.join(BUILD_SERVER, "chunks")]) {
  for (const f of ["2380.js", "2430.js"]) {
    const full = path.join(dir, f);
    patchFile(full, '_maxOut=a?.includes("claude")?128e3:65536', BUGGY_AG_CLAMP, NEW_AG_CLAMP);
    patchFile(full, '_maxOut=a?.includes("claude")?128e3:65536', OLD_AG_CLAMP, NEW_AG_CLAMP);
    patchFile(full, 'maxOutputTokens:b.max_tokens??b.max_output_tokens??b.request?.generationConfig?.maxOutputTokens??8192', OLD_AG_IMG_EXEC, NEW_AG_IMG_EXEC);
    patchFile(full, '(b.max_tokens??b.max_completion_tokens??b.max_output_tokens)&&', OLD_GEMINI_TOK, NEW_GEMINI_TOK);
    patchFile(full, 'high:65536', OLD_FLOOR_HIGH, NEW_FLOOR_HIGH);
    patchFile(full, 'j<=24576?32768:65536:32768,d);break}', OLD_BUDGET_FLOOR, NEW_BUDGET_FLOOR);
    patchFile(full, 'temperature:void 0!==b.temperature?b.temperature:1', OLD_CLAUDE_GC, NEW_CLAUDE_GC);
    patchFile(full, 'b.tools?.some(a=>a?.functionDeclarations?.length>0)', OLD_CLI_WRAP, NEW_CLI_WRAP);
    patchFile(full, '...o?.length>0&&{tools:o}', OLD_AG_TOOLS_SPREAD, NEW_AG_TOOLS_SPREAD);
    patchFile(full, '(f.max_tokens=(0,r.M)(b,a?.includes("claude")?128e3:65536))', BUGGY_C2O_ADJUST, NEW_C2O_ADJUST);
    patchFile(full, '(f.max_tokens=(0,r.M)(b,a?.includes("claude")?128e3:65536))', OLD_C2O_ADJUST, NEW_C2O_ADJUST);
    patchFile(full, '_bt.push(c)', OLD_EXEC_TOOLS, NEW_EXEC_TOOLS);
    patchFile(full, '_gs?[{googleSearch:{}}]:[]', OLD_TRANSLATOR_TOOLS, NEW_TRANSLATOR_TOOLS);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. IMAGE GENERATION ROUTE: forward client parameters into chatBody
// ─────────────────────────────────────────────────────────────────────────────

const OLD_IMG_ROUTE = 'g.execute({model:h,body:{contents:[{role:"user",parts:k}]},stream:!1,credentials:c,log:d})';
const NEW_IMG_ROUTE = 'g.execute({model:h,body:{contents:[{role:"user",parts:k}],...void 0!==b.temperature?{temperature:b.temperature}:{},...void 0!==b.top_p?{top_p:b.top_p}:{},...void 0!==b.top_k?{top_k:b.top_k}:{},...void 0!==b.seed?{seed:b.seed}:{},...void 0!==b.max_tokens?{max_tokens:b.max_tokens}:{}},stream:!1,credentials:c,log:d})';

patchFile(path.join(BUILD_SERVER, "app/api/v1/images/generations/route.js"), '...void 0!==b.temperature?{temperature:b.temperature}:{}', OLD_IMG_ROUTE, NEW_IMG_ROUTE);

// ─────────────────────────────────────────────────────────────────────────────
// 5. SEARCH ROUTE: accept and forward client options to Antigravity search
// ─────────────────────────────────────────────────────────────────────────────

const OLD_SEARCH_ROUTE = 'buildBody:(a,b,c)=>({project:c.projectId,model:b,userAgent:"antigravity",requestType:"search",request:{contents:[{role:"user",parts:[{text:a}]}],tools:[{googleSearch:{}}],generationConfig:r}})';
const NEW_SEARCH_ROUTE = 'buildBody:(a,b,c,d={})=>({project:c.projectId,model:b,userAgent:"antigravity",requestType:"search",request:{contents:[{role:"user",parts:[{text:a}]}],tools:[{googleSearch:{}}],generationConfig:{...r,...d?.max_output_tokens?{maxOutputTokens:Math.min(d.max_output_tokens,65536)}:{},...void 0!==d?.temperature?{temperature:d.temperature}:{}}}})';

patchFile(path.join(BUILD_SERVER, "app/api/v1/search/route.js"), 'maxOutputTokens:Math.min(d.max_output_tokens,65536)', OLD_SEARCH_ROUTE, NEW_SEARCH_ROUTE);

if (!DRY_RUN && patchedFiles.size > 0) {
  console.log("\nVerifying syntax with node --check...");
  for (const f of patchedFiles) {
    if (f.includes(".next-cli-build\\server") || f.includes(".next-cli-build/server")) {
      execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
      console.log(`[SYNTAX OK] ${path.relative(ROOT, f)}`);
    }
  }
}

console.log(`\n[patch-9r-model-power] Complete. Patched ${patchedCount} operations across ${patchedFiles.size} files.`);
