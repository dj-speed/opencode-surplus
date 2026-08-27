#!/usr/bin/env bash
#
# opencode-surplus installer
# --------------------------
# Installs both opencode plugins into your global config:
#   1. surplus-sidebar.tsx  -> ~/.config/opencode/surplus-sidebar.tsx
#      (TUI plugin: sidebar status, TPS meter, /surplus-* commands)
#   2. surplus-control.js   -> ~/.config/opencode/plugins/surplus-control.js
#      (server plugin: surplus_* agent tools, routing pins)
#
# It also adds surplus-sidebar.tsx to ~/.config/opencode/tui.json so opencode
# loads it at startup. Existing tui.json is backed up first.
#
# Usage:
#   ./install.sh          # normal install (this directory must contain the files)
#
# After running, restart opencode. See README.md for configuration.

set -euo pipefail

# Directory this script lives in (works when downloaded standalone too).
SRC="$(cd "$(dirname "$0")" && pwd)"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"

if [ ! -f "$SRC/surplus-sidebar.tsx" ]; then
  echo "error: surplus-sidebar.tsx not found next to this script" >&2
  exit 1
fi

mkdir -p "$CONFIG_DIR/plugins"

# 1. Copy the TUI plugin.
cp "$SRC/surplus-sidebar.tsx" "$CONFIG_DIR/surplus-sidebar.tsx"
echo "installed $CONFIG_DIR/surplus-sidebar.tsx"

# 2. Copy the server plugin.
if [ -f "$SRC/surplus-control.js" ]; then
  cp "$SRC/surplus-control.js" "$CONFIG_DIR/plugins/surplus-control.js"
  echo "installed $CONFIG_DIR/plugins/surplus-control.js"
else
  echo "note: surplus-control.js not found; skipping server plugin"
fi

# 3. Copy the optional model-sync script (manual model discovery).
if [ -f "$SRC/sync-models.mjs" ]; then
  cp "$SRC/sync-models.mjs" "$CONFIG_DIR/sync-models.mjs"
  echo "installed $CONFIG_DIR/sync-models.mjs"
else
  echo "note: sync-models.mjs not found; skipping"
fi

# 4. Wire the TUI plugin into tui.json (back it up first).
TUI_JSON="$CONFIG_DIR/tui.json"
if [ -f "$TUI_JSON" ]; then
  cp "$TUI_JSON" "$TUI_JSON.bak-$(date +%Y%m%d-%H%M%S)"
fi

if ! grep -q "surplus-sidebar.tsx" "$TUI_JSON" 2>/dev/null; then
  # Keep any existing keys; add the plugin entry if absent.
  python3 - "$TUI_JSON" <<'PY'
import json, sys
path = sys.argv[1]
try:
    with open(path) as f:
        data = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    data = {}
plugins = data.get("plugin")
if not isinstance(plugins, list):
    plugins = []
if "./surplus-sidebar.tsx" not in plugins:
    plugins.append("./surplus-sidebar.tsx")
data["plugin"] = plugins
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY
  echo "added surplus-sidebar.tsx to $TUI_JSON"
else
  echo "$TUI_JSON already references surplus-sidebar.tsx; leaving as-is"
fi

echo
echo "Done. Restart opencode to pick up the plugins."
echo "See README.md for the provider/auth setup and the /surplus-* commands."
