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
  # běžící sken rozsahu / import z userdb / kontrola zařízení by restart přerušil → počkat (endpoint /api/busy, port z PORT_HINT nebo 2820)
  b=$(curl -s -m 3 "http://127.0.0.1:${3:-2820}/mikrotik/api/busy" 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log((j.jobs||0)+(j.discovery?1:0)+(j.scanning||0))}catch{console.log(0)}})" 2>/dev/null || echo 0)
  [ "$n" = 0 ] && [ "$b" = 0 ] && break
  [ $i = 1 ] && echo "běží job/sken/kontrola (joby $n, aktivní $b), čekám s restartem služby…"; sleep 15
done
systemctl restart "$2" && sleep 2 && systemctl is-active "$2"
EOS
ssh "$DEPLOY_HOST" 'cat > /tmp/mtu-deploy-wait.sh' < /tmp/mtu-deploy-wait.sh
ssh "$DEPLOY_HOST" "bash /tmp/mtu-deploy-wait.sh '$DEPLOY_DIR' '$DEPLOY_SERVICE' '${DEPLOY_PORT:-2820}'; rm -f /tmp/mtu-deploy-wait.sh"
