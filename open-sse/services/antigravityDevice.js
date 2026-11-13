import crypto from "node:crypto";

const VIRTUAL_SALT = "9r-ag-device-shield-v1";
// RFC 4122 namespace for deterministic UUIDv5 derivation
const NAMESPACE_OID = "6ba7b812-9dad-11d1-80b4-00c04fd430c8";

function uuidv5FromBytes(name, namespaceHex) {
  const ns = Buffer.from(namespaceHex.replace(/-/g, ""), "hex");
  const hash = crypto.createHash("sha1").update(ns).update(name).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8] & 0x3f) | 0x80; // variant RFC 4122
  const h = hash.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * Generates a deterministic, unique, and fully isolated Virtual Device Profile
 * for any given connection/account key without hardcoding or reading Windows hardware.
 *
 * @param {string} connectionId - Unique connection ID or email of the account
 * @param {string} [seedExtra=""] - Optional salt modifier
 * @returns {object} Full Antigravity device profile matching official language_server.exe (2.31.1)
 */
export function getAntigravityDeviceProfile(connectionId, seedExtra = "") {
  const key = String(connectionId || "default-ag-connection");
  const seed = `${key}:${seedExtra}`;

  // Deterministic 64-hex machine ID (simulates sha256(MAC) expected by Clearcut / Metrics)
  const machineId = crypto.createHmac("sha256", VIRTUAL_SALT).update(seed).digest("hex");

  // Deterministic UUIDs for @vscode/deviceid and SQMClient\MachineId
  const devDeviceId = uuidv5FromBytes(`${seed}:devDeviceId`, NAMESPACE_OID);
  const sqmId = `{${uuidv5FromBytes(`${seed}:sqmId`, NAMESPACE_OID).toUpperCase()}}`;

  const ideVersion = "2.31.1";
  const cl = 1012564305; // Google Piper changelist number for 2.31.1 Go binary

  // Canonical User-Agent matching language_server.exe codeassistclient.userAgent format:
  // "%s/%s/%s (%s)" -> antigravity/hub/<ideVersion> (os_type=windows; arch=amd64; cl=<cl>; auth_method=oauth; datacollection_opt_in=false)
  const userAgent = `antigravity/hub/${ideVersion} (os_type=windows; arch=amd64; cl=${cl}; auth_method=oauth; datacollection_opt_in=false)`;

  // Canonical Protobuf ClientMetadata enum numbers:
  // IdeType: 9 (ANTIGRAVITY)
  // Platform: 5 (WINDOWS_AMD64)
  // PluginType: 2 (GEMINI)
  const clientMetadata = {
    ideType: 9,
    ideVersion,
    pluginVersion: ideVersion,
    platform: 5,
    pluginType: 2,
    ideName: "antigravity"
  };

  return {
    machineId,
    devDeviceId,
    sqmId,
    cl,
    ideVersion,
    userAgent,
    clientMetadata
  };
}
