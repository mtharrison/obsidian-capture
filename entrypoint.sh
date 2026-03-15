#!/bin/sh
set -e

APP_ROOT="${APP_ROOT:-/app}"
ENV_FILE="${ENV_FILE:-$APP_ROOT/.env}"

if [ -f "$ENV_FILE" ]; then
  set -a
  . "$ENV_FILE"
  set +a
fi

APP_ROOT="${APP_ROOT:-/app}"
CONFIG_PATH="${CONFIG_PATH:-/data/config}"
VAULT_PATH="${VAULT_PATH:-/data/vault}"
SYNC_STATE_FILE="${SYNC_STATE_FILE:-$VAULT_PATH/.obsidian-sync.json}"

# Ensure ob credentials persist on the volume across deploys.
# obsidian-headless stores auth in ~/.config — symlink to volume.
mkdir -p "$CONFIG_PATH"

# Symlink ~/.config to the persistent volume
if [ "$(readlink /root/.config 2>/dev/null || true)" != "$CONFIG_PATH" ]; then
  rm -rf /root/.config
  ln -s "$CONFIG_PATH" /root/.config
fi

# If vault isn't set up yet, just start the webhook (sync will fail gracefully)
if [ ! -f "$SYNC_STATE_FILE" ]; then
  echo "==================================================="
  echo "  Vault not set up yet. Open a shell in the running environment."
  echo "  Then:"
  echo "    cd $APP_ROOT && npx ob login"
  echo "    npx ob sync-list-remote"
  echo "    cd $VAULT_PATH && npx --prefix $APP_ROOT ob sync-setup --vault 'YOUR_VAULT_NAME'"
  echo "    npx --prefix $APP_ROOT ob sync"
  echo "==================================================="
fi

cd "$APP_ROOT"
exec node server.js
