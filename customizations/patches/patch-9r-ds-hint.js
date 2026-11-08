const fs = require("fs");

const CHUNK = "C:/Users/Administrator/AppData/Roaming/npm/node_modules/9router/app/.next-cli-build/server/chunks/5330.js";

// DeepSeek reports failures as `event: hint` frames ({type:"error", content, finish_reason}).
// The parser only looked at p/v frames, so backend_busy became a silent empty 200.
const EDITS = [
  {
    name: "declare hint accumulator",
    old: 'k=W(j),l=[],m=a=>{',
    neu: 'k=W(j),l=[],hintErr=null,m=a=>{',
  },
  {
    name: "capture hint error frames",
    old: 'try{let a=JSON.parse(b),c=a?.p,d=a?.v;if("response/status"===c&&"FINISHED"===d&&(i=!0),',
    neu: 'try{let a=JSON.parse(b),c=a?.p,d=a?.v;if("error"===a?.type&&a?.finish_reason&&(hintErr=String(a.content||"")+" ["+a.finish_reason+"]"),"response/status"===c&&"FINISHED"===d&&(i=!0),',
  },
  {
    name: "surface real reason in the error",
    old: 'throw Error("DeepSeek web session ended before completion (no FINISHED signal received)',
    neu: 'throw Error(hintErr?"DeepSeek upstream: "+hintErr:"DeepSeek web session ended before completion (no FINISHED signal received)',
  },
];

let s = fs.readFileSync(CHUNK, "utf8");
if (s.includes("hintErr")) { console.log("SKIP: already patched"); process.exit(0); }

for (const e of EDITS) {
  const n = s.split(e.old).length - 1;
  if (n !== 1) { console.error(`ABORT [${e.name}]: expected 1 occurrence, found ${n}`); process.exit(1); }
  s = s.replace(e.old, e.neu);
  console.log("applied:", e.name);
}

const bak = CHUNK + ".pre-hint.bak";
if (!fs.existsSync(bak)) fs.writeFileSync(bak, fs.readFileSync(CHUNK, "utf8"));
fs.writeFileSync(CHUNK, s);
console.log("patched deepseek-web hint surfacing (backup:", bak + ")");
