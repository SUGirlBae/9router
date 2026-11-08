# Add 3 Custom Providers to VSCode from 9router

> **For agentic workers:** Use superpowers:subagent-driven-development to implement tasks step by step.

**Goal:** Add 3 custom provider configurations in VSCode settings.json pointing to 9router endpoint:
1. **qd/qfmodel** - Qoder's qfmodel from 9router
2. **antigravity gemini models** - ag/gemini-4-argon and ag/gemini-3.8-flash  
3. **gpt5.6luna combo** - Optimized with max token/context window/effort settings

**Architecture:** Update `C:/Users/Administrator/.qoder/settings.json` following the existing `openai-compatible` pattern with endpoints from 9router tunnel (`https://rr6g38g.abc-tunnel.us/v1`) and API key from your request.

**Tech Stack:** JSON configuration editing (no external dependencies required)

---

## Provider Specifications

### Provider 1: qd/qfmodel
```json
{
  "baseUrl": "https://rr6g38g.abc-tunnel.us/v1",
  "apiKey": "sk-REDACTED-ROTATE-THIS-KEY",
  "type": "openai-compatible",
  "protocol": "openai-responses",
  "authType": "bearer",
  "model": "qd/qfmodel",
  "displayName": "Qoder qfmodel"
}
```

### Provider 2: Antigravity Gemini Models
Two separate model entries under same provider:
- `ag/gemini-4-argon` (context: 1M tokens)
- `ag/gemini-3.8-flash` (context: 1M tokens)

### Provider 3: gpt5.6luna Combo (Maximized Specs)
Based on existing entry + research:
- Context window: 1,000,000 tokens (max)
- Max output tokens: 8192 (max)
- Effort levels: low, medium, high, xhigh, max (all supported)
- Vision: true
- Thinking: enabled with full effort support

---

## Global Constraints
- **API key**: `sk-REDACTED-ROTATE-THIS-KEY` (provided)
- **Endpoint URL**: `https://rr6g38g.abc-tunnel.us/v1` (from 9router tunnel)
- **Protocol**: `openai-responses` (consistent with other 9router custom providers)
- **Auth type**: `bearer` (consistent pattern)
- **No restart needed**: Settings change only, client reload applies changes

---

## Tasks

### Task 1: Research and Validate Provider Specs

**Files:** Read existing 9router DB row for qd/qfmodel, antigravity docs

- [ ] **Step 1:** Verify qd/qfmodel context window and capabilities from 9router telemetry
  ```bash
  node -e "const D=require('C:/Users/Administrator/AppData/Roaming/npm/node_modules/better-sqlite3'); const db=new D('C:/Users/Administrator/AppData/Roaming/9router/db/data.sqlite',{readonly:true}); console.log(db.prepare(\"select data from kv where key='qd|qfmodel|llm'\").get().data);" | node -p
  ```

- [ ] **Step 2:** Check what specs are available for ag/gemini models from antigravity documentation or prior knowledge

- [ ] **Step 3:** Extract current gpt5.6luna combo specifications from 9router combos table (if exists in DB):
  ```bash
  node -e "const D=require('C:/Users/Administrator/AppData/Roaming/npm/node_modules/better-sqlite3'); const db=new D('C:/Users/Administrator/AppData/Roaming/9router/db/data.sqlite',{readonly:true}); const rows=db.prepare(\"select id,name,models from combos where name like '%gpt%' or name like '%luna%'\").all(); console.log(JSON.stringify(rows,null,2));"
  ```

- [ ] **Step 4:** Determine optimal context windows, max tokens, and effort levels based on upstream provider docs (Antigravity, Google Gemini, etc.)

### Task 2: Draft Configuration File

**Files:** Create `settings-providers-backup.json`

- [ ] **Step 1:** Backup current `settings.json`:
  ```bash
  copy "C:\Users\Administrator\.qoder\settings.json" "C:\Users\Administrator\.qoder\settings-providers-backup.json"
  ```

- [ ] **Step 2:** Create new provider entries as JSON objects for each of the 3 types:
  - qd/qfmodel spec block
  - antigravity gemini models block (may need 2 entries if different specs)
  - gpt5.6luna combo block with maximized specs
  
- [ ] **Step 3:** Review draft against existing patterns in `settings.json` to ensure consistency

### Task 3: Apply New Providers to settings.json

**Files:** Modify `C:/Users/Administrator/.qoder/settings.json`

- [ ] **Step 1:** Insert new provider entries with unique IDs following UUID pattern used by existing entries:
  - Generate UUIDs for qd/qfmodel
  - Generate UUIDs for antigravity gemini (could be 1 or 2 entries)
  - Generate UUID for gpt5.6luna combo
  
- [ ] **Step 2:** Ensure all fields follow existing structure:
  - apiKey, authType, baseUrl consistent across all
  - protocol: "openai-responses" (or "openai" if specified)
  - displayName: clear, readable names
  
- [ ] **Step 3:** Validate JSON syntax after modification
  ```bash
  node -e "JSON.parse(require('fs').readFileSync('C:/Users/Administrator/.qoder/settings.json','utf8')); console.log('Valid JSON')"
  ```

### Task 4: Verification and Testing

**Files:** None

- [ ] **Step 1:** Reload VSCode to pick up new providers
- [ ] **Step 2:** Verify 3 new providers appear in VSCode provider selector
- [ ] **Step 3:** Test qd/qfmodel with simple prompt
- [ ] **Step 4:** Test antigravity gemini models
- [ ] **Step 5:** Test gpt5.6luna combo with max tokens/effort settings
- [ ] **Step 6:** Record any errors in a test log

### Task 5: Documentation and Rollback Notes

**Files:** Create `ADD-PROVIDERS-NOTES.md`

- [ ] **Step 1:** Document exact provider specifications used
- [ ] **Step 2:** Note any issues encountered during setup
- [ ] **Step 3:** Provide rollback instructions (restore backup file)
- [ ] **Step 4:** Document which model has which context window and max tokens

---

## Expected Results

After completion:
1. VSCode shows 3 new custom providers from 9router
2. All providers point to `https://rr6g38g.abc-tunnel.us/v1` 
3. API key properly configured
4. gpt5.6luna combo uses maximum specifications from upstream docs
5. No errors when selecting or using new providers

---

## Rollback

If issues occur:
1. Close VSCode
2. Restore: `copy /Y "C:\Users\Administrator\.qoder\settings-providers-backup.json" "C:\Users\Administrator\.qoder\settings.json"`
3. Reopen VSCode
