#!/usr/bin/env bash
# One-time preparation of a fresh Ubuntu or Debian VPS for the Support Ticket Tracker. Run as root; safe to repeat.
#
#   sudo ./bootstrap.sh --ssh-key "ssh-ed25519 AAAA... deploy@github-actions" [--harden-ssh]
#
# What it does:
#   - installs Docker Engine and the Compose plugin from Docker's own apt repository
#   - creates the `deploy` user (key-only login, member of the docker group) and /opt/ticket-tracker
#   - opens only SSH, 80 and 443 in the firewall (ufw)
#   - turns on automatic security updates
#   - with --harden-ssh: disables password login and root login over SSH (do this only after you have
#     checked that you can log in as the deploy user with the key)
# It does NOT create /opt/ticket-tracker/.env: that file holds the secrets and is written by you (see .env.example).
set -euo pipefail

ssh_key=""
harden=false
while [ $# -gt 0 ]; do
  case "$1" in
    --ssh-key) ssh_key="${2:?--ssh-key needs the public key}"; shift 2 ;;
    --harden-ssh) harden=true; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ "$(id -u)" = 0 ] || { echo "Run as root (sudo)." >&2; exit 1; }
[ -n "$ssh_key" ] || { echo "Pass the deploy key: --ssh-key \"ssh-ed25519 AAAA...\"" >&2; exit 2; }
case "$ssh_key" in ssh-ed25519\ *|ssh-rsa\ *|ecdsa-sha2-*) ;; *) echo "That does not look like a public SSH key." >&2; exit 2 ;; esac

# shellcheck source=/dev/null
. /etc/os-release
case "$ID" in ubuntu|debian) ;; *) echo "Only Ubuntu and Debian are supported (this is $ID)." >&2; exit 1 ;; esac

export DEBIAN_FRONTEND=noninteractive
echo "== packages"
apt-get update -y
apt-get install -y ca-certificates curl gnupg ufw unattended-upgrades

echo "== Docker Engine"
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$ID $VERSION_CODENAME stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker

echo "== deploy user"
id deploy >/dev/null 2>&1 || adduser --disabled-password --gecos "" deploy
usermod -aG docker deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
touch /home/deploy/.ssh/authorized_keys
grep -qxF "$ssh_key" /home/deploy/.ssh/authorized_keys || echo "$ssh_key" >> /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys
install -d -m 750 -o deploy -g deploy /opt/ticket-tracker

echo "== firewall"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable

echo "== automatic security updates"
dpkg-reconfigure -f noninteractive unattended-upgrades

if [ "$harden" = true ]; then
  echo "== SSH hardening"
  cat > /etc/ssh/sshd_config.d/10-ticket-tracker.conf <<'EOF'
PasswordAuthentication no
PermitRootLogin no
KbdInteractiveAuthentication no
EOF
  sshd -t
  systemctl reload ssh 2>/dev/null || systemctl reload sshd
fi

cat <<EOF

Done. Next:
  1. As the deploy user, create /opt/ticket-tracker/.env from .env.example (chmod 600).
  2. Point the DNS name (DOMAIN) at this server.
  3. Add the GitHub secrets VPS_HOST, VPS_USER (deploy), VPS_SSH_KEY and VPS_HOST_KEY and run the deploy workflow.
Host key to pin as VPS_HOST_KEY (run this on your computer):  ssh-keyscan -t ed25519 <this server's address>
EOF
