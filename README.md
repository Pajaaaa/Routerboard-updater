# MikroTik upgrader

Webový nástroj pro bezpečný hromadný upgrade MikroTik RouterOS (neveřejný, za heslem).
Zařízení se zadají (IP, login, heslo), nástroj je skenuje (verze, model, místo, firmware…) a v jobech
je postupně, **jedno po druhém**, upgraduje na nejnovější verzi podle tracku (v7 stable / v7 long-term / v6 long-term / hold).

## Bezpečnostní principy

- **Sken jen čte.** Data se berou přes `:put [... get ...]`, nic se nemění.
- **Sériově.** V jednu chvíli se upgraduje jediné zařízení; před každým krokem se znovu zjistí živý stav a přepočítá plán.
- **Nikdy downgrade.** Cíl nižší než aktuální verze = přeskočeno.
- **Hopy.** v6.x → nejnovější v6 long-term → v7 (režim upload rovnou na cíl s explicitním `wireless` balíčkem; režim router přes kanály long-term → upgrade (7.12.x) → stable).
- **Blokátory** (nic se nespustí): nečitelná verze, nízký uptime, málo RAM, cizí `.npk` v kořeni, rozpracovaný download updateru,
  změněný SSH host key, chybějící balíček pro architekturu, nedostatek místa (mimo 16MB zařízení, kde se upload zkusí a při selhání se uklidí),
  dynamický routing (BGP/OSPF/filtry/MPLS) při 6→7 bez explicitního povolení, wifiwave2 → 7.13+.
- **Záloha před každým hopem:** `/export show-sensitive` (vždy, přes stdout) + `/system backup` (SFTP). Ukládá se na server do `data/backups/<id>/`.
- **Ověření před restartem:** balíčky se stahují z download.mikrotik.com na server (kontrola velikosti), nahrají přes SFTP
  (fallback `/tool fetch` z tohoto webu s jednorázovým tokenem) a na routeru se ověří název + velikost + že tam není žádný jiný `.npk`.
  Bez úspěšného ověření se **nerestartuje** a nahrané soubory se smažou.
- **Nic nevisí navždy:** každý SSH příkaz má timeout, SFTP přenos se přeruší po 2 min bez postupu (nebo 30 min celkem), pád spojení
  uprostřed operace ji hned ukončí chybou, „Zrušit"/„Přeskočit" přeruší i rozběhnutý přenos a watchdog runneru zabije spojení po 30 min
  bez aktivity. Po přerušeném uploadu se tool znovu připojí a částečně nahraný `.npk` z routeru smaže.
- **Po restartu:** čeká se na výpadek a návrat (timeout v nastavení), ověří se identita/sériové číslo, verze, rozhraní, IP adresy, bezdrát.
  Pak volitelně `/system routerboard upgrade` (přes dočasný skript, bez interaktivního dotazu) + další restart + ověření.
- **Služby routeru:** volitelně (Nastavení) při ostrém běhu `/ip service`: služby mimo seznam vypnout, všem nastavit povolené adresy.
  ssh se nikdy nevypne, adresy se použijí jen když obsahují i IP serveru (ochrana proti zamknutí); mění se jen odchylky, dry run jen vypíše.
- **Vzdálené logování:** volitelně (Nastavení) při ostrém běhu `/system logging action` target=remote + pravidlo pro každé téma; přidá jen, co chybí.
- **Stop při chybě** (výchozí), **dry run** (jen plán), **kanárci** (první kus od každého modelu, pak čekání na potvrzení), **servisní okno**, pauza mezi zařízeními.
- Restart serveru uprostřed jobu → job se pozastaví, rozpracovaná položka dostane stav „neznámý" (nutný sken).

## Topologie a pořadí

- U zařízení lze nastavit **nadřazený prvek** (co ho napájí/připojuje: sektor, PoE switch, router). Neřízené prvky (bez loginu) jdou přidat jen kvůli topologii.
- Uplink se detekuje ze skenu: rozhraní default route + `/ip neighbor` (rodič se navrhne jen když adresa souseda = brána, nebo je brána v seznamu). Tlačítko „Přebrat detekované rodiče".
- Job jde vždy od listů: antény → sektory → nadřazené. Nadřazený prvek se nerestartuje, dokud jeho potomci v jobu neskončili; když potomek skončí chybou/neznámým stavem, rodič se **zablokuje**. Po restartu rodiče se čeká, až se potomci zase ozvou (TCP probe).
- **Sken rozsahu**: CIDR / `a.b.c.x-y`, seznam loginů; TCP probe → SSH login → RouterOS se založí do seznamu.

## Opatření proti umrtvení (rešerše fór a dokumentace MikroTik, 9/2026)

| Příčina | Opatření v nástroji |
|---|---|
| výpadek napájení během zápisu (PoE od rodiče, slabé napájení) | pořadí potomci→rodiče, rodič se nerestartuje během upgradu potomka, varování při napětí < 11 V, servisní okno |
| neúplný/poškozený balíček a přesto restart (updater `install`) | velikost proti download.mikrotik.com, ověření na routeru, žádný cizí .npk, jinak žádný restart |
| chybějící `wireless`/`wifi-qcom` po 7.13 (i 60GHz) | balíček wireless se přidá podle rozhraní (wlan, w60g) a podle v6 balíčků; verze musí sedět s routeros |
| „not enough space for upgrade" na 16 MB flash | mezikrok 7.12.x, upload se při selhání uklidí; u flash/ zařízení limit RAM |
| kernel bugy čerstvých verzí, bootloopy | min. stáří vydání (výchozí 3 dny), seznam zakázaných verzí, kanárci po modelech |
| starý RouterBOOT před v7 | firmware se upgraduje ještě na v6, po každém hopu znovu (+ restart, ověření) |
| auto-upgrade firmware routeru → druhý restart | detekuje se, čeká se na druhý cyklus |
| konverze konfigurace 6→7 | BGP/OSPF/filtry/MPLS blokováno bez povolení; VLAN filtering, CAPsMAN, scheduler varování |
| protected-routerboot | varování (Netinstall při havárii nejde) |
| nenabootování po upgradu | u zařízení s více oddíly `/partitions copy-to` + `fallback-to` před upgradem; u ≥128 MB flash doporučení repartition |

## Stack

Node.js 22 (`node:sqlite`, bez buildu), jediná závislost `ssh2`. Hesla routerů jsou v DB šifrovaná (AES-256-GCM, klíč `MTU_SECRET`).
Přihlášení heslem (`MTU_PASSWORD`) a/nebo přes SSO (OpenID Connect, `SSO_*` v env; authorization code + PKCE, identita z userinfo, volitelný allowlist e-mailů). Kdo job založil a spustil, je v logu jobu. Živé události přes SSE.

```
server.js        HTTP API + statika + SSE
lib/ros.js       SSH/SFTP klient pro RouterOS (v6 i v7, legacy algoritmy)
lib/inspect.js   zjištění stavu (jen čtení)
lib/planner.js   plán hopů, balíčků, blokátory
lib/runner.js    job engine (záloha → staging → ověření → restart → ověření → firmware)
lib/scanner.js   periodický sken
lib/versions.js  verze z upgrade.mikrotik.com, katalog a cache balíčků
public/          UI (vanilla JS)
```

## Nasazení

- Node.js 22+, `npm install --omit=optional`, env podle `env.example` (heslo webu, šifrovací klíč, veřejná URL).
- Služba `mikrotik-upgrader.service` (uprav cesty a uživatele), port 2820 jen na 127.0.0.1.
- Reverse proxy (nginx) `location /mikrotik/` → `http://127.0.0.1:2820/mikrotik/`, `proxy_buffering off` kvůli SSE.
- Data (DB, zálohy, cache balíčků) v `data/` — nejsou v gitu. Server musí mít přístup na routery přes SSH a na download.mikrotik.com.
- `deploy.sh` nasazuje přes ssh a restartuje službu až ve chvíli, kdy neběží žádný job (cíl v `deploy.env`, viz skript).

## Formát hromadného vložení

```
host[:port] uživatel heslo [skupina] [název…]
192.0.2.1 admin tajne pater Router skola
192.0.2.2 admin "" test mAP bez hesla
```
