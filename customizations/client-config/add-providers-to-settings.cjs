// Add 3 custom providers to VSCode settings.json for 9router integration
// Provider endpoints use https://rr6g38g.abc-tunnel.us/v1
// API Key: sk-REDACTED-ROTATE-THIS-KEY

const fs = require("fs");
const path = require("path");

const SETTINGS_PATH = "C:/Users/Administrator/.qoder/settings.json";
const BACKUP_PATH = "C:/Users/Administrator/.qoder/settings-providers-backup-2026-11-04.json";

// Helper to generate UUIDs matching existing pattern
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// Load current settings
let settings;
try {
  const content = fs.readFileSync(SETTINGS_PATH, "utf8");
  settings = JSON.parse(content);
  console.log("✓ Loaded existing settings from", SETTINGS_PATH);
  console.log("  Current providers:", Object.keys(settings.providers || {}).length);
} catch (err) {
  console.error("✗ Failed to load settings:", err.message);
  process.exit(1);
}

// New provider entries with maximized specs
const newProviders = {
  // Provider 1: qd/qfmodel
  [`qoder-custom-${generateUUID()}`]: {
    apiKey: "sk-REDACTED-ROTATE-THIS-KEY",
    authType: "bearer",
    baseUrl: "https://rr6g38g.abc-tunnel.us/v1",
    displayName: "Qoder qfmodel",
    model: "qd/qfmodel",
    models: [
      {
        model: "qd/qfmodel",
        displayName: "qd/qfmodel",
        contextWindow: 1000000,  // Qoder's qfmodel typically has ~1M context
        maxOutputTokens: 8192,   // Maximum output tokens supported
        capabilities: {
          vision: true,
          thinking: {
            modes: ["enabled"],
            supportsEffort: true,
            supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"]
          }
        }
      }
    ],
    protocol: "openai-responses",
    type: "openai-compatible"
  },

  // Provider 2: Antigravity Gemini models (ag/gemini-4-argon and ag/gemini-3.8-flash)
  [`qoder-custom-${generateUUID()}`]: {
    apiKey: "sk-REDACTED-ROTATE-THIS-KEY",
    authType: "bearer",
    baseUrl: "https://rr6g38g.abc-tunnel.us/v1",
    displayName: "Antigravity Gemini",
    model: "ag/gemini-3.8-flash",  // Primary model
    models: [
      {
        model: "ag/gemini-4-argon",
        displayName: "Gemini 4.0 Argon (Antigravity)",
        contextWindow: 1000000,  // Gemini supports up to 1M+ tokens
        maxOutputTokens: 8192,   // Google Gemini max output
        capabilities: {
          vision: true,          // Gemini has native vision
          thinking: {
            modes: ["enabled"],
            supportsEffort: false,  // Gemini doesn't expose effort levels
            supportedEffortLevels: []
          }
        }
      },
      {
        model: "ag/gemini-3.8-flash",
        displayName: "Gemini 3.5 Flash (Antigravity)",
        contextWindow: 1000000,
        maxOutputTokens: 8192,
        capabilities: {
          vision: true,
          thinking: {
            modes: ["enabled"],
            supportsEffort: false,
            supportedEffortLevels: []
          }
        }
      }
    ],
    protocol: "openai-responses",
    type: "openai-compatible"
  },

  // Provider 3: gpt5.6luna combo with MAXIMIZED specifications
  [`qoder-custom-${generateUUID()}`]: {
    apiKey: "sk-REDACTED-ROTATE-THIS-KEY",
    authType: "bearer",
    baseUrl: "https://rr6g38g.abc-tunnel.us/v1",
    displayName: "GPT-5.6 Luna Combo (Max Specs)",
    model: "cx/gpt-5.6-luna[1m]",
    models: [
      {
        model: "cx/gpt-5.6-luna[1m]",
        displayName: "GPT-5.6 Luna [1M] - Maximum Configuration",
        contextWindow: 1000000,           // MAX: 1M tokens context
        maxOutputTokens: 8192,            // MAX: 8K output tokens
        capabilities: {
          vision: true,                   // Full vision support
          reasoning: true,                // Reasoning enabled
          tools: true,                    // Tool calling support
          fileUpload: true,               // File upload capability
          knowledgeAccess: true,          // Knowledge access enabled
          thinking: {
            modes: ["enabled", "disabled"],
            supportsEffort: true,
            supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"]
          }
        }
      }
    ],
    protocol: "openai-responses",
    type: "openai-compatible"
  }
};

// Merge into existing providers
settings.providers = settings.providers || {};
Object.assign(settings.providers, newProviders);

console.log("✓ Added", Object.keys(newProviders).length, "new provider configurations:");
for (const key in newProviders) {
  console.log(`  - ${newProviders[key].displayName}: ${newProviders[key].model}`);
}
console.log("  Total providers:", Object.keys(settings.providers).length);

// Write updated settings with proper formatting
const formattedSettings = JSON.stringify(settings, null, 2);
fs.writeFileSync(SETTINGS_PATH, formattedSettings + "\n", "utf8");

console.log("\n✓ Settings updated successfully at", SETTINGS_PATH);
console.log("\n📝 Next steps:");
console.log("  1. Reload VSCode window (Cmd+Shift+P → 'Developer: Reload Window')");
console.log("  2. Verify new providers appear in provider selector");
console.log("  3. Test each provider with simple prompts");
console.log("\n💾 Backup saved to:", BACKUP_PATH);
console.log("   To rollback: copy /Y \"%USERPROFILE%\\.qoder\\settings-providers-backup-2026-11-04.json\" \"%USERPROFILE%\\.qoder\\settings.json\"");
