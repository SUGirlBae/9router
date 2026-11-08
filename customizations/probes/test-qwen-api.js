const fs = require("fs");
const jwt = JSON.parse(fs.readFileSync("C:/Users/Administrator/Documents/Qoder/2026-11-03/10707d32/qwen-jwts.json", "utf8"))[0];

const API = "https://chat.qwen.ai/api/v2";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";
const H = () => ({
  Authorization: `Bearer ${jwt}`,
  "Content-Type": "application/json",
  Accept: "text/event-stream",
  Origin: "https://chat.qwen.ai",
  Referer: "https://chat.qwen.ai/",
  "User-Agent": UA,
  "x-request-id": crypto.randomUUID(),
});

async function bounded(res, msCap = 30000, max = 5000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), msCap);
  let text = "";
  try {
    const rd = res.body.getReader();
    const dec = new TextDecoder();
    const end = Date.now() + msCap;
    while (Date.now() < end && text.length < max) {
      const { done, value } = await rd.read();
      if (done) { text += dec.decode(); break; }
      text += dec.decode(value, { stream: true });
    }
    try { rd.cancel(); } catch {}
  } finally { clearTimeout(timer); }
  return text;
}

(async () => {
  console.log("jwt len", jwt.length, "| alg/exp:", (() => { const p = JSON.parse(Buffer.from(jwt.split(".")[1], "base64")); return `${p.type||"?"} exp=${new Date((p.exp||0)*1000).toISOString()}`; })());

  // A) bare OpenAI-style
  let r = await fetch(`${API}/chat/completions`, { method: "POST", headers: H(), body: JSON.stringify({ model: "qwen3.7-plus", messages: [{ role: "user", content: "Reply with exactly: PLAIN-OK" }], stream: true }) });
  console.log("\n[A] bare OpenAI body ->", r.status, r.headers.get("content-type"));
  let t = await bounded(r);
  console.log(t.slice(0, 900).replace(/\n/g, " "));

  // B) proper flow: create chat, then completions with chat_id
  const cr = await fetch(`${API}/chats/new`, { method: "POST", headers: { ...H(), Accept: "application/json" }, body: JSON.stringify({ title: "9router probe", chat: { history: {}, messages: [], models: ["qwen3.7-plus"], params: {} }, models: ["qwen3.7-plus"], share_id: null, pinned: false, folder_id: null, is_archived: false } ) });
  const cj = await cr.json().catch(() => ({}));
  const chatId = cj?.data?.id || cj?.id;
  console.log("\n[B] /chats/new ->", cr.status, "| chatId:", chatId || JSON.stringify(cj).slice(0, 200));
  if (chatId) {
    const r2 = await fetch(`${API}/chat/completions?chat_id=${chatId}`, { method: "POST", headers: H(), body: JSON.stringify({ model: "qwen3.7-plus", chat_id: chatId, messages: [{ role: "user", content: "Reply with exactly: CHATID-OK" }], stream: true, incremental_output: true, version: "2.1", thinking: { type: "disabled" }, features: {"i2i": null, "t2i": false, "output_schema": "plain", "i2v": null, "t2v": null, "custom_export": null} }) });
    console.log("[B] completions?chat_id ->", r2.status, r2.headers.get("content-type"));
    console.log((await bounded(r2)).slice(0, 1200).replace(/\n/g, " "));
  }
})().catch((e) => console.error("FATAL:", e.message));
