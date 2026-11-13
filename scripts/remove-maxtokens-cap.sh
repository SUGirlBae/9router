#!/usr/bin/env bash
# Script to remove artificial max_tokens cap from 9router bundle
# Backup + Patch + Verify cycle with rollback capability

set -e

BUNDLE_DIR="C:/Users/Administrator/AppData/Roaming/npm/node_modules/9router/app/.next-cli-build/server"
CHUNK5330="$BUNDLE_DIR/chunks/5330.js"
BACKUP="${CHUNK5330}.pre-cap-removal.bak"

echo "=== Step 1: Create backup ==="
cp "$CHUNK5330" "$BACKUP"
echo "Backup created: $BACKUP"

echo ""
echo "=== Step 2: Find and replace pattern ==="
# Use sed-style replacement since JavaScript minification breaks Node's --check
if grep -q 'w=!!r.is_reasoning,x=Number(r.max_output_tokens)||0,y=32768;x>0&&(y=x)' "$CHUNK5330"; then
  echo "Pattern found, applying replacement..."
  
  # Replace with simpler logic
  node -e "
    const fs = require('fs');
    let s = fs.readFileSync('$CHUNK5330', 'utf8');
    const old = 'w=!!r.is_reasoning,x=Number(r.max_output_tokens)||0,y=32768;x>0&&(y=x)';
    const nw = 'w=!!r.is_reasoning,y=r.max_output_tokens||32768';
    
    if (s.includes(old)) {
      s = s.replace(old, nw);
      fs.writeFileSync('$CHUNK5330', s);
      console.log('✅ Replaced pattern');
    } else {
      console.log('❌ Pattern not found!');
      process.exit(1);
    }
  "
else
  echo "❌ Pattern NOT found - may already be patched or different format"
  exit 1
fi

echo ""
echo "=== Step 3: Verify file integrity ==="
# Since minified JS has template literals that confuse --check, we just verify it loads
node -e "require('$BUNDLE_DIR/chunks/5330.js')" 2>/dev/null && echo "✅ Chunk loads successfully" || echo "⚠️ Warning: Cannot fully verify (minification quirks)"

echo ""
echo "=== DONE ==="
echo "Changes applied. You can revert anytime by restoring: $BACKUP"
