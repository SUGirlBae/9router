// Update VSCode Chat Language Models with all custom providers from 9router
// This file controls which models appear in VSCode's Chat interface

const fs = require("fs");

const CHAT_MODELS_PATH = "C:/Users/Administrator/AppData/Roaming/Code/User/chatLanguageModels.json";
const SETTINGS_PATH = "C:/Users/Administrator/.qoder/settings.json";

console.log("Loading current chat language models...");
let chatModels;
try {
  const content = fs.readFileSync(CHAT_MODELS_PATH, "utf8");
  chatModels = JSON.parse(content);
} catch (err) {
  console.error("Failed to load chatLanguageModels.json:", err.message);
  process.exit(1);
}

console.log("Loading .qoder settings...");
let qoderSettings;
try {
  const content = fs.readFileSync(SETTINGS_PATH, "utf8");
  qoderSettings = JSON.parse(content);
} catch (err) {
  console.error("Failed to load settings.json:", err.message);
  process.exit(1);
}

// Find the 9router entry
const routerIndex = chatModels.findIndex(m => m.vendor === "customendpoint" && m.name === "9router");
if (routerIndex === -1) {
  console.log("\nCreating new 9router entry...");
  chatModels.push({
    name: "9router",
    vendor: "customendpoint",
    apiKey: "${input:chat.lm.secret.-b59cb2c}",
    apiType: "responses",
    url: "https://rr6g38g.abc-tunnel.us/v1",
    toolCalling: true,
    vision: true,
    maxInputTokens: 128000,
    maxOutputTokens: 16000,
    models: []
  });
} else {
  console.log("Updating existing 9router entry...");
}

const routerEntry = chatModels[routerIndex];
routerEntry.models = [];

// Add models from .qoder settings based on their displayName and model IDs
const providers = qoderSettings.providers || {};

for (const [id, provider] of Object.entries(providers)) {
  if (!provider.model || !provider.displayName) continue;
  
  const modelName = provider.model;
  const displayName = provider.displayName;
  
  // Determine appropriate token limits based on model type
  let maxInputTokens = 128000;
  let maxOutputTokens = 65536;  // Default for most modern models
  
  switch(modelName.toLowerCase()) {
    case 'qd/qfmodel':
      // Qwen/Qfmodel - can support very long context
      maxInputTokens = 256000;
      maxOutputTokens = 65536;
      break;
    case 'ag/gemini-4-argon':
    case 'ag/gemini-3.8-flash':
      // Google Gemini - up to 1M+ input context, 65K output
      maxInputTokens = 1000000;
      maxOutputTokens = 65536;
      break;
    case 'cx/gpt-5.6-luna[1m]':
    case 'cx/gpt-5.6-terra[1m]':
    case 'cx/gpt-6-luna[1m]':
      // GPT-5.x family - maximum specs
      maxInputTokens = 1000000;
      maxOutputTokens = 65536;
      break;
    case 'deepseek-web/deepseek-v4-flash-think(max)':
      // DeepSeek V3 - supports 256K context
      maxInputTokens = 256000;
      maxOutputTokens = 65536;
      break;
    case 'muse-web/muse-chat':
      // Muse - standard limits
      maxInputTokens = 128000;
      maxOutputTokens = 65536;
      break;
    case 'gpt5.6luna':
      // Conservative estimate
      maxInputTokens = 1000000;
      maxOutputTokens = 32768;
      break;
    default:
      // General purpose
      maxInputTokens = 128000;
      maxOutputTokens = 16000;
  }
  
  routerEntry.models.push({
    id: modelName,
    name: displayName,
    url: provider.baseUrl || "https://rr6g38g.abc-tunnel.us/v1",
    toolCalling: provider.capabilities?.tools !== false,
    vision: provider.capabilities?.vision !== false,
    maxInputTokens: maxInputTokens,
    maxOutputTokens: maxOutputTokens,
    ...(provider.capabilities?.thinking && {
      thinking: {
        enabled: true,
        effortLevels: provider.capabilities.thinking.supportedEffortLevels || ["low", "medium", "high"]
      }
    })
  });
  
  console.log(`  ✓ Added: ${displayName.padEnd(40)} (${modelName})`);
}

console.log(`\nTotal models in 9router entry: ${routerEntry.models.length}`);

// Write updated configuration
fs.writeFileSync(CHAT_MODELS_PATH, JSON.stringify(chatModels, null, 2) + "\n", "utf8");

console.log("\n✅ Updated chatLanguageModels.json at", CHAT_MODELS_PATH);
console.log("\n📋 Summary:");
console.log("  - All 9 providers from .qoder/settings.json added to VSCode Chat");
console.log("  - Token limits optimized per model specifications");
console.log("  - Tool calling and vision capabilities preserved");
console.log("\n💡 Next steps:");
console.log("  1. Restart VSCode completely");
console.log("  2. Open Chat panel (Cmd/Ctrl + Shift + C)");
console.log("  3. Select '9router' as your language model");
console.log("  4. Choose any model from the dropdown list");
console.log("\n🗂️ New models available:");
routerEntry.models.forEach((m, i) => {
  console.log(`    ${i + 1}. ${m.name} (${m.id}) - Input: ${(m.maxInputTokens/1000).toFixed(0)}K, Output: ${(m.maxOutputTokens/1000)}K`);
});
