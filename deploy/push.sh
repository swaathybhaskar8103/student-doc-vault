#!/usr/bin/env bash
# Run on your Mac, from the project folder. Copies DocVault to the server and runs the setup there.
# The first run installs everything; later runs update the code and keep all data and settings.
#
#   bash deploy/push.sh ubuntu@SERVER_IP ~/Downloads/ssh-key.key
set -euo pipefail
TARGET=${1:?"Usage: bash deploy/push.sh ubuntu@SERVER_IP [ssh-private-key-file]"}
KEY=${2:-}
SSH=(ssh)
[ -n "$KEY" ] && SSH=(ssh -i "$KEY")
cd "$(dirname "$0")/.."

echo "Copying DocVault to $TARGET (never copies data/, backups/ or .env)..."
rsync -az --delete -e "${SSH[*]}" \
  --exclude node_modules --exclude data --exclude backups --exclude .env --exclude 'restored-*' \
  ./ "$TARGET:~/docvault-src/"
"${SSH[@]}" -t "$TARGET" 'bash ~/docvault-src/deploy/setup-server.sh'
