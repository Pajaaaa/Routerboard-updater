# Rešerše: co při upgradu RouterOS zabíjí zařízení a spoje a jak se tomu vyhnout

Stav k 6. 9. 2026. Zdroje: oficiální dokumentace MikroTik (help/manual.mikrotik.com), changelogy
`download.mikrotik.com/routeros/<verze>/CHANGELOG` (6.40–7.24.2), ~150 vláken forum.mikrotik.com, GitHub projekty pro
hromadný upgrade, bezpečnostní advisory (MikroTik 9/2026, CERT Polska). Označení: **[DOK]** = oficiální,
**[FÓRUM]** = komunita, **[NEJ]** = odvozeno / nepotvrzeno. Poslední sloupec vždy říká, co s tím dělá tento nástroj.

## 1. Hlavní závěry

1. **Skutečný hard-brick (nepomůže ani Netinstall) je téměř výhradně věc RouterBOOTu**: přerušený zápis bootloaderu, upgrade
   *backup* RouterBOOTu (RB5009 7.18/7.19: smazaný SPI NOR, jen UART), `protected-routerboot` (vypnutý reset i Etherboot).
   Běžný upgrade RouterOS končí v nejhorším případě „soft-brickem" řešitelným Netinstallem – což u zařízení na střeše za
   bezdrátovým spojem znamená prakticky totéž (výjezd). [DOK RouterBOOT, RouterBOARD; FÓRUM 183645, 181110, 152814]
2. **Poškozený nebo neúplný .npk brick nezpůsobí.** Každý balíček má podpis, RouterOS ho ověřuje při instalaci i při každém
   bootu, vadný zahodí a nabootuje starou verzi. Riziko je nepřímé: chybějící balíček (wireless) = zmizelé rádio, plná flash
   po opakovaných uploadech, cizí .npk v kořeni, který se nainstaluje s příštím restartem. [Tenable/Margin research; DOK Packages]
3. **Bezdrátový spoj nerozbije rozdíl verzí, ale změna ovladače.** Na balíčku `wireless` (nv2, nstreme, 802.11, 60 GHz) není
   doložený jediný případ rozpadu kvůli 6.x↔7.x nebo 7.a↔7.b; MikroTik nv2 drží zpětně kompatibilní („upgrade AP je nutný,
   klienti mohou zůstat na staré verzi", staff 2012 a 2018). Zabíjí: (a) přechod na `wifi-qcom(-ac)` = ztráta nv2, nstreme,
   station-wds a nekompatibilní station-bridge (funguje jen wireless↔wireless nebo wifi↔wifi); (b) od 7.13 je `wireless`
   samostatný balíček – ruční upload jen `routeros-*.npk` = po restartu žádné rádio (konfigurace zůstane); (c) u 60 GHz
   verze s regresí: **7.19.4** (MCS 0, link se nenaváže, opraveno 7.19.6), **7.5** (flapping, opraveno 7.6),
   **6.47.0–6.47.5**, 6.42.6, LHG 60G r2 na 6.45.9–6.48. [DOK WiFi „Lost features", Wireless Station Modes, KB Missing
   wireless; FÓRUM 263522, 160796, 163643, 177716]
4. **Každá první verze větve (x.y.0) od 7.13 dostala do 1–14 dní opravnou x.y.1** s regresemi „introduced in vX.Y" (7.17
   ztráta bridge/IP/IPv6 nastavení, 7.19 rozbité certifikáty, 7.20 STP blokuje porty + rozbité neinteraktivní SSH, 7.23.4
   nefunkční DHCPv6 v long-term větvi). Long-term ≠ bez regresí. [changelogy 7.13–7.24.2]
5. **Pořadí a napájení.** PoE-out u routerů (hEX PoE, hAP, wAP…) při restartu vypadne → napájené děti dostanou studený reset,
   a to dvakrát, pokud po RouterOS následuje firmware. 7.19 navíc obsahuje upgrade firmwaru PoE řadiče „will cause brief
   power interruption to PoE-out interfaces". Rodič se nikdy nesmí restartovat, dokud potomci nedokončili zápis a neběží.
   [DOK PoE-Out; changelog 7.19; GitHub routeros-upgrader `powerdep`]
6. **Bezpečnost 9/2026.** Advisory MikroTik 2026-09-03 + CERT Polska 2026-09-05: aktivně zneužívaná kombinace CVE-2026-67276
   (SSH RSA klíč – porovnává se jen modulus), CVE-2026-86060 (eskalace přes username), CVE-2026-67277 (btest). Opraveno
   v 7.24.2, 7.23.4 (má ale regresi DHCPv6 → 7.23.5), 6.49.21. Otisk: log „login failure for user -2", účet „ops",
   device-mode `flagged`. → Verze pod 7.24.2 / 7.23.5 / 6.49.21 se SSH z internetu jsou důvod upgradovat hned.

## 2. Co říká oficiální dokumentace (pravidla, která nástroj dodržuje)

| Pravidlo [DOK] | Zdroj | V nástroji |
|---|---|---|
| npk do kořene Files, ne do `hotspot/`; na zařízeních s `flash/` je kořen RAM disk, ale „.npk will be applied by the upgrade process before the system discards the RAM drive content" | Files, Upgrading | upload SFTP do kořene, ověření názvu + velikosti + žádný cizí .npk před restartem |
| stáhnout hlavní balíček **plus všechny nainstalované extra balíčky**, stejná verze („RouterOS and the corresponding wireless package must be the same version") | Upgrading, KB Missing wireless | sada balíčků z `/system package print`, wireless podle rozhraní/CAPsMAN, verze shodné |
| `wireless` × `wifi-qcom(-ac)` nesmí být aktivní současně (7.18 odmítne) | Packages, changelog 7.18 | blokátor při obou v sadě; ovladač se nikdy nemění |
| z v6 nejdřív poslední v6, pak 7.12.1, pak cíl; min. 64 MB RAM; routing konverze jen jednou | Upgrading to v7 | hopy 6.49.x → 7.12.1 → cíl (16 MB) / přímo; RAM kontrola; BGP/OSPF/MPLS blokováno bez povolení |
| „strongly recommended to upgrade the bootloader after RouterOS update … followed by a reboot" | RouterBOOT | firmware až po ověřeném RouterOS, samostatný restart, nikdy backup RouterBOOT |
| `auto-upgrade=yes` = firmware po dalším restartu | RouterBOARD | čeká se na druhý restart |
| partitions: NAND, ≥128 MiB (7.20+), fallback-to; kritérium selhání nedokumentováno | Partitions | copy-to + fallback před upgradem, repartition jen ručně |
| device-mode 7.17+: `routerboard`, `partitions`, `install-any-version` vypnuté; změna = fyzické potvrzení, 3 pokusy | Device-mode | čte se; „not allowed by device-mode" u firmwaru = varování, ne pád |
| write-back cache (CCR, RB4011): zápis do flash zpožděn až 40 s, výpadek = prázdné soubory | Files | velikost souboru se ověřuje na routeru před restartem |
| Netinstall maže konfiguraci, zachová licenci a RouterBOOT settings; od 7.24 `/tool/netinstall` na jiném MikroTiku | Netinstall | runbook v nápovědě; rodič může netinstallovat potomka po ethernetu |
| demo licence od 7.8 upgrade nedovolí | License | – (v síti nejsou) |

## 3. Příčiny umrtvení a opatření

| Příčina | Co se stane | Opatření v nástroji |
|---|---|---|
| výpadek napájení během zápisu balíčků/RouterBOOTu | soft-brick (Netinstall) až hard-brick (backup booter ručně: reset ~3 s před napájením) | potomci před rodiči, PoE rodič čeká na potomky, varování na nízké napětí, firmware jen po ověřeném RouterOS |
| vadná flash (bad-blocks > 5 %, „kernel failure", CCR1072/2004 NAND) | mizí heslo, nejde zapisovat, bootloop | `/system resource bad-blocks` > 5 % = blokátor, > 0,5 % varování; log „kernel failure / NAND / out of memory" = varování |
| málo místa (16 MB flash, „not enough disk space") | upgrade se odmítne, zařízení běží dál; výjimka CRS3xx 7.14.1 bootloop | výpočet místa vs. velikost balíčků + rezerva, 16 MB: RAM staging, po upgradu varování pod 300 kB |
| starý RouterBOOT + nový RouterOS, skok přes mnoho verzí | bootloop po `routerboard upgrade` | firmware před přechodem 6→7 ještě na v6; hopy po větvích |
| málo RAM pro v7 (RB750 32 MB) | OOM bootloop | min. RAM v nastavení |
| konverze konfigurace 6→7 (BGP filtry implicit reject, update-source=interface, OSPF stub, MPLS filtr neighbor=0.0.0.0, MT7621 VLAN filtering přes switch čip, mangle mark-routing bez !local) | zmizelé routy, ztráta managementu | dynamický routing blokován bez povolení, VLAN filtering varování, export + binární záloha před každým hopem |
| v6 < 6.49.18 s rozdělenými balíčky, v6 < 6.41 (master-port) na 7.17+ | rozbitý upgrade / zmizelá switch konfigurace | hop přes poslední v6 |
| chybějící balíček wireless na 7.13+ (i legacy CAPsMAN kontrolér bez rádia) | žádné rádio / žádný /caps-man | wireless se přikládá podle rozhraní **i** podle CAPsMAN |
| cizí .npk / .fwf v kořeni | nainstaluje se cizí verze / firmware selže | cizí .npk = blokátor, .fwf = varování + firmware se přeskočí |
| protected-routerboot, backup RouterBOOT balíček | bez Netinstallu, hard-brick | varování; backup RouterBOOT se nikdy nedělá |
| verze s regresí (x.y.0, 7.17, 7.19, 7.20.0–7.20.2, 7.23.4, 7.24.0; per HW: 60 GHz 7.19.4/7.5/6.47.x, RB2011 7.21–7.22, RB3011 7.22–7.24.0, IPQ-40xx 7.22.0–7.22.2, CRS3xx 7.14.1, PPC 7.12.0, CHR 7.14.0/7.22.0) | výpadky, bootloopy, rozpad spoje | x.y.0 až po 14 dnech; seznam vadných verzí per HW v plánovači; ruční „zakázané verze" |
| dlouhý uptime, fragmentovaná RAM (wAP AX 3 ze 4 nenabootovaly, po preventivním restartu 100 %) | nenabootuje | poznámka při uptime > 300 dní |
| kompromitované zařízení (CVE 9/2026) | po upgradu `flagged`, cizí účty | log „login failure for user -2" = varování, `flagged` = blokátor před / varování po |

## 4. Bezdrátové spoje: aby se neuřízla anténa od sektoru

**Matice kompatibility** (✅ doloženo, 🟢 bez hlášených problémů, ⚠️ podmíněně, ❌ oficiálně nefunguje):

| Protokol / mód | AP | Stanice | Stav |
|---|---|---|---|
| nv2 / nstreme / 802.11 | wireless 7.x | wireless 6.x | 🟢 (MikroTik: nový AP obslouží staré klienty) |
| nv2 / nstreme / 802.11 | wireless 6.x | wireless 7.x | 🟢 |
| nv2 / nstreme | wifi-qcom(-ac) kdekoli | – | ❌ (lost feature) |
| station-bridge / station-wds | wireless | wireless | 🟢 |
| station-bridge | wireless | wifi (nebo naopak) | ❌ |
| station-pseudobridge | wifi AP | wireless stanice | ⚠️ (RSTP off) |
| 60 GHz | wireless 7.x | wireless 7.x | ⚠️ vyhnout se 7.19.4, 7.5; PtMP křehčí |
| 60 GHz | 6.4x | 7.x (mix) | ❓ žádný doložený rozpad, ani doložený dlouhodobý provoz |
| 60 GHz | ≥7.13 bez wireless.npk | – | ❌ |
| legacy CAPsMAN 6.49 | – | CAP wireless 7.20 | 🟢 (doloženo 10/2025) |
| wifi CAPsMAN | – | CAP wireless | ❌ |

**Pořadí** [NEJ – syntéza]: nikdy AP a jeho stanici v jednom kroku; kanárek = jedna stanice → zbytek stanic → AP naposled
(výpadek stanice = jeden zákazník, AP = všichni; novější AP obslouží starší klienty). Nástroj to řeší topologií
potomci → rodiče. U 60 GHz / PtP mají být oba konce na stejné verzi v jednom okně. CAPsMAN: CAPy → kontrolér, jen s
`upgrade-policy=none` (jinak kontrolér CAPy upgraduje/odmítne sám). DFS na 5 GHz: po restartu AP až 10 min kontrola radaru.

**Ověření po restartu** (nástroj): stanice `registration-table` → stejné AP MAC; sektor → návrat ≥ 80 % původních MAC;
60 GHz `monitor` → `connected`, protějšky zpět, **MCS ≥ 1** (7.19.4 měla signál 80–100 a MCS 0); CAP → registrován.
Čeká se až 12 min; neúspěch = položka selže a job se zastaví dřív, než přijde na řadu nadřazený prvek.

## 5. Praxe hromadného upgradu (WISP)

- Dvoufázově: nahrát balíčky bez restartu (klidně dny předem), restart v okně a v pořadí listy → agregace → páteř.
  Rodič se nerestartuje, dokud potomci nejsou ověřeni. [Unimus, Dude Groups, mkcontroller, routeros-upgrader]
- Brute-force ochrana SSH z oficiálního příkladu počítá **nová TCP spojení**, ne špatná hesla (4 spojení = blacklist na den,
  „not cleared upon successful login") → jedno spojení na položku, rozestup 65 s po restartu, IP nástroje do whitelistu.
- SFTP RouterOS: pomalý zápis do flash, známé zaseknutí – přenos má hlídač postupu (2 min) a celkový limit, pád spojení
  uprostřed operace ji ukončí chybou, zrušení přeruší i běžící přenos.
- Zařízení prohlásit za mrtvé až když: rodič je up, sousedi/registrace ho nevidí ≥ 10 min, opakované pokusy selhaly.
  „Neodpovídá na SSH" ≠ „nefunguje" (RB4011 syndrom: provoz jede, management mrtvý).
- Kanárek na každou třídu (architektura + model + role), první vydání větve nikdy, opravné verze vycházejí 1–14 dní po x.y.0.

## 6. Obnova, když se to nepovede

1. Backup RouterBOOT: reset držet **před** připojením napájení, pustit ~3 s po zapnutí; pak `/system routerboard upgrade`.
2. Etherboot/Netinstall: reset držet do zhasnutí LED, nebo z RouterOS `boot-device=try-ethernet-once-then-nand`; nutná L2
   sousednost (přímý kabel, jedno aktivní rozhraní, 192.168.88.x); od 7.24 `/tool/netinstall` z jiného MikroTiku.
   „Keep old configuration" obnoví jen konfiguraci. Verze k Netinstallu = ověřená stabilní, ne nutně ta, co selhala.
3. `/system package downgrade` s nahranou starší sadou (doloženo 7.19.4 → 7.19.3); nikdy pod `factory-software`;
   7→6 = ztráta routing/PIM/User-Manager konverze; 7.22+ → pod 7.22 ztráta MLAG.
4. Partitions fallback řeší jen selhání bootu, ne rozpad linku; deadman scheduler (aktivace staré partition po X min bez
   potvrzení) je jediná softwarová cesta k automatickému návratu. [NEJ]
5. Export ze zálohy nástroje jde na jinou verzi; binární backup jen na stejnou verzi a totéž zařízení.

## 7. Klíčové zdroje

- Upgrading and installation, Upgrading to v7, Packages, RouterBOOT, RouterBOARD, Partitions, Netinstall, Device-mode,
  Files, Backup, PoE-Out, Nv2, Wireless Station Modes, WiFi (Lost features), W60G, KB „Missing wireless or wifi interface
  after update", KB „Reboot loop", Bruteforce prevention – vše help.mikrotik.com / manual.mikrotik.com.
- Changelogy: https://download.mikrotik.com/routeros/<verze>/CHANGELOG
- Bezpečnost: https://mikrotik.com/supportsec/september-2026-vulnerability/ ,
  https://cert.pl/en/posts/2026/09/vulnerabilities-in-mikrotik-routeros-actively-exploited/
- Fórum (výběr): 263522 (w60g 7.19.4), 172827 (nRAY bez wireless), 177716 (station-bridge wireless↔wifi), 160796 (60G 7.5),
  163643 (w60g 6.47), 183645 + github kaechele/rb5009-unbrick (RB5009 backup RouterBOOT), 181110 (protected-routerboot),
  152814 (Bricked routers / RouterBOOT), 171481 a 267885 (not enough space, cesta 7.16.2 → 7.18.2 → 7.21), 181257 (7.17),
  265196/266877 (7.20), 267773 (7.21), 272801/272867 (7.23.4/7.23.5), 272585 (wAP AX reboot před upgradem),
  265581 (CAPsMAN 6.49 ↔ CAP 7.20), 268337176 (bruteforce).
- Nástroje: github.com/Marco98/routeros-upgrader (`powerdep`), blog.unimus.net (network-wide upgrade), mkcontroller patching guide.
