#!/usr/bin/env bash
#
# opencode-surplus installer (OpenCode V2)
# ----------------------------------------
# Installs the plugin directory into your global OpenCode config:
#   surplus/  -> ~/.config/opencode/plugins/surplus/
#     index.js    server part: models, pricing, floors, pins, agent tools, RPC
#     tui.tsx     TUI part: TPS meter, sidebar blocks, /surplus-* commands
#     rpc.js      RPC contract shared by both parts
#     catalog.js  catalog discovery + cache (also used by sync-models.mjs)
#
# OpenCode V2 discovers plugin directories under ~/.config/opencode/plugins/
# automatically; no config entry is needed. Changes apply without a restart.
#
# The V1 single-file plugins (plugins/surplus-control.js, surplus-sidebar.tsx)
# do not run in V2; if found, they are moved into a timestamped backup folder.
#
# Usage:  ./install.sh

set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
DEST="$CONFIG_DIR/plugins/surplus"
FILES=(index.js tui.tsx rpc.js catalog.js)

for f in "${FILES[@]}"; do
  if [ ! -f "$SRC/surplus/$f" ]; then
    echo "error: surplus/$f not found next to this script" >&2
    exit 1
  fi
done

mkdir -p "$DEST"
for f in "${FILES[@]}"; do
  cp "$SRC/surplus/$f" "$DEST/$f"
done
echo "installed $DEST/ ($(IFS=,; echo "${FILES[*]}"))"

# Move V1 leftovers out of the plugin search path.
BACKUP=""
for legacy in "$CONFIG_DIR/plugins/surplus-control.js" "$CONFIG_DIR/surplus-sidebar.tsx"; do
  if [ -f "$legacy" ]; then
    [ -n "$BACKUP" ] || { BACKUP="$CONFIG_DIR/surplus-v1-backup-$(date +%Y%m%d-%H%M%S)"; mkdir -p "$BACKUP"; }
    mv "$legacy" "$BACKUP/"
    echo "moved V1 file $(basename "$legacy") -> $BACKUP/"
  fi
done

# Seed the model catalog so the picker is populated right away.
if command -v node >/dev/null 2>&1; then
  node "$SRC/sync-models.mjs" || echo "note: catalog seed failed; the plugin retries in the background"
fi

cat <<'EOF'

Done. If you have not yet, add the provider to ~/.config/opencode/opencode.jsonc:

  "providers": {
    "surplus-intelligence": {
      "name": "Surplus Intelligence",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": { "baseURL": "https://api.surplusintelligence.ai/v1" }
    }
  }

then connect your API key with /connect (provider "surplus-intelligence").
See README.md for the /surplus-* commands and options.
EOF
