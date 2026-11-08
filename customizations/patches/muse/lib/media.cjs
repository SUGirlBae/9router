// Media over the Muse tunnel: where an artifact lives in a chat event, how its
// path is normalised, and how the bytes are fetched.
//
// Two facts drive this file (protocol-notes.md §D2/§D3):
//   · media comes back as the BODY of a GET RPC over the same Noise WebSocket —
//     there is no media host, and plain HTTPS to the VM does not work;
//   · there is no job/status API, so "generation finished" means the artifact
//     set stopped changing while polling /chat/history.

"use strict";

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;
const VIDEO_EXT = /\.(mp4|webm|mov|m4v|mkv|avi)$/i;
const MEDIA_RE = /sandbox:\/\/[^\s)"']+/g;
const MAX_MEDIA_BYTES = 150 * 1024 * 1024;

// Turn sandbox://C:\workspace\out\a.png or /home/user/x into the path the
// gateway's /fs/raw expects: workspace-rooted, slash-normalised, no leading /.
function normalizeGatewayPath(raw) {
  let text = String(raw || "").trim();
  if (!text) return "";
  text = text.split("?")[0].split("#")[0];
  text = text.replace(/^file:\/\//i, "").replace(/^sandbox:\/\//i, "");
  text = text.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  let parts = text.split("/").filter(Boolean);
  // The gateway's own media URL keeps the workspace segment
  // (https://<vm>.metaaivm.com/media/raw/workspace/imagine_media/x.webp), so
  // dropping it here would make every tunnel route 404. Keep it.
  const workspaceAt = parts.findIndex((p) => /workspace/i.test(p));
  if (workspaceAt >= 0) parts = parts.slice(workspaceAt);
  else if (parts.length >= 3 && /^(home|users)$/i.test(parts[0])) parts = parts.slice(2);
  return parts.join("/");
}

// The artifact node often carries a full signed URL for the very route we need.
// Its path is the most trustworthy candidate, so lift it out and send it through
// the tunnel instead of trying to fetch a VM-host URL that is not public.
function tunnelPathFromUrl(url) {
  const text = String(url || "");
  if (!/^https?:\/\//i.test(text)) return "";
  let path = "";
  try {
    path = new URL(text).pathname;
  } catch {
    return "";
  }
  const match = /^\/(?:media|fs)\/raw\/(.+)$/.exec(path);
  return match ? decodeURIComponent(match[1]) : "";
}

function kindOf({ mime, path, url, kind }) {
  const hint = String(kind || "").toLowerCase();
  if (hint === "video" || VIDEO_EXT.test(path || "") || VIDEO_EXT.test(url || "")) return "video";
  if (hint === "image" || IMAGE_EXT.test(path || "") || IMAGE_EXT.test(url || "")) return "image";
  if (/^video\//.test(String(mime || ""))) return "video";
  if (/^image\//.test(String(mime || ""))) return "image";
  return null;
}

function mimeFor(ref) {
  if (ref.mime) return ref.mime;
  const fromUrl = String(ref.url || ref.path || "").split("?")[0];
  const match = /\.(png|jpe?g|webp|gif|mp4|webm|mov|m4v)$/i.exec(fromUrl);
  if (!match) return ref.kind === "video" ? "video/mp4" : "image/png";
  const ext = match[1].toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  if (ext === "mp4" || ext === "m4v") return "video/mp4";
  if (ext === "webm") return "video/webm";
  if (ext === "mov") return "video/quicktime";
  return "application/octet-stream";
}

function refFromNode(node) {
  if (!node || typeof node !== "object") return null;
  const path = node.path || node.image_path || node.video_path || null;
  const url = node.url || (node.variants && typeof node.variants === "object" ? node.variants.original : null);
  if (!path && !url) return null;
  const mime = node.mime || node.mime_type || node.mimeType || node.content_type || node.contentType || null;
  const kind = kindOf({ mime, path, url, kind: node.kind || node.type });
  // Identity is the normalised path when there is one: signed URLs rotate while
  // the file stays the same, and a prose-mined mention of the same path must
  // collapse onto the structured node rather than duplicate it.
  const normalisedPath = path ? normalizeGatewayPath(path) : "";
  const normalisedSandboxUrl = url && /^sandbox:\/\//i.test(url) ? normalizeGatewayPath(url) : "";
  const identity =
    normalisedPath ||
    normalisedSandboxUrl ||
    node.resource_id ||
    node.resourceId ||
    node.media_handle ||
    node.mediaHandle ||
    url ||
    path ||
    "";
  const ref = {
    path: path ? normalizeGatewayPath(path) : null,
    url: url && !/^sandbox:\/\//i.test(url) ? url : null,
    sandboxUrl: url && /^sandbox:\/\//i.test(url) ? normalizeGatewayPath(url) : null,
    mime,
    kind,
    label: node.label || node.prompt || node.alt || null,
    byteLen: Number(node.byte_len || 0) || 0,
    identity: String(identity || url || path || ""),
  };
  if (!ref.path && ref.sandboxUrl) ref.path = ref.sandboxUrl;
  ref.tunnelPath = tunnelPathFromUrl(node.variants && node.variants.original) || tunnelPathFromUrl(url);
  return ref;
}

// Walk one chat event for artifacts. Presentation events are the primary source;
// event.resources and stray sandbox:// text are the fallbacks the real payloads
// need (the reference clients mine sandbox:// substrings out of prose).
function extractRefs(event) {
  const found = [];
  const push = (node) => {
    const ref = refFromNode(node);
    if (ref) found.push(ref);
  };
  const payload = (event && event.payload) || {};
  const data = payload.data || {};
  for (const list of [data.images, data.videos, payload.images, payload.videos]) {
    if (Array.isArray(list)) list.forEach(push);
  }
  if (Array.isArray(event.resources)) event.resources.forEach(push);
  const text = JSON.stringify(event || {});
  for (const match of text.match(MEDIA_RE) || []) {
    const bare = normalizeGatewayPath(match);
    if (bare) found.push({ path: bare, sandboxUrl: bare, identity: bare, kind: kindOf({ path: bare }), mime: null, label: null, byteLen: 0 });
  }
  const seen = new Set();
  return found.filter((ref) => (seen.has(ref.identity) ? false : (seen.add(ref.identity), true)));
}

const signatureOf = (refs) => refs.map((ref) => ref.identity).sort().join("|");

// /media/raw first, then /fs/raw (both over the tunnel), then plain HTTPS as a
// last resort — signed VM URLs are not publicly reachable, so this usually fails.
async function download(conn, ref, { signal, fetch = globalThis.fetch } = {}) {
  const candidates = [];
  // The route the gateway itself advertised beats any guess about the workspace root.
  if (ref.tunnelPath) {
    candidates.push({ tunnel: `/media/raw/${encodePath(ref.tunnelPath)}` });
    candidates.push({ tunnel: `/fs/raw/${encodePath(ref.tunnelPath)}` });
  }
  if (ref.path) {
    candidates.push({ tunnel: `/media/raw/${encodePath(ref.path)}` });
    candidates.push({ tunnel: `/fs/raw/${encodePath(ref.path)}` });
  }
  if (ref.url && /^https?:\/\//i.test(ref.url)) candidates.push({ external: ref.url });

  let lastError = null;
  const attempts = [];
  for (const candidate of candidates) {
    const label = (candidate.tunnel || candidate.external || "").slice(0, 90);
    try {
      if (candidate.external) {
        const res = await fetch(candidate.external, { signal });
        if (res.status >= 400) {
          attempts.push(`${label} -> ${res.status}`);
          continue;
        }
        const bytes = Buffer.from(await res.arrayBuffer());
        if (bytes.length > MAX_MEDIA_BYTES) throw new Error(`media of ${bytes.length} bytes exceeds the ${MAX_MEDIA_BYTES} cap`);
        if (!bytes.length) {
          attempts.push(`${label} -> empty body`);
          continue;
        }
        return { bytes, mime: res.headers.get("content-type") || mimeFor(ref) };
      }
      const res = await conn.request({ method: "GET", path: candidate.tunnel, timeoutMs: 120000, signal });
      if (res.status >= 400) {
        attempts.push(`${label} -> ${res.status} ${res.text().slice(0, 80)}`);
        continue;
      }
      if (res.body.length > MAX_MEDIA_BYTES) throw new Error(`media of ${res.body.length} bytes exceeds the ${MAX_MEDIA_BYTES} cap`);
      if (!res.body.length) {
        attempts.push(`${label} -> empty body`);
        continue;
      }
      return { bytes: res.body, mime: guessMime(res, ref) };
    } catch (err) {
      lastError = err;
      attempts.push(`${label} -> ${String(err.message).slice(0, 80)}`);
    }
  }
  // Saying which route failed why is the difference between "media broken" and
  // "the tunnel route is 404, so this account only serves signed URLs".
  throw new Error(
    `could not fetch ${String(ref.identity).slice(0, 80)}: ${attempts.join(" | ") || (lastError && lastError.message) || "no candidates"}`
  );
}

function encodePath(path) {
  return path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

function guessMime(res, ref) {
  const header = (res.headers || []).find((h) => String(h.key).toLowerCase() === "content-type");
  if (header && header.value) return header.value;
  return mimeFor(ref);
}

// Refusal strings observed on the wire (§D4). Matched case-insensitively against
// the assistant text so a blocked generation fails fast instead of polling for
// ten minutes.
const REFUSAL_MARKERS = [
  "i can’t generate", "i can't generate", "cannot generate", "can not generate",
  "unable to generate", "i am unable to create", "i'm unable to create",
  "not allowed to generate", "i can’t create", "i can't create",
  "generation is not available", "video is not available", "not supported for your account",
  "region", "out of credits", "quota", "limit reached", "too many requests",
  "无法生成", "不能生成", "不支持", "额度",
];

function refusalIn(text) {
  const lower = String(text || "").toLowerCase();
  return REFUSAL_MARKERS.find((marker) => lower.includes(marker)) || null;
}

module.exports = {
  normalizeGatewayPath,
  tunnelPathFromUrl,
  extractRefs,
  refFromNode,
  kindOf,
  mimeFor,
  signatureOf,
  download,
  encodePath,
  refusalIn,
  REFUSAL_MARKERS,
  MAX_MEDIA_BYTES,
  IMAGE_EXT,
  VIDEO_EXT,
};
