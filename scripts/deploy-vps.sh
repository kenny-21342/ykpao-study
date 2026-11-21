#!/usr/bin/env bash
# Deploy the working tree to the RackNerd VPS as a new release, with automatic rollback.
#
#   scripts/deploy-vps.sh              # sync, build on the VPS, switch, health-check
#   scripts/deploy-vps.sh --migrate    # also run `prisma migrate deploy` before the switch
#   scripts/deploy-vps.sh --rollback   # point `current` back at the previous release
#
# Layout on the VPS:  /srv/app/releases/<id>/   one directory per deploy (last 3 kept)
#                     /srv/app/current          symlink to the live release
#                     /srv/app/shared/.env      secrets, never touched by a deploy
#
# Built on the VPS, not on the Mac: native modules differ (Mac arm64 vs Linux x64).
# node_modules is hard-linked from the live release and reinstalled only when
# package-lock.json changed, so most deploys take under a minute.
set -euo pipefail

HOST="${DEPLOY_HOST:-root@23.94.104.43}"
BASE=/srv/app
KEEP=3
cd "$(dirname "$0")/.."

ssh_() { ssh -o ConnectTimeout=15 "$HOST" "$@"; }

health() { # $1 = seconds to wait
  ssh_ "for i in \$(seq 1 $1); do c=\$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3000/ || true); case \$c in 200|301|302|307|308) echo \"healthy (HTTP \$c)\"; exit 0;; esac; sleep 1; done; echo \"unhealthy (last HTTP \$c)\"; exit 1"
}

if [[ "${1:-}" == "--rollback" ]]; then
  prev=$(ssh_ "cd $BASE/releases && cur=\$(basename \$(readlink $BASE/current)) && ls -1t | grep -v \"^\$cur\$\" | head -1")
  [[ -n "$prev" ]] || { echo "no previous release to roll back to"; exit 1; }
  echo "rolling back to $prev"
  ssh_ "ln -sfn $BASE/releases/$prev $BASE/current && systemctl restart ykpao"
  health 30
  exit 0
fi

MIGRATE=0
[[ "${1:-}" == "--migrate" ]] && MIGRATE=1

SHA=$(git rev-parse --short HEAD)
DIRTY=""
[[ -n "$(git status --porcelain -- . ':!logs' ':!pdf_extraction')" ]] && DIRTY="-dirty"
REL="$(date -u +%Y%m%d%H%M%S)-${SHA}${DIRTY}"
echo "release $REL"

PREV=$(ssh_ "readlink $BASE/current")
echo "live now: $PREV"

# Start from the live release (hard links) so unchanged files and node_modules cost nothing.
# rsync writes a temp file and renames, so it never modifies a hard-linked file in place.
ssh_ "cp -al $PREV $BASE/releases/$REL && rm -rf $BASE/releases/$REL/.next"

rsync -az --delete --partial \
  --include='ops/' --include='ops/syllabus/***' --exclude='ops/*' \
  --exclude='.git/' --exclude='node_modules/' --exclude='.next/' --exclude='pdf_extraction/' \
  --exclude='backups/' --exclude='logs/' --exclude='papers.db' --exclude='public/bank_assets/' \
  --exclude='public/extracted_images/' --exclude='public/step-images/' --exclude='public/uploads/' \
  --exclude='gold-set/' --exclude='generated/' --exclude='.env*' --exclude='*.tsbuildinfo' \
  --exclude='.vercel/' --exclude='e2e/' --exclude='data/' --exclude='docs/' --exclude='design/' \
  --exclude='tests/' --exclude='.venv-bank/' --exclude='.DS_Store' \
  ./ "$HOST:$BASE/releases/$REL/"

# Reinstall dependencies only if the lockfile moved.
NEED_INSTALL=$(ssh_ "cmp -s $BASE/releases/$REL/package-lock.json $PREV/package-lock.json && echo no || echo yes")
# A release built from a changed lockfile must not share node_modules inodes with the live one.
ssh_ "set -e; cd $BASE/releases/$REL
  if [ '$NEED_INSTALL' = yes ]; then echo 'lockfile changed: npm ci'; rm -rf node_modules; npm ci --ignore-scripts --no-audit --no-fund; fi
  set -a; . $BASE/shared/.env; set +a
  npx prisma generate >/dev/null
  NODE_OPTIONS=--max-old-space-size=1800 NEXT_TELEMETRY_DISABLED=1 npx next build 2>&1 | tail -15
  chown -R app:app $BASE/releases/$REL"

if [[ $MIGRATE -eq 1 ]]; then
  echo "applying migrations"
  ssh_ "cd $BASE/releases/$REL && set -a && . $BASE/shared/.env && set +a && npx prisma migrate deploy"
fi

echo "switching"
ssh_ "ln -sfn $BASE/releases/$REL $BASE/current && systemctl restart ykpao"
if ! health 45; then
  echo "health check failed: rolling back to $PREV"
  ssh_ "ln -sfn $PREV $BASE/current && systemctl restart ykpao"
  health 30 || true
  exit 1
fi

# Keep the newest $KEEP releases (never the live one).
ssh_ "cd $BASE/releases && cur=\$(basename \$(readlink $BASE/current)) && ls -1t | grep -v \"^\$cur\$\" | tail -n +$KEEP | xargs -r rm -rf"
echo "deployed $REL"
