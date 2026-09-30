#!/usr/bin/env bash
# Sets up (or updates) DocVault on an Ubuntu 22.04/24.04 server, e.g. Oracle Cloud's free ARM machine.
# Normally started by deploy/push.sh. Safe to run again: data, .env and staff accounts are kept.
set -euo pipefail
APP_DIR=/opt/docvault
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
AI_MODEL=qwen2.5vl:7b
export DEBIAN_FRONTEND=noninteractive

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

step "1/9 System updates and automatic security updates"
sudo apt-get update -y
sudo apt-get upgrade -y
sudo apt-get install -y curl rsync gnupg poppler-utils imagemagick fail2ban unattended-upgrades netfilter-persistent iptables-persistent
sudo dpkg-reconfigure -f noninteractive unattended-upgrades
sudo systemctl enable --now fail2ban   # blocks IPs that keep failing SSH logins

step "2/9 SSH: key login only, no root"
printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\n' | sudo tee /etc/ssh/sshd_config.d/10-docvault.conf >/dev/null
sudo systemctl reload ssh 2>/dev/null || sudo systemctl reload sshd

step "3/9 Firewall: only SSH (22) and web (80, 443)"
# Oracle's Ubuntu images end the INPUT chain with a REJECT rule; web ports go just before it.
for port in 80 443; do
  if ! sudo iptables -C INPUT -p tcp --dport "$port" -m state --state NEW -j ACCEPT 2>/dev/null; then
    reject=$(sudo iptables -L INPUT --line-numbers | awk '/REJECT/ {print $1; exit}')
    if [ -n "$reject" ]; then sudo iptables -I INPUT "$reject" -p tcp --dport "$port" -m state --state NEW -j ACCEPT
    else sudo iptables -A INPUT -p tcp --dport "$port" -m state --state NEW -j ACCEPT; fi
  fi
done
sudo netfilter-persistent save

step "4/9 Node.js"
if ! node -v 2>/dev/null | grep -qE '^v(2[4-9]|[3-9][0-9])\.'; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v

step "5/9 Local AI: Ollama + $AI_MODEL (listens on this server only)"
command -v ollama >/dev/null || curl -fsSL https://ollama.com/install.sh | sh
sudo systemctl enable --now ollama
ollama pull "$AI_MODEL"

step "6/9 Caddy (automatic HTTPS certificates)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y caddy
fi

step "7/9 DocVault files"
sudo useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin docvault 2>/dev/null || true
sudo mkdir -p "$APP_DIR"
sudo rsync -a --delete --exclude node_modules --exclude data --exclude backups --exclude .env --exclude 'restored-*' "$SRC_DIR/" "$APP_DIR/"
sudo mkdir -p "$APP_DIR/data" "$APP_DIR/backups"
sudo chown -R docvault:docvault "$APP_DIR"
sudo chmod 700 "$APP_DIR/data" "$APP_DIR/backups"
sudo -u docvault bash -c "cd '$APP_DIR' && npm ci --omit=dev --no-audit --no-fund"

step "8/9 Settings"
FIRST_RUN=false
if ! sudo test -f "$APP_DIR/.env"; then
  FIRST_RUN=true
  while true; do
    read -rp "Site address without https:// (e.g. docvault-yourname.duckdns.org): " DOMAIN
    [[ "$DOMAIN" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$ ]] && break
    echo "That doesn't look like a domain name. Try again."
  done
  echo "Staff pages will only open from the college network. On the college Wi-Fi, open https://ifconfig.me"
  echo "to see its public IP address. Several can be separated with commas; ranges look like 10.20.0.0/16."
  while true; do
    read -rp "College network IP address(es): " STAFF_NETS
    STAFF_NETS=${STAFF_NETS// /}
    [[ "$STAFF_NETS" =~ ^[0-9a-fA-F:.,/]+$ ]] && break
    echo "That doesn't look like IP addresses. Try again."
  done
  read -rp "Gmail address that sends DocVault emails: " SMTP_USER
  read -rsp "Gmail app password (typing is hidden): " SMTP_PASS; echo
  SMTP_PASS=${SMTP_PASS// /}
  sudo -u docvault bash -c "cd '$APP_DIR' && node scripts/setup.js" >/dev/null
  set_env() { sudo -u docvault sed -i "s|^$1=.*|$1=$2|" "$APP_DIR/.env"; }
  set_env NODE_ENV production
  set_env APP_URL "https://$DOMAIN"
  set_env SMTP_USER "$SMTP_USER"
  set_env SMTP_PASS "$SMTP_PASS"
  set_env MAIL_FROM "DocVault <$SMTP_USER>"
  echo "STAFF_ALLOWED_NETWORKS=$STAFF_NETS" | sudo -u docvault tee -a "$APP_DIR/.env" >/dev/null
  sudo chmod 600 "$APP_DIR/.env"
  printf '%s {\n\tencode gzip\n\trequest_body {\n\t\tmax_size 6MB\n\t}\n\treverse_proxy 127.0.0.1:3000\n}\n' "$DOMAIN" | sudo tee /etc/caddy/Caddyfile >/dev/null
fi
sudo systemctl reload caddy || sudo systemctl restart caddy

step "9/9 Services: DocVault, daily encrypted backup"
sudo cp "$APP_DIR/deploy/docvault.service" "$APP_DIR/deploy/docvault-backup.service" "$APP_DIR/deploy/docvault-backup.timer" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now docvault-backup.timer
sudo systemctl enable docvault
sudo systemctl restart docvault
sleep 3
code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/ || true)
if [ "$code" = 200 ]; then echo "DocVault is running."
elif [ "$code" = 503 ]; then echo "DocVault is running and LOCKED: staff unlock it at /unlock from the college network."
else echo "DocVault did not start. Recent log:"; sudo journalctl -u docvault -n 30 --no-pager; exit 1; fi

if [ "$FIRST_RUN" = true ]; then
  step "First staff account"
  sudo -u docvault bash -c "cd '$APP_DIR' && node --env-file=.env scripts/create-admin.js"
  step "Lock the encryption key with an unlock passphrase (recommended)"
  echo "The key will then never be stored on this disk. After every restart, a staff member"
  echo "unlocks DocVault at /unlock from the college network."
  read -rp "Lock the key now? [Y/n] " LOCK
  if [[ ! "$LOCK" =~ ^[Nn] ]]; then
    sudo -u docvault bash -c "cd '$APP_DIR' && node --env-file=.env scripts/protect-key.js"
    sudo systemctl restart docvault
  fi
  step "SAVE THIS SECRET somewhere safe, OFF this server (e.g. a password manager)"
  sudo grep -E '^(MASTER_KEY|BACKUP_PASSPHRASE)=' "$APP_DIR/.env"
  echo "Keep the recovery key shown above (if you locked the key) in a safe place too."
  echo "Without them, documents and backups can never be decrypted."
  echo
  SITE=$(sudo grep '^APP_URL=' "$APP_DIR/.env" | cut -d/ -f3)
  echo "Students: https://$SITE    Staff (college network only): https://$SITE/admin/login"
  if sudo test -f "$APP_DIR/data/master-key.json" && ! sudo grep -q '^MASTER_KEY=' "$APP_DIR/.env"; then
    echo "First, unlock it from the college network: https://$SITE/unlock"
  fi
else
  echo "Update installed. Data, settings and accounts were kept."
fi
