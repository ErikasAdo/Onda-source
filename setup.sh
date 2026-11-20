#!/usr/bin/env bash
# One-shot setup for Onda. Run from the project root:  bash setup.sh
set -euo pipefail

echo "▸ Installing npm dependencies…"
npm install

[ -d ios ]     || { echo "▸ Adding iOS platform…";     npx cap add ios; }
[ -d android ] || { echo "▸ Adding Android platform…"; npx cap add android; }

echo "▸ Patching native projects (background audio, foreground service permissions)…"
node scripts/patch-native.mjs

echo "▸ Syncing web assets + plugins…"
npx cap sync

cat <<'EOF'

✓ Done.

Next:
  1. Deploy the proxy (see README §3) and put its URL in  www/js/config.js
  2. npx cap open ios       → select a team under Signing & Capabilities → Run on device
     npx cap open android   → Run on device
  3. After any change in www/ :  npx cap sync
EOF
