"use strict";
// DeepSeekHashV1 proof-of-work solver.
// Implements the module 9router's deepseek-pow-worker.mjs imports but never shipped in the npm package.
// The search itself is delegated to the SHA3 wasm DeepSeek's own web client uses, so the hash
// variant matches upstream exactly instead of a reimplementation.

const fs = require("node:fs");
const path = require("node:path");

const MAX_DEEPSEEK_POW_DIFFICULTY = 250000;

const WASM_NAMES = ["sha3_wasm_bg.wasm", "sha3_wasm_bg.7b9ca65ddd.wasm"];

let wasm = null;

function loadWasm() {
  if (wasm) return wasm;
  const candidates = [];
  for (const name of WASM_NAMES) candidates.push(path.join(__dirname, name));
  const file = candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  if (!file) throw Error(`DeepSeek PoW wasm not found (looked for: ${WASM_NAMES.join(", ")} in ${__dirname})`);
  const bytes = fs.readFileSync(file);
  const module = new WebAssembly.Module(bytes);
  const instance = new WebAssembly.Instance(module, { wbg: {} });
  wasm = instance.exports;
  return wasm;
}

function writeString(ex, encoder, str) {
  const enc = encoder.encode(str);
  const ptr = ex.__wbindgen_export_0(enc.length, 1) >>> 0;
  new Uint8Array(ex.memory.buffer).subarray(ptr, ptr + enc.length).set(enc);
  return { ptr, len: enc.length };
}

function findDeepSeekPowNonce(prefix, challenge, difficulty) {
  if (typeof challenge !== "string" || !/^[a-f0-9]{64}$/i.test(challenge)) return -1;
  if (typeof prefix !== "string" || prefix.length === 0 || prefix.length > 1200) return -1;
  if (!Number.isSafeInteger(difficulty) || difficulty < 1 || difficulty > MAX_DEEPSEEK_POW_DIFFICULTY) return -1;

  const ex = loadWasm();
  const encoder = new TextEncoder();
  const c = writeString(ex, encoder, challenge);
  const p = writeString(ex, encoder, prefix);

  const ret = ex.__wbindgen_add_to_stack_pointer(-16);
  try {
    ex.wasm_solve(ret, c.ptr, c.len, p.ptr, p.len, difficulty);
    const view = new DataView(ex.memory.buffer);
    const status = view.getInt32(ret, true);
    if (status === 0) return -1;
    const answer = view.getFloat64(ret + 8, true);
    return Number.isSafeInteger(answer) && answer >= 0 ? answer : -1;
  } finally {
    ex.__wbindgen_add_to_stack_pointer(16);
  }
}

exports.MAX_DEEPSEEK_POW_DIFFICULTY = MAX_DEEPSEEK_POW_DIFFICULTY;
exports.findDeepSeekPowNonce = findDeepSeekPowNonce;
