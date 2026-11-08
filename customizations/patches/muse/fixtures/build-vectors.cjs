// One-off: pull the 25519/AESGCM/SHA256 test vectors out of the two public
// vector files and write a compact JSON fixture for test-noise.js.
//   fixtures/vectors.txt    flynn/noise   — handshake frames, prefixes stripped
//   fixtures/cacophony.txt  rweather/noise-c — the official v1.0 vector set
// Run: node muse/fixtures/build-vectors.cjs
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const dir = __dirname;
const out = {};

const raw = fs
  .readFileSync(path.join(dir, "vectors.txt"), "utf8")
  .replace(/\r\n/g, "\n")
  .split("\n\n");

for (const block of raw) {
  const lines = block.split("\n").filter(Boolean);
  if (!lines.length || !lines[0].startsWith("handshake=")) continue;
  const fields = {};
  for (const line of lines) {
    const i = line.indexOf("=");
    if (i > 0) fields[line.slice(0, i)] = line.slice(i + 1);
  }
  const name = fields.handshake;
  if (!/_25519_AESGCM_SHA256$/.test(name)) continue;
  const messages = [];
  for (let i = 0; i < 6; i += 1) {
    const ct = fields[`msg_${i}_ciphertext`];
    if (!ct) continue;
    messages.push({ payload: fields[`msg_${i}_payload`] || "", ciphertext: ct });
  }
  const siblings = Object.keys(out).filter((k) => k === name || k.startsWith(`${name}#`)).length;
  const id = siblings === 0 ? name : `${name}#${siblings}`;
  out[id] = {
    source: "flynn/noise vectors.txt (token bytes concatenated, 2-byte length prefixes stripped)",
    pattern: (/^Noise_([A-Za-z0-9]+?)_25519_/.exec(name) || [])[1] || null,
    prologue: fields.prologue || null,
    initStatic: fields.init_static || null,
    respStatic: fields.resp_static || null,
    initEphemeral: fields.gen_init_ephemeral || null,
    respEphemeral: fields.gen_resp_ephemeral || null,
    psk: fields.preshared_key || null,
    messages,
  };
}

const caco = JSON.parse(fs.readFileSync(path.join(dir, "cacophony.txt"), "utf8"));
for (const v of caco.vectors) {
  if (v.cipher !== "AESGCM" || v.dh !== "25519" || v.hash !== "SHA256") continue;
  if (!["XX", "IK", "XK", "NK", "N", "NN"].includes(v.pattern)) continue;
  out[`cacophony:${v.name}`] = {
    source: "rweather/noise-c cacophony.txt (official v1.0 vectors, prefixes stripped)",
    pattern: v.pattern,
    prologue: v.init_prologue || null,
    initStatic: v.init_static || null,
    respStatic: v.resp_static || null,
    initEphemeral: v.init_ephemeral || null,
    respEphemeral: v.resp_ephemeral || null,
    psk: v.preshared_key || null,
    messages: v.messages.map((mm) => ({ payload: mm.payload, ciphertext: mm.ciphertext })),
  };
}

fs.writeFileSync(path.join(dir, "noise-vectors.json"), JSON.stringify(out, null, 1) + "\n");
console.log("wrote", Object.keys(out).length, "vector sets");
