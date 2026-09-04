#!/bin/bash
# Nasazení přes ssh. Službu restartuje až ve chvíli, kdy neběží žádný job (restart by přerušil upgrade).
# Cíl se čte z deploy.env (není v gitu): DEPLOY_HOST=ssh-alias  DEPLOY_DIR=/cesta/na/serveru  DEPLOY_USER=uzivatel  DEPLOY_SERVICE=mikrotik-upgrader
set -e
cd "$(dirname "$0")"
[ -f deploy.env ] && . ./deploy.env
: "${DEPLOY_HOST:?nastav DEPLOY_HOST v deploy.env}" "${DEPLOY_DIR:?nastav DEPLOY_DIR v deploy.env}"
DEPLOY_USER=${DEPLOY_USER:-$USER}; DEPLOY_SERVICE=${DEPLOY_SERVICE:-mikrotik-upgrader}
SRC=$(basename "$PWD"); cd ..
tar czf - --exclude=node_modules --exclude=data --exclude=.git --exclude=deploy.env "$SRC" | ssh "$DEPLOY_HOST" "tar xzf - -C '$(dirname "$DEPLOY_DIR")' && chown -R '$DEPLOY_USER:$DEPLOY_USER' '$DEPLOY_DIR'"
cat > /tmp/mtu-deploy-wait.sh <<'EOS'
cd "$1" || exit 1
for i in $(seq 1 120); do
  n=$(node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('data/mtu.sqlite',{readOnly:true});console.log(db.prepare(\"SELECT count(*) n FROM jobs WHERE status IN ('running','waiting-window')\").get().n)" 2>/dev/null || echo 0)
  [ "$n" = 0 ] && break
  [ $i = 1 ] && echo "běží job, čekám s restartem služby…"; sleep 30
done
systemctl restart "$2" && sleep 2 && systemctl is-active "$2"
EOS
ssh "$DEPLOY_HOST" 'cat > /tmp/mtu-deploy-wait.sh' < /tmp/mtu-deploy-wait.sh
ssh "$DEPLOY_HOST" "bash /tmp/mtu-deploy-wait.sh '$DEPLOY_DIR' '$DEPLOY_SERVICE'; rm -f /tmp/mtu-deploy-wait.sh"
