#!/bin/bash
# Kontrola před nasazením (spouští ji deploy.sh, jde i ručně): syntaxe všech JS a shellu, start serveru nanečisto
# s prázdnou databází a základní API, vykreslení všech pohledů UI bez prohlížeče. Když cokoli selže, nasazení se neprovede.
set -e
cd "$(dirname "$0")/.."
echo "1/3 syntaxe"
for f in server.js lib/*.js public/app.js tools/*.js; do node --check "$f"; done
bash -n deploy.sh; bash -n tools/preflight.sh
echo "2/3 start serveru nanečisto"
T=$(mktemp -d); trap 'rm -rf "$T"; [ -n "$SP" ] && kill $SP 2>/dev/null; true' EXIT
PORT=28999 DATA_DIR="$T" MTU_PASSWORD=preflight-heslo MTU_ADMIN_USER=preflight MTU_SECRET=preflight-secret-1234567890 MTU_SCAN_HOURS=0 \
  node server.js > "$T/server.log" 2>&1 & SP=$!
for i in $(seq 1 40); do curl -s -o /dev/null http://127.0.0.1:28999/mikrotik/ && break; sleep 0.25; done
curl -s -o /dev/null http://127.0.0.1:28999/mikrotik/ || { echo "server nenaběhl:"; cat "$T/server.log"; exit 1; }
J="$T/cj"
curl -s -c "$J" -H 'content-type: application/json' -d '{"username":"preflight","password":"preflight-heslo"}' http://127.0.0.1:28999/mikrotik/api/login | grep -q '"ok":true' || { echo "login selhal"; cat "$T/server.log"; exit 1; }
for p in /api/whoami /api/state /api/stats /api/settings /api/jobs /api/rules /api/users /api/busy; do
  code=$(curl -s -o "$T/out" -w '%{http_code}' -b "$J" "http://127.0.0.1:28999/mikrotik$p")
  [ "$code" = 200 ] || { echo "API $p → HTTP $code"; head -c 300 "$T/out"; echo; cat "$T/server.log"; exit 1; }
done
curl -s -X PUT -b "$J" -H 'content-type: application/json' -d '{"min_uptime_min":11}' http://127.0.0.1:28999/mikrotik/api/settings/mine | grep -q '"min_uptime_min":11' || { echo "uložení nastavení selhalo"; exit 1; }
grep -iE "error|TypeError|ReferenceError" "$T/server.log" | grep -v ExperimentalWarning && { echo "chyby v logu serveru"; exit 1; }
echo "3/4 vykreslení UI v opravdovém DOM (jsdom) proti serveru nanečisto"
node tools/ui-real.js http://127.0.0.1:28999 preflight preflight-heslo || { echo "UI v opravdovém DOM selhalo"; exit 1; }
kill $SP 2>/dev/null; SP=
echo "4/4 vykreslení UI (náhrada DOM, všechna řazení a filtry)"
node tools/test-ssh-retry.js || { echo "kontrola opakování SSH selhala"; exit 1; }
node tools/ui-smoke.js
echo "preflight OK"
