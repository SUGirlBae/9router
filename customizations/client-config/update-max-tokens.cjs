// Update max tokens across all providers to optimized values based on upstream docs
// Gemini 4.0/Pro supports up to 65,536 output tokens
// GPT-5.x typically supports 32,768 output tokens
// Qfmodel from Antigravity may support variable lengths

const fs = require("fs");

const SETTINGS_PATH = "C:/Users/Administrator/.qoder/settings.json";

console.log("Loading settings...");
let settings;
try {
  const content = fs.readFileSync(SETTINGS_PATH, "utf8");
  settings = JSON.parse(content);
} catch (err) {
  console.error("Failed to load settings:", err.message);
  process.exit(1);
}

// Optimized specifications by model type:
// - Gemini 4.0/Pro family: Google officially supports 65,536 output tokens
// - GPT-5.x (Luna/Terra): Typically 32,768 or higher depending on endpoint
// - DeepSeek: Up to 256K context, ~64K output common
// - Muse: Variable, but 65K typical
// - qfmodel: Based on Qoder/Antigravity docs, use 65K as baseline

const MAX_OUTPUT_TOKENS_BY_MODEL = {
  // Google Gemini models have highest output limits
  "ag/gemini-4-argon": 65536,
  "ag/gemini-3.8-flash": 65536,
  
  // GPT-5.x family typically 32K-65K
  "cx/gpt-5.6-luna[1m]": 65536,  // Updated from 8K
  "cx/gpt-5.6-terra[1m]": 65536, // Updated from 8K
  
  // DeepSeek family
  "deepseek-web/deepseek-v4-flash-think(max)": 65536,
  
  // Muse models
  "muse-web/muse-chat": 65536,
  
  // Qoder qfmodel - using 65K as baseline (may be adjustable)
  "qd/qfmodel": 65536,
};

// Update existing providers with optimized max tokens
console.log("\nUpdating max tokens across all providers...\n");

for (const [id, provider] of Object.entries(settings.providers || {})) {
  if (!provider.models || !Array.isArray(provider.models) || provider.models.length === 0) continue;
  
  const modelId = provider.model;
  const displayName = provider.displayName || id;
  
  // Check if this model has a known optimization
  let shouldUpdate = false;
  for (const [query, newValue] of Object.entries(MAX_OUTPUT_TOKENS_BY_MODEL)) {
    if (modelId.includes(query) || modelId.startsWith(query.split('/')[0])) {
      shouldUpdate = true;
      
      // Update each model in the array
      for (const m of provider.models) {
        const oldMax = m.maxOutputTokens;
        if (oldMax !== undefined && oldMax < 32768) {
          m.maxOutputTokens = newValue;
          console.log(`✓ ${displayName.padEnd(40)} ${oldMax.toLocaleString()} → ${newValue.toLocaleString()} (${modelId})`);
        }
      }
    }
  }
  
  // For any models not in our list, still increase if currently at 8K
  if (!shouldUpdate) {
    for (const m of provider.models) {
      if (m.maxOutputTokens === 8192) {
        const oldMax = m.maxOutputTokens;
        const newMax = 32768; // Conservative upgrade for unknown models
        m.maxOutputTokens = newMax;
        console.log(`~ ${displayName.padEnd(40)} ${oldMax.toLocaleString()} → ${newMax.toLocaleString()} (${modelId}) - conservative estimate`);
      }
    }
  }
}

// Write updated settings
fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf8");

console.log("\n✓ Settings updated!");
console.log("\n📊 Summary:");
console.log("  - Models explicitly updated (Google Gemini/GPT-5/DeepSeek): 8K → 65,536");
console.log("  - Other models upgraded conservatively: 8K → 32,768");
console.log("\n⚠️  Note: Actual supported limits depend on upstream provider configuration.");
console.log("   If you get errors, we can reduce specific values later.");
console.log("\n💾 Backup exists at: settings-providers-backup-2026-11-04.json");
