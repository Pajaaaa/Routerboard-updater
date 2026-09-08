#!/bin/bash
# Nasazení přes ssh. Službu restartuje až ve chvíli, kdy neběží žádný job (restart by přerušil upgrade).
# Cíl se čte z deploy.env (není v gitu): DEPLOY_HOST=ssh-alias  DEPLOY_DIR=/cesta/na/serveru  DEPLOY_USER=uzivatel  DEPLOY_SERVICE=mikrotik-upgrader
set -e
cd "$(dirname "$0")"
[ -f deploy.env ] && . ./deploy.env
: "${DEPLOY_HOST:?nastav DEPLOY_HOST v deploy.env}" "${DEPLOY_DIR:?nastav DEPLOY_DIR v deploy.env}"
DEPLOY_USER=${DEPLOY_USER:-$USER}; DEPLOY_SERVICE=${DEPLOY_SERVICE:-mikrotik-upgrader}
SRC=$(basename "$PWD"); cd ..
# soubory jdou nejdřív do vedlejšího adresáře a do ostrého se přesunou až těsně před restartem služby —
# jinak by prohlížeče dostaly nové UI proti staré běžící službě („neznámé API“), když se s restartem čeká na job
STAGE="${DEPLOY_DIR}.staged"
tar czf - --exclude=node_modules --exclude=data --exclude=.git --exclude=deploy.env "$SRC" | ssh "$DEPLOY_HOST" "rm -rf '$STAGE' && mkdir -p '$STAGE' && tar xzf - -C '$STAGE' --strip-components=1 && chown -R '$DEPLOY_USER:$DEPLOY_USER' '$STAGE'"
cat > /tmp/mtu-deploy-wait.sh <<'EOS'
cd "$1" || exit 1
PORT="${4:-2820}"
# drain: běžící joby dokončí aktuální zařízení a pozastaví se (po restartu pokračují samy), nové joby se jen zařadí
curl -s -m 3 "http://127.0.0.1:$PORT/mikrotik/api/drain?on=1" >/dev/null 2>&1 || true
idle=0; ok=0
for i in $(seq 1 240); do
  n=$(node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('data/mtu.sqlite',{readOnly:true});console.log(db.prepare(\"SELECT count(*) n FROM jobs WHERE status IN ('running','waiting-window')\").get().n)" 2>/dev/null || echo 0)
  # běžící sken rozsahu / import z userdb / kontrola zařízení by restart přerušil → počkat (endpoint /api/busy, port z PORT_HINT nebo 2820)
  b=$(curl -s -m 3 "http://127.0.0.1:$PORT/mikrotik/api/busy" 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log((j.jobs||0)+(j.discovery?1:0)+(j.scanning||0))}catch{console.log(0)}})" 2>/dev/null || echo 0)
  if [ "$n" = 0 ] && [ "$b" = 0 ]; then
    # klid musí trvat dvě kontroly po sobě (5 s), aby restart nespadl do právě spuštěného skenu/importu
    idle=$((idle+1)); [ "$idle" -ge 2 ] && { ok=1; break; }; sleep 5; continue
  fi
  idle=0
  [ $i = 1 ] && echo "běží job/sken/kontrola (joby $n, aktivní $b), čekám s restartem služby…"; sleep 15
done
if [ "$ok" != 1 ]; then
  echo "za hodinu se služba neuvolnila — restart se NEPROVEDL, nové soubory zůstávají připravené v $1.staged; drain vypínám"
  curl -s -m 3 "http://127.0.0.1:$PORT/mikrotik/api/drain?on=0" >/dev/null 2>&1 || true
  exit 1
fi
# výměna souborů (data/, node_modules a deploy.env zůstávají) a restart
STAGE="$1.staged"
if [ -d "$STAGE" ]; then
  (cd "$STAGE" && find . -type f ! -path './data/*' ! -path './node_modules/*' -print0 | while IFS= read -r -d '' f; do install -D -m 644 "$f" "$1/$f"; done)
  chown -R "$3:$3" "$1" 2>/dev/null; rm -rf "$STAGE"
fi
systemctl restart "$2" && sleep 2 && systemctl is-active "$2"
EOS
ssh "$DEPLOY_HOST" 'cat > /tmp/mtu-deploy-wait.sh' < /tmp/mtu-deploy-wait.sh
ssh "$DEPLOY_HOST" "bash /tmp/mtu-deploy-wait.sh '$DEPLOY_DIR' '$DEPLOY_SERVICE' '$DEPLOY_USER' '${DEPLOY_PORT:-2820}'; rm -f /tmp/mtu-deploy-wait.sh"
