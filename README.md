# MikroTik upgrader

Webový nástroj pro bezpečný hromadný upgrade MikroTik RouterOS a RouterBOOT v komunitní síti (vznikl pro HKFree).
Zařízení se načtou z evidence sítě (userdb) nebo skenem, nástroj je zkontroluje, sestaví z nich topologii
(kdo koho napájí a připojuje) a v jobech je **jedno po druhém, od antén k páteři** upgraduje na nejnovější verzi
svého tracku (v7 stable / v7 long-term / v6 long-term / hold).

Repozitář je veřejný: **neobsahuje žádná hesla, klíče ani adresy konkrétní sítě.** Vše, co je specifické pro
nasazení, se zadává přes proměnné prostředí (`env.example`) a v nastavení aplikace.

## Hlavní vlastnosti

- **Bezpečný postup pro každé zařízení:** záloha (export + binární), volitelný preventivní restart při dlouhém
  uptime, nahrání balíčků přes SFTP, ověření názvu a velikosti na routeru, restart, kontrola verze, čekání na obnovení
  bezdrátových spojů a potomků, upgrade RouterBOOT s dalším restartem. Bez ověřených balíčků se nikdy nerestartuje.
- **Topologie:** rodič se určí ze skenu (stanice → sektor podle registrace, 60 GHz protějšek, napájení z PoE portu,
  CAPsMAN, brána i na jiné IP téhož routeru), i napříč účty. Rodič podle brány je jen slabý odhad a přepíše se, jakmile
  je znám lepší; ručně nastavený rodič se nemění. Stejný kus pod více IP (podle sériového čísla) má jen jeden hlavní záznam.
- **Pořadí a zámky:** nadřazený prvek se nerestartuje, dokud jeho potomci v jobu neskončí; chyba potomka rodiče
  zablokuje. Jobů může běžet víc naráz (každý po jednom zařízení), zařízení nesmí být ve dvou jobech a před restartem
  se čeká na cizí job na sousedícím zařízení. PoE watchdog na napájecím rodiči se na dobu položky vypne.
- **Předběžná kontrola naplánovaného jobu:** hned po naplánování se zařízení zkontrolují a v detailu jobu je vidět, co
  by v době startu bránilo upgradu; kontrola se dá zopakovat a před startem proběhne znovu.
- **Verze:** x.y.0 až po 14 dnech, seznam verzí s doloženou regresí pro konkrétní hardware i obecně, hardware bez v7
  (MIPS-LE, < 64 MB RAM, smips, staré RB4xx, 32 MB kusy) cílí na poslední v6; jde povolit per zařízení.
  Podrobná rešerše rizik: `docs/reserse-bezpecny-upgrade.md`.
- **Kontroly před upgradem:** dostupnost a práva uživatele, místo ve flash a RAM (málo RAM → restart a nový pokus),
  cizí .npk/RouterBOOT soubory, vadné bloky flash a jejich trend, dynamický routing při 6→7, neovladatelný PoE prvek
  nad zařízením, druhý konec 60 GHz spoje, kvalita rádia (signál, CCQ, MCS, chybovost), vlastní restartovací skripty,
  ping-watchdog, CAPsMAN policy, SFP/PoE změny chování mezi verzemi, otisky zneužití SSH zranitelností.
- **Po restartu:** verze, balíčky, log, rozhraní a IP, spoje (stanice na stejném AP, ≥ 80 % klientů sektoru zpět,
  60 GHz MCS ≥ 1, CAP registrován), ping na bránu z routeru, sousedé, počty položek konfigurace proti stavu před upgradem.
- **Nastavení per uživatel:** společné hodnoty nastavuje správce, každý si je může přepsat pro své joby, kontroly a plány.
- **Volitelná hardening:** `/ip service` (vypnutí nepotřebných služeb, povolené adresy; ssh se nikdy nevypne a adresy
  se použijí jen když obsahují IP serveru) a vzdálené logování na syslog. Mění se jen odchylky.
- **Účty:** přihlášení přes OpenID Connect (SSO). Každý vidí jen svá zařízení, správce vše. Účet se při prvním
  přihlášení naváže podle e-mailu na správce oblasti v userdb.
- **Import z userdb:** v dialogu „Přidat zařízení (sken)“ tlačítko „Natáhnout z userdb“ → tabulka oblastí a APček
  → import zařízení APček i zařízení členů pod nimi včetně loginů. Typ zařízení z evidence se ignoruje, co je RouterOS
  rozhodne sken po SSH. Správce může natáhnout celou síť; zařízení připadnou účtům správců oblastí (založí se dopředu
  podle e-mailu). Ruční sken (seznam `ip uživatel heslo` nebo rozsahy) zůstává.
- **Obnova mrtvého zařízení:** postup v nápovědě (záložní bootloader → Netinstall se stejnou verzí jako záloha →
  obnova z binární zálohy nebo exportu; od 7.24 Netinstall ze sousedního MikroTiku).

## Stack

Node.js 22 (`node:sqlite`, bez build kroku), jediná závislost `ssh2`. Hesla routerů jsou v DB šifrovaná
(AES-256-GCM, klíč `MTU_SECRET`). Session je podepsaná cookie, uživatel se ověřuje z DB při každém požadavku.
Živé události přes SSE.

```
server.js          HTTP API, statika, SSE, účty, import z userdb
lib/ros.js         SSH/SFTP klient pro RouterOS (v6 i v7), timeouty, přerušení přenosu
lib/inspect.js     zjištění stavu zařízení (jen čtení)
lib/planner.js     plán hopů a balíčků, blokátory a varování, seznamy rizikových verzí a HW
lib/runner.js      job engine (kontrola → záloha → staging → ověření → restart → ověření → firmware), zámky
lib/scanner.js     kontrola zařízení (po načtení, ručně, před jobem; žádný plošný periodický sken), duplicity podle sériového čísla
lib/topology.js    určení rodiče (rádio, PoE, CAPsMAN, brána)
lib/discovery.js   sken adres a rozsahů ve frontě (víc uživatelů naráz), zakládání zařízení
lib/userdb.js      klient evidence sítě (oblasti, správci, zařízení APček, loginy)
lib/sso.js         OpenID Connect (authorization code + PKCE)
lib/versions.js    verze z upgrade.mikrotik.com, katalog a cache balíčků
lib/db.js          SQLite schéma a přístup k datům
public/            UI (vanilla JS, bez buildu)
tools/userdb-who.js  ověření, komu v userdb patří které oblasti a zařízení
docs/              rešerše rizik upgradu
```

## Nasazení

- Node.js 22+, `npm install --omit=dev --omit=optional` (jsdom je jen vývojová závislost pro preflight), proměnné podle `env.example` (šifrovací klíč, veřejná URL, SSO klient,
  klíč do userdb). Přihlášení heslem lze omezit jen na localhost nebo vypnout (`MTU_PASSWORD_LOGIN`).
- Služba `mikrotik-upgrader.service` (uprav cesty a uživatele), port 2820 jen na 127.0.0.1.
- Reverse proxy (nginx) `location /mikrotik/` → `http://127.0.0.1:2820/mikrotik/`, `proxy_buffering off` kvůli SSE,
  hlavička `X-Forwarded-For`.
- Data (DB, zálohy, cache balíčků) v `data/`, nejsou v gitu. Server musí mít přístup na routery přes SSH,
  na download.mikrotik.com a na userdb.
- Před každým nasazením běží `tools/preflight.sh`: syntaxe všech souborů, start serveru nanečisto s prázdnou databází a
  průchod základního API, vykreslení všech pohledů UI v opravdovém DOM (jsdom, `tools/ui-real.js`: správce i uživatel, s heslem
  i jen SSO, kontrola klíčových prvků) a s náhradou DOM přes všechna řazení a filtry (`tools/ui-smoke.js`). Při chybě se nic nenasadí.
- `deploy.sh [drain|quiet|static]` nasazuje za provozu (`static` = jen webové soubory bez restartu (`quiet` = nikoho neomezuje, čeká až 4 h na chvíli bez jobů): soubory nahraje do vedlejšího adresáře, v režimu drain zapne *drain* (`/api/drain`, jen z
  localhostu): běžící joby dokončí aktuální zařízení a pozastaví se, nové se jen zařadí. Až neběží žádný job, sken ani
  import (`/api/busy`, dvě klidové kontroly po sobě), vymění soubory a restartuje službu; pozastavené joby po startu
  samy pokračují. Když se služba do hodiny neuvolní, restart se neprovede a drain se vypne. Tvrdý restart uprostřed jobu
  (výpadek) job pozastaví a rozpracovaná položka dostane stav „neznámý“.

## Co v repu není a nikdy nemá být

Hesla a klíče (env, `deploy.env`, `.env`), databáze a zálohy (`data/`), konkrétní adresy sítě (`public/local.js`, vzor `public/local.example.js`). Příklady v UI berou
prefix sítě z `MTU_NET_HINT`, výchozí je dokumentační rozsah. Skenovat a přidávat jde jen adresy z `MTU_SCAN_ALLOW` (výchozí privátní rozsahy),
aby server nešel zneužít jako skener cizích sítí.
