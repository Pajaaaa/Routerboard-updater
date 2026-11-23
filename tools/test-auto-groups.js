#!/usr/bin/env node
'use strict';
// Automat — skupiny („automatické joby“) a HTTP API /api/auto (lib/autoupgrade.js, server.js; 20.11.2026): divné vstupy saveGroup,
// stavy zařízení ve skupině, přesuny mezi skupinami, dva uživatelé, odebrané povolení, perzistence auto-upgrade.json a HTTP vrstva.
// Kontroly označené „// BUG:“ zachycují skutečné chyby nalezené při testování — selhávají, dokud se neopraví.
// Části: 1) knihovna v tomto procesu, 2) perzistence (vlastní proces na každý soubor: --persist), 3) HTTP proti serveru na náhodném
// lokálním portu (databázi mu předem naplní --seed; server běží se zaslepeným fetch, takže nikam ven nesahá).
const fs = require('fs'), os = require('os'), path = require('path'), { spawn, spawnSync } = require('child_process');
const MODE = process.argv[2] || '';
const dir = MODE ? process.argv[3] : fs.mkdtempSync(path.join(os.tmpdir(), 'mtu-autog-'));
process.env.DATA_DIR = dir; process.env.MTU_SECRET = 'test-secret-1234567890'; process.env.MTU_PASSWORD = 'heslo-spravce-1'; process.env.USERDB_URL = ''; process.env.MTU_SMTP_HOST = '';
const day = 86400, realSec = Date.now() / 1000;
// noc pro tick: nejbližší úterý 01:30 (výchozí okno 01:00–04:30, dny po–čt); verze vydaná před 30 dny je zralá teď i tehdy
const NOW = (() => { const d = new Date(); d.setHours(1, 30, 0, 0); do { d.setDate(d.getDate() + 1); } while (d.getDay() !== 2); return d; })();
const nowSec = NOW.getTime() / 1000;
const RELEASES = { 'v7-long-term': [{ version: '7.24.6', releasedAt: realSec - 30 * day }], 'v7-stable': [{ version: '7.25.1', releasedAt: realSec - 30 * day }], 'v6-long-term': [{ version: '6.49.24', releasedAt: realSec - 60 * day }] };
if (MODE !== '--persist' || !fs.existsSync(path.join(dir, 'releases.json'))) fs.writeFileSync(path.join(dir, 'releases.json'), JSON.stringify(RELEASES));

let bad = 0, bugs = 0;
const chk = (ok, msg) => { if (!ok) { console.error('  ✗ ' + msg); bad++; if (/^BUG/.test(msg)) bugs++; } else console.log('  ✓ ' + msg); };
const thrown = (fn) => { try { fn(); return ''; } catch (e) { return `${e.constructor.name}: ${e.message}`; } };

// ---------- režim --seed: naplní databázi pro HTTP část a vypíše id ----------
if (MODE === '--seed') {
  const db = require('../lib/db'); const { hashPassword } = require('../lib/crypto');
  const mkU = (name, role) => db.insertUser({ name, pass_hash: hashPassword(`heslo-${name}-1`), role });
  const ids = { admin: mkU('admin', 'admin'), alice: mkU('alice', 'user'), bob: mkU('bob', 'user'), carol: mkU('carol', 'user') };
  db.setSettings({ auto_users: 'admin, alice, bob' });
  let n = 0; const mkDev = (owner) => { const id = db.insertDevice({ host: `127.9.1.${++n}`, port: 22, owner_id: owner, username: 'a', password: 'b' }); db.updateDevice(id, { version: '7.24.4', scan_status: 'ok', last_scan_at: db.now(), model: 'SXTsq', board_name: 'SXTsq', track: 'v7-long-term' }); return id; };
  Object.assign(ids, { a1: mkDev(ids.alice), a2: mkDev(ids.alice), a3: mkDev(ids.alice), a4: mkDev(ids.alice), b1: mkDev(ids.bob), ad1: mkDev(ids.admin) });
  console.log('SEED' + JSON.stringify(ids)); process.exit(0);
}

// ---------- režim --persist: stav automatu načtený z připraveného auto-upgrade.json ----------
if (MODE === '--persist') {
  const db = require('../lib/db'), V = require('../lib/versions'), auto = require('../lib/autoupgrade');
  const out = {}; const T = async (k, fn) => { try { out[k] = await fn(); } catch (e) { out[k] = `THROW ${e.constructor.name}: ${e.message}`; } };
  const ce = console.error; console.error = () => {};
  (async () => {
    const id = db.insertUser({ name: 'paja@x.cz', pass_hash: '', role: 'user' }); db.updateUser(id, { userdb_nick: 'pajavlk' }); const me = db.listUsers().find(u => u.id === id);
    const mk = (h) => { const d = db.insertDevice({ host: h, port: 22, owner_id: id, username: 'a', password: 'b' }); db.updateDevice(d, { version: '7.24.4', scan_status: 'ok', track: 'v7-long-term' }); return d; };
    mk('127.9.0.1'); const d2 = mk('127.9.0.2');
    db.setUserSettings(id, { auto_enable: true });
    const started = []; auto.configure({ pool: { draining: false, isDeviceBusy: () => false, startOrQueue: (j) => started.push(j) }, notify: () => {} }); V.refreshLatest = async () => {};
    await T('status', () => { const s = auto.statusFor(me); return { groups: s.groups.map(g => [g.id, g.name, g.devs]), history: s.history.length, open: s.open }; });
    await T('tick', async () => { await auto.tick(NOW); const us = auto._state().users[id] || {}; return { started: started.length, lastError: us.lastError ? us.lastError.error : '' }; });
    await T('save', () => { const r = auto.saveGroup(id, { name: 'Nová', deviceIds: [d2] }); return r.error ? 'error: ' + r.error : r.group.devs; });
    await T('delete', () => { auto.deleteGroup(id, 1); return 'ok'; });
    out.files = fs.readdirSync(dir).filter(f => /^auto-upgrade/.test(f));
    console.error = ce; console.log('RESULT' + JSON.stringify(out)); process.exit(0);
  })();
  return;
}

// =====================================================================================================================
const db = require('../lib/db');
const V = require('../lib/versions');
const auto = require('../lib/autoupgrade');
const access = require('../lib/access');
const mail = require('../lib/mail');
mail.enabled = () => false;
const mkUser = (name, nick) => { const id = db.insertUser({ name, pass_hash: '', role: 'user' }); db.updateUser(id, { userdb_nick: nick }); return db.listUsers().find(u => u.id === id); };
let n = 0;
const mkDev = (owner, f = {}) => { const id = db.insertDevice({ host: `127.9.${2 + (n >> 8)}.${n++ & 255}`, port: 22, owner_id: owner, username: 'a', password: 'b' }); db.updateDevice(id, { version: '7.24.4', scan_status: 'ok', userdb_member: 1, model: 'SXTsq', board_name: 'SXTsq', track: 'v7-long-term', ...f }); return id; };

async function partLib() {
  console.log('\n== 1) knihovna: saveGroup / planGroup / statusFor');
  db.setSettings({ auto_users: 'pajavlk, jiny' });
  const me = mkUser('paja@x.cz', 'pajavlk'), other = mkUser('jiny@x', 'jiny');
  const S = () => db.getSettings(me.id);
  const d = []; for (let i = 0; i < 9; i++) d.push(mkDev(me.id));
  const f1 = mkDev(other.id);
  const groupsOf = (uid) => auto._state().users[uid].groups;
  const sg = (b) => auto.saveGroup(me.id, b);
  const tmp = (b) => { const r = sg(b); if (r.group) auto.deleteGroup(me.id, r.group.id); return r; }; // uloží a hned smaže

  // --- tělo požadavku
  chk(!thrown(() => sg(null)) && !thrown(() => sg(undefined)), 'BUG: saveGroup(null) nesmí spadnout na TypeError (HTTP tělo „null“ → 400 s textem výjimky): ' + thrown(() => sg(null))); // BUG: lib/autoupgrade.js:102 — b.name bez kontroly, že b je objekt
  chk(!!sg([]).error && !!sg('x').error && !!sg(5).error, 'tělo, které není objekt (pole, řetězec, číslo), skončí chybou „job potřebuje název“');
  // --- deviceIds
  chk(tmp({ name: 'T', deviceIds: [String(d[0])] }).group.devs.join() === String(d[0]), 'deviceIds jako řetězce se převedou na čísla');
  chk(tmp({ name: 'T', deviceIds: [d[0], d[0], String(d[0])] }).group.devs.length === 1, 'duplicitní id se sloučí');
  chk(tmp({ name: 'T', deviceIds: [-1, 0, 1e9, 1.5, null, {}, 'abc', d[1]] }).group.devs.join() === String(d[1]), 'záporná, nulová, neexistující a nečíselná id se zahodí');
  chk(!!sg({ name: 'T', deviceIds: 'notarray' }).error && !!sg({ name: 'T', deviceIds: { 0: d[0], length: 1 } }).error && !!sg({ name: 'T' }).error && !!sg({ name: 'T', deviceIds: [] }).error, 'deviceIds, které není pole / chybí / je prázdné → chyba');
  chk(!!sg({ name: 'T', deviceIds: [f1] }).error, 'jen cizí zařízení → chyba');
  { const t = Date.now(); const r = tmp({ name: 'T', deviceIds: Array.from({ length: 100000 }, (_, i) => i) }); chk(r.group && r.group.devs.length === d.length && Date.now() - t < 2000, `100 000 id: uloží se jen vlastní (${r.group && r.group.devs.length}), rychle (${Date.now() - t} ms)`); }
  // --- název
  chk(!!sg({ name: '', deviceIds: [d[0]] }).error && !!sg({ name: '   ', deviceIds: [d[0]] }).error && !!sg({ name: '\t\r\n', deviceIds: [d[0]] }).error && !!sg({ name: null, deviceIds: [d[0]] }).error, 'prázdný název / jen mezery / null → chyba');
  chk(tmp({ name: '<img src=x onerror=alert(1)> "a\'b„“', deviceIds: [d[0]] }).group.name === '<img src=x onerror=alert(1)> "a\'b„“', 'HTML a uvozovky v názvu se uloží beze změny (escapuje UI)');
  chk(tmp({ name: 'x'.repeat(5000), deviceIds: [d[0]] }).group.name.length === 80, 'dlouhý název se zkrátí na 80 znaků');
  { const nm = tmp({ name: 'x'.repeat(79) + '😀', deviceIds: [d[0]] }).group.name; chk(nm.isWellFormed(), 'BUG: zkrácení na 80 znaků nesmí rozpůlit emoji (v názvu zůstane osamocený surrogate → v názvu jobu „�“)'); } // BUG: lib/autoupgrade.js:102 — slice(0, 80) řeže po UTF-16 jednotkách
  { const nm = tmp({ name: 'a\r\nBcc: x@y', deviceIds: [d[0]] }).group.name; chk(!/[\r\n]/.test(nm), 'BUG: konce řádků uvnitř názvu se mají nahradit mezerou (jdou do názvu jobu, logu a auditu; předmět e-mailu je čistí sám)'); } // BUG: lib/autoupgrade.js:102 — trim() řeší jen okraje
  chk(tmp({ name: '__proto__', deviceIds: [d[0]] }).group.name === '__proto__' && ({}).name === undefined, 'název „__proto__“ nic nerozbije');
  // --- zpoždění
  const delay = (v) => { const r = tmp({ name: 'T', delay_days: v, deviceIds: [d[0]] }); return r.error ? 'err' : r.group.delay_days; };
  chk(delay('') === null && delay(null) === null && delay(undefined) === null && delay('  ') === null, 'zpoždění \'\' / null / chybí / mezery = výchozí (null)');
  chk(delay('0') === 0 && delay(0) === 0 && delay('3.5') === 3.5 && delay(' 7 ') === 7 && delay(365) === 365, 'zpoždění \'0\', 0, \'3.5\', \' 7 \', 365 se přijme');
  chk(delay('abc') === 'err' && delay(-1) === 'err' && delay(366) === 'err' && delay({}) === 'err' && delay('Infinity') === 'err', 'zpoždění \'abc\', -1, 366, {}, Infinity → chyba');
  // --- id skupiny
  const g1 = sg({ name: 'G1', deviceIds: [d[0], d[1]] }).group;
  chk(sg({ id: String(g1.id), name: 'G1', deviceIds: [d[0], d[1]] }).group.id === g1.id && groupsOf(me.id).length === 1, 'id skupiny jako řetězec upraví tutéž skupinu');
  chk(!!sg({ id: 'abc', name: 'X', deviceIds: [d[0]] }).error && !!sg({ id: 999, name: 'X', deviceIds: [d[0]] }).error && !!sg({ id: -1, name: 'X', deviceIds: [d[0]] }).error && groupsOf(me.id).length === 1, 'nečíselné / neexistující / záporné id skupiny → chyba, nic se nezaloží');
  chk(!!sg({ name: 'g1', deviceIds: [d[2]] }).error, 'stejný název (bez ohledu na velikost písmen) podruhé nejde');
  // --- enabled
  chk(sg({ id: g1.id, name: 'G1', enabled: false, deviceIds: [d[0], d[1]] }).group.enabled === false, 'enabled:false skupinu vypne');
  chk(sg({ id: g1.id, name: 'G1', deviceIds: [d[0], d[1]] }).group.enabled === false, 'BUG: úprava bez pole enabled nesmí vypnutou skupinu potichu zapnout'); // BUG: lib/autoupgrade.js:113 — enabled: b.enabled !== false (chybějící i \'false\'/0 = zapnuto)
  sg({ id: g1.id, name: 'G1', enabled: true, deviceIds: [d[0], d[1]] });
  // --- dva uživatelé
  let og = auto.saveGroup(other.id, { name: 'O', deviceIds: [d[0], f1] }).group;
  chk(og.devs.join() === String(f1), 'druhý uživatel si cizí zařízení do skupiny nepřidá');
  auto.saveGroup(other.id, { id: g1.id, name: 'hack', deviceIds: [f1] }); auto.deleteGroup(other.id, g1.id);
  og = auto.saveGroup(other.id, { name: 'O', deviceIds: [f1] }).group;
  chk(groupsOf(me.id).length === 1 && groupsOf(me.id)[0].name === 'G1' && groupsOf(me.id)[0].devs.length === 2, 'úprava / smazání skupiny se stejným id u druhého uživatele se mé skupiny nedotkne');
  { const so = auto.statusFor(other); chk(so.groups.every(g => g.devs.every(id => id === f1)) && so.pickable.join() === String(f1) && !JSON.stringify(so).includes('G1'), 'statusFor druhého uživatele neobsahuje moje skupiny ani zařízení'); }
  // --- zařízení i v automatu kolegy (sdílené přes APčko → kus smí do jobu oba; v testu to nahradí přepis vlastníka po uložení skupiny)
  { chk(Object.keys(auto.statusFor(me).others).length === 0 && Object.keys(auto.statusFor(other).others).length === 0, 'others: bez společných zařízení je prázdné');
    db.updateDevice(f1, { owner_id: me.id }); // kus f1 teď patří mně, kolega ho má dál ve svém jobu „O“
    const o = auto.statusFor(me).others; const was = db.getSettings().auto_enable; db.setSettings({ auto_enable: 1 }); const o2 = auto.statusFor(me).others;
    chk(Object.keys(o).join() === String(f1) && o[f1].length === 1 && o[f1][0].user === 'jiny' && o[f1][0].group === 'O' && o[f1][0].active === false, 'others: kus v jobu kolegy se ukáže se jménem a jobem; vypnutý automat = active false: ' + JSON.stringify(o));
    chk(o2[f1] && o2[f1][0].active === true, 'others: zapnutý automat kolegy = active true');
    chk(!JSON.stringify(auto.statusFor(other).others).includes('G1'), 'others: kolega se o mých jobech dozví jen u kusů, na které smí');
    db.setSettings({ auto_enable: was }); db.updateDevice(f1, { owner_id: other.id }); }
  auto.deleteGroup(me.id, 'abc'); auto.deleteGroup(me.id, null); auto.deleteGroup(me.id, 999);
  chk(groupsOf(me.id).length === 1, 'deleteGroup s nesmyslným id nic nesmaže a nespadne');
  // --- přesun mezi skupinami, prázdná skupina
  const g2 = sg({ name: 'G2', deviceIds: [d[2]] }).group;
  sg({ id: g1.id, name: 'G1', deviceIds: [d[0], d[1], d[2]] });
  chk(g2.devs.length === 0 && groupsOf(me.id).find(g => g.id === g1.id).devs.length === 3, 'přesun zařízení: je nejvýš v jedné skupině, původní zůstane prázdná');
  chk(!thrown(() => auto.statusFor(me)) && auto.planGroup(me.id, S(), g2, nowSec).list.length === 0, 'prázdná skupina: statusFor nespadne, plán je prázdný');
  chk(!sg({ id: g2.id, name: g2.name, delay_days: g2.delay_days, enabled: false, deviceIds: g2.devs }).error, 'BUG: prázdnou skupinu (zařízení přesunuta / smazána) nejde vypnout ani přejmenovat — tlačítko „Vypnout“ posílá její devs a dostane „vyber aspoň jedno zařízení“'); // BUG: lib/autoupgrade.js:108 — podmínka má platit jen pro novou skupinu
  auto.deleteGroup(me.id, g2.id);

  // --- stavy zařízení
  const G = () => groupsOf(me.id).find(g => g.id === g1.id);
  const plan = () => { const p = auto.planGroup(me.id, S(), G(), nowSec); return { list: p.list.map(x => x.id), wait: p.waiting.map(x => x.id), skipped: p.skipped }; };
  const reasons = () => Object.keys(plan().skipped).join(' | ');
  sg({ id: g1.id, name: 'G1', deviceIds: d });
  chk(plan().list.length === d.length, 'výchozí stav: všech ' + d.length + ' kusů pod cílem jde do plánu');
  db.updateDevice(d[0], { managed: 0 });
  chk(!plan().list.includes(d[0]) && /neřízené/.test(reasons()), 'zařízení přestalo být řízené → vynecháno s důvodem');
  { const ui = auto.statusFor(me).groups.find(x => x.id === g1.id); // přesně to, co pošle tlačítko Vypnout/Zapnout
    sg({ id: ui.id, name: ui.name, delay_days: ui.delay_days, enabled: true, deviceIds: ui.devs });
    db.updateDevice(d[0], { managed: 1 });
    chk(G().devs.includes(d[0]), 'BUG: dočasně neřízené zařízení (stejně tak duplicita nebo dočasně ztracený přístup přes APčko) při jakémkoli uložení / přepnutí skupiny potichu vypadne a po návratu už v jobu není'); } // BUG: lib/autoupgrade.js:106-107 — devs se filtrují přes pickable() i u kusů, které ve skupině už byly
  sg({ id: g1.id, name: 'G1', deviceIds: d });
  db.updateDevice(d[0], { enabled: 0 }); chk(!plan().list.includes(d[0]), 'enabled=false → vynecháno'); db.updateDevice(d[0], { enabled: 1 });
  db.updateDevice(d[1], { dup_of: d[0] }); chk(!plan().list.includes(d[1]), 'duplicita (dup_of) → vynecháno'); db.updateDevice(d[1], { dup_of: 0 });
  db.updateDevice(d[2], { version: '', scan_status: 'never' }); chk(!plan().list.includes(d[2]) && /neznámá verze/.test(reasons()), 'nikdy neskenované (bez verze) → vynecháno s důvodem');
  db.updateDevice(d[2], { version: 'garbage', scan_status: 'ok' }); chk(!plan().list.includes(d[2]), 'nečitelná verze → vynecháno'); db.updateDevice(d[2], { version: '7.24.4' });
  db.updateDevice(d[3], { scan_status: 'error' }); chk(!plan().list.includes(d[3]) && /nedostupné/.test(reasons()), 'scan_status jiný než ok → vynecháno s důvodem'); db.updateDevice(d[3], { scan_status: 'ok' });
  db.updateDevice(d[4], { track: 'hold' }); chk(!plan().list.includes(d[4]) && /hold/.test(reasons()), 'kanál hold → vynecháno s důvodem'); db.updateDevice(d[4], { track: 'v7-long-term' });
  db.updateDevice(d[5], { version: '7.26' }); chk(!plan().list.includes(d[5]) && !plan().wait.includes(d[5]), 'verze vyšší než cíl → nic se neděje');
  db.updateDevice(d[5], { version: '7.25beta3' }); chk(!plan().list.includes(d[5]), 'testovací verze nad cílem → nic se neděje');
  db.updateDevice(d[5], { version: '7.24.6rc2' }); chk(plan().list.includes(d[5]), 'testovací verze pod cílem (7.24.6rc2 → 7.24.6) → jde do plánu'); db.updateDevice(d[5], { version: '7.24.4' });
  db.updateDevice(d[6], { version: '6.49.10' }); chk(!plan().list.includes(d[6]) && /6 → 7/.test(reasons()), '6.x na kanálu v7 → vynecháno (6 → 7 ručně)');
  db.updateDevice(d[6], { track: 'v6-long-term' }); chk(plan().list.includes(d[6]), '6.x na kanálu v6-long-term → jde na 6.49.24'); db.updateDevice(d[6], { version: '7.24.4', track: 'v7-long-term' });
  db.updateDevice(d[6], { track: 'nesmysl' }); chk(!thrown(plan) && !plan().list.includes(d[6]), 'neznámý kanál → vynecháno, nespadne'); db.updateDevice(d[6], { track: 'v7-long-term' });
  // v jiném jobu
  const mj = db.createJob('ruční', {}, [d[7]], me.id);
  chk(!plan().list.includes(d[7]) && /jiném jobu/.test(reasons()), 'zařízení ve frontě ručního jobu → vynecháno s důvodem');
  db.updateJob(mj, { status: 'scheduled' }); chk(!plan().list.includes(d[7]), 'zařízení v naplánovaném jobu → vynecháno');
  db.updateJob(mj, { status: 'paused' });
  chk(!plan().list.includes(d[7]), 'BUG: zařízení čekající v POZASTAVENÉM ručním jobu (stejně batch-hold) se bere jako volné a automat ho dá do svého jobu'); // BUG: lib/autoupgrade.js:125 + lib/db.js:494 — pendingUpgrades nezná stavy paused / batch-hold (OPEN v autoupgrade.js:29 je zná)
  db.updateJob(mj, { status: 'done' });
  // převod, smazání
  db.updateDevice(d[7], { owner_id: other.id });
  chk(!plan().list.includes(d[7]) && /nemáš ve správě/.test(reasons()), 'převedené na jiného vlastníka → vynecháno s důvodem');
  chk(auto.saveGroup(other.id, { id: og.id, name: 'O', deviceIds: [f1, d[7]] }).group.devs.includes(d[7]), 'nový vlastník si ho do své skupiny přidat smí');
  db.deleteDevice(d[8]);
  chk(!thrown(plan) && !plan().list.includes(d[8]), 'smazané zařízení ve skupině: plán nespadne');
  { const s = auto.statusFor(me).groups.find(x => x.id === g1.id); chk(s.devices.length === s.devs.length && s.devices.filter(x => /už není ve správě/.test(x.name)).length === 2, 'statusFor: smazané a převedené zařízení ukáže jako „(už není ve správě)“'); }
  // sdílené přes APčko
  db.updateDevice(f1, { userdb_ap_id: 55 }); db.updateUser(me.id, { userdb_aps: JSON.stringify([55]) }); await access.invalidate();
  chk(auto.pickable(me.id).some(x => x.id === f1), 'zařízení kolegy pod sdíleným APčkem jde vybrat');
  const gs = sg({ name: 'Sdílené', deviceIds: [f1] }).group;
  chk(auto.planGroup(me.id, S(), gs, nowSec).list.length === 1 && auto.saveGroup(other.id, { id: og.id, name: 'O', deviceIds: [f1, d[7]] }).group.devs.includes(f1), 'sdílené zařízení může mít ve skupině každý z obou správců');
  db.updateUser(me.id, { userdb_aps: '[]' }); await access.invalidate();
  { const p = auto.planGroup(me.id, S(), gs, nowSec); chk(p.list.length === 0 && /nemáš ve správě/.test(Object.keys(p.skipped).join()) && !thrown(() => auto.statusFor(me)), 'po odebrání přístupu k APčku se sdílené zařízení neplánuje'); }
  { const s = auto.statusFor(me).groups.find(x => x.id === gs.id).devices[0]; chk(!s.host && !s.version, 'statusFor po odebrání přístupu neprozradí adresu ani verzi cizího zařízení'); }
  auto.deleteGroup(me.id, gs.id);

  // --- nastavení přes PUT /api/auto
  chk(!!auto.validate({ auto_delay_days: null }).error || !('auto_delay_days' in (auto.validate({ auto_delay_days: null }).values || {})), 'BUG: prázdné pole „výchozí zpoždění“ (UI pošle parseFloat(\'\') = NaN → JSON null) se uloží jako 0 dní místo chyby'); // BUG: lib/autoupgrade.js:65 — Number(null) i Number(\'\') je 0
  chk(!!auto.validate({ auto_delay_days: '' }).error || !('auto_delay_days' in (auto.validate({ auto_delay_days: '' }).values || {})), 'BUG: auto_delay_days \'\' se uloží jako 0 dní'); // BUG: lib/autoupgrade.js:65
  chk(!!auto.validate({ auto_delay_days: 'abc' }).error && !!auto.validate({ auto_delay_days: -1 }).error && auto.validate({ auto_delay_days: '3' }).values.auto_delay_days === 3, 'auto_delay_days: abc a -1 chyba, \'3\' → 3');

  // --- noční běh se skupinami: prázdná skupina, smazání a přejmenování s rozjetým jobem, odebrané povolení
  console.log('\n== 1b) noční běh');
  const started = []; auto.configure({ pool: { draining: false, isDeviceBusy: () => false, startOrQueue: (j) => started.push(j) }, notify: () => {} }); V.refreshLatest = async () => {};
  for (const g of [...groupsOf(me.id)]) auto.deleteGroup(me.id, g.id); for (const g of [...groupsOf(other.id)]) auto.deleteGroup(other.id, g.id);
  db.setUserSettings(me.id, { auto_enable: true }); db.setUserSettings(other.id, { auto_enable: true });
  const gA = sg({ name: 'A', deviceIds: [d[0]] }).group, gB = sg({ name: 'B', deviceIds: [d[1]] }).group, gE = sg({ name: 'Prázdná', deviceIds: [d[2]] }).group;
  sg({ id: gB.id, name: 'B', deviceIds: [d[1], d[2]] });
  auto.saveGroup(other.id, { name: 'O', deviceIds: [f1] });
  { // pořadí (priorita): posun nahoru/dolů, krajní polohy, neplatné vstupy
    const ord = () => groupsOf(me.id).map(g => g.name).join(',');
    chk(ord() === 'A,B,Prázdná' && auto.statusFor(me).groups.map(g => g.order).join() === '1,2,3', 'pořadí: nové joby se řadí na konec a jsou očíslované');
    chk(auto.moveGroup(me.id, gE.id, 'up').moved && ord() === 'A,Prázdná,B', 'pořadí: posun nahoru');
    chk(auto.moveGroup(me.id, gA.id, 'down').moved && ord() === 'Prázdná,A,B', 'pořadí: posun dolů');
    chk(auto.moveGroup(me.id, gE.id, 'up').moved === false && auto.moveGroup(me.id, gB.id, 'down').moved === false && ord() === 'Prázdná,A,B', 'pořadí: první nejde výš, poslední níž');
    chk(!!auto.moveGroup(me.id, 999999, 'up').error && !!auto.moveGroup(me.id, gA.id, 'bokem').error && !!auto.moveGroup(me.id, null, null).error, 'pořadí: neexistující job a neplatný směr se odmítnou');
    auto.moveGroup(me.id, gE.id, 'bottom'); chk(ord() === 'A,B,Prázdná', 'pořadí: posun na konec');
    sg({ id: gA.id, name: 'A', deviceIds: [d[0]] }); sg({ id: gA.id, enabled: true }); chk(ord() === 'A,B,Prázdná', 'pořadí: úprava a přepnutí jobu pořadí nemění');
    auto._state().users[me.id].groups = groupsOf(me.id); // beze změny
    require('fs'); const st = JSON.parse(JSON.stringify(auto._state().users[me.id].groups.map(g => g.id))); chk(st.join() === [gA.id, gB.id, gE.id].join(), 'pořadí: je uložené ve stavu');
  }
  await auto.tick(NOW);
  chk(started.length === 2 && started.filter(j => db.getJob(j).owner_id === me.id).length === 1 && /„A“/.test(db.getJob(started.find(j => db.getJob(j).owner_id === me.id)).name), 'noc: každému účtu se spustí jen jeho první job v pořadí');
  // první job doběhne → o pár minut později přijde na řadu další v pořadí
  { const j = started.find(x => db.getJob(x).owner_id === me.id); for (const it of db.getJobItems(j)) { db.updateJobItem(it.id, { status: 'done', finished_at: db.now() }); db.updateDevice(it.device_id, { version: '7.24.6' }); } db.updateJob(j, { status: 'done', finished_at: db.now() }); }
  await auto.tick(new Date(NOW.getTime() + 5 * 60000));
  const jobs = started.map(j => db.getJob(j));
  chk(started.length === 3 && !jobs.some(j => /Prázdná/.test(j.name)) && jobs.filter(j => j.owner_id === me.id).length === 2, `noc: job za každou neprázdnou skupinu, prázdná se nespouští (${jobs.map(j => j.name).join('; ')})`);
  auto.deleteGroup(me.id, gA.id); sg({ id: gB.id, name: 'B nové jméno', deviceIds: [d[1], d[2]] });
  { const s = auto.statusFor(me); chk(s.open.length === 1 && s.history.length === 1 && s.groups.length === 2, 'smazání / přejmenování skupiny s rozjetým jobem: job běží dál a je vidět v „rozjetých“'); }
  // druhému uživateli správce odebere povolení, jeho job mezitím selže
  db.setSettings({ auto_users: 'pajavlk' });
  const oj = started.find(j => db.getJob(j).owner_id === other.id);
  for (const it of db.getJobItems(oj)) db.updateJobItem(it.id, { status: 'failed', error: 'nevrátilo se po restartu', finished_at: db.now() }); db.updateJob(oj, { status: 'done', finished_at: db.now() });
  for (const j of started.filter(j => j !== oj)) { for (const it of db.getJobItems(j)) { db.updateJobItem(it.id, { status: 'done', finished_at: db.now() }); db.updateDevice(it.device_id, { version: '7.24.6' }); } db.updateJob(j, { status: 'done', finished_at: db.now() }); }
  const next = new Date(NOW.getTime() + day * 1000);
  await auto.tick(next);
  { const s = auto.statusFor(me); chk(s.open.length === 0 && s.history.length === 2 && s.history.some(h => h.group === 'A') && s.history.some(h => h.group === 'B'), 'po uzavření: historie nese jména skupin z doby spuštění (i smazané / přejmenované)'); }
  chk(auto.statusFor(other).allowed === false && groupsOf(other.id).length === 1, 'odebrané povolení: stav { allowed:false }, skupiny zůstávají uložené');
  { const uo = auto._state().users[other.id]; chk(uo.open.length === 0 && Object.keys(uo.failed).length === 1, 'BUG: uživateli s odebraným povolením se rozjetý job automatu nevyhodnotí (selhání se nezapíše, nezastaví ho, nepočítá do karantény verze), dokud ho správce znovu nepovolí'); } // BUG: lib/autoupgrade.js:292 — continue před evaluate()
  db.setSettings({ auto_users: 'pajavlk, jiny' });
  await auto.tick(new Date(next.getTime() + 60e3));
  { const uo = auto._state().users[other.id]; chk(uo.open.length === 0 && !uo.halted && /nevrátilo se/.test((Object.values(uo.failed)[0] || {}).error || ''), 'po opětovném povolení je selhaný kus v evidenci a automat se nezastavil'); }
  // karanténa: text s cizím zařízením
  { const st = auto._state(); const ver = '7.24.6'; st.fails[ver] = [999]; // jiný správce už na téže verzi selhal
    const d9 = mkDev(me.id, { name: 'TAJNE-JMENO-PAJA' }); auto.release(me.id); const us = auto._state().users[me.id];
    const j = db.createJob('x', {}, [d9], me.id); db.updateJobItem(db.getJobItems(j)[0].id, { status: 'failed', error: 'boom', finished_at: db.now() }); db.updateJob(j, { status: 'done', finished_at: db.now() });
    us.open.push({ jobId: j, night: '2026-11-24', group: 'A', targets: { 'v7-long-term': ver }, devs: { [d9]: ver } });
    auto.evaluate(me.id);
    chk(!!st.quarantine[ver], 'stejná verze selhala dvěma správcům → karanténa');
    chk(!JSON.stringify(auto.statusFor(db.getUser(other.id))).includes('TAJNE-JMENO-PAJA'), 'BUG: důvod karantény („naposledy <jméno zařízení>“) ukazuje všem uživatelům automatu název cizího zařízení'); // BUG: lib/autoupgrade.js:245 + :331 — h.label v textu, state.quarantine jde každému
    auto.unquarantine(ver); auto.release(me.id); }
  // zakázaný / smazaný uživatel
  db.updateUser(other.id, { disabled: 1 });
  chk(auto.statusFor(db.getUser(other.id)).allowed === false, 'zakázaný účet: { allowed:false }');
  await auto.tick(new Date(NOW.getTime() + 7 * day * 1000));
  chk(!db.listJobs(50).some(j => j.owner_id === other.id && j.id > started[started.length - 1] && j.options && j.options.auto), 'zakázanému účtu automat nic nespustí');
  db.deleteUser(other.id);
  chk(!thrown(() => auto.statusFor(me)), 'smazaný uživatel se skupinami: ostatním nic nespadne (jeho stav v souboru zůstává jako sirotek; id účtů se díky AUTOINCREMENT znovu nepoužijí)');
  const nu = mkUser('novy@x', 'novy'); db.setSettings({ auto_users: '*' });
  { const s = auto.statusFor(nu); chk(nu.id !== other.id && s.allowed && s.groups.length === 0 && s.pickable.length === 0, 'nový uživatel bez zařízení: prázdný stav, nedědí nic po smazaném'); }

  // --- výkon a chybějící verze
  console.log('\n== 1c) výkon statusFor');
  const big = mkUser('big@x', 'big'); const ids = []; let parent = 0;
  for (let i = 0; i < 600; i++) { const id = mkDev(big.id, i % 4 ? { parent_id: parent } : {}); if (i % 4 < 3) parent = id; ids.push(id); }
  for (let i = 0; i < 1500; i++) mkDev(me.id);
  for (let g = 0; g < 20; g++) auto.saveGroup(big.id, { name: 'G' + g, deviceIds: ids.filter((_, i) => i % 20 === g) });
  for (let j = 0; j < 20; j++) db.createJob('p' + j, {}, ids.slice(0, 1).concat(Array.from({ length: 40 }, (_, i) => ids[ids.length - 1] + 1 + j * 40 + i)), me.id);
  auto.statusFor(big); let calls = 0; const orig = db.pendingUpgrades; db.pendingUpgrades = (...a) => { calls++; return orig(...a); };
  const t0 = process.hrtime.bigint(); const sb = auto.statusFor(big); const ms = Number(process.hrtime.bigint() - t0) / 1e6; db.pendingUpgrades = orig;
  chk(sb.groups.length === 20 && sb.groups.reduce((a, g) => a + g.devs.length, 0) === 600 && ms < 1500, `statusFor pro 600 zařízení ve 20 skupinách (2100 zařízení v DB, 800 čekajících položek jobů): ${ms.toFixed(0)} ms`);
  chk(calls <= 1, `BUG: statusFor čte db.pendingUpgrades() pro každou skupinu zvlášť (${calls}× na jedno načtení stránky; stačí jednou)`); // BUG: lib/autoupgrade.js:125 — planGroup si inJob skládá sám, statusFor/launch/planFor ho volají v cyklu
  const gl = V.getLatest; V.getLatest = () => ({ mikrotik: {} });
  chk(!thrown(() => auto.statusFor(me)) && Object.keys(auto.statusFor(me).targets).length === 0 && auto.statusFor(me).groups.every(g => g.next.length === 0), 'chybějící verze kanálů: statusFor nespadne, nic se neplánuje');
  V.getLatest = () => ({}); chk(!thrown(() => auto.statusFor(me)), 'getLatest bez pole mikrotik: statusFor nespadne'); V.getLatest = gl;
}

function partPersist() {
  console.log('\n== 2) perzistence data/auto-upgrade.json');
  const run = (content) => {
    const pd = fs.mkdtempSync(path.join(os.tmpdir(), 'mtu-autog-p-'));
    fs.writeFileSync(path.join(pd, 'auto-upgrade.json'), content);
    const r = spawnSync(process.execPath, ['--no-warnings', __filename, '--persist', pd], { encoding: 'utf8' });
    try { fs.rmSync(pd, { recursive: true, force: true }); } catch {}
    const m = /RESULT(.*)/.exec(r.stdout || ''); return m ? JSON.parse(m[1]) : { crash: (r.stderr || '').slice(0, 300) };
  };
  const okAll = (r) => !r.crash && ['status', 'tick', 'save', 'delete'].every(k => !/^THROW/.test(String(r[k])));
  const first = (r) => r.crash || ['status', 'tick', 'save', 'delete'].map(k => String(r[k])).find(x => /^THROW/.test(x)) || (r.tick && r.tick.lastError) || '';
  let r = run(JSON.stringify({ users: { 1: { tracks: { 'v7-long-term': { wave: 2, version: '7.24.5' } }, last: { jobId: 5, night: '2026-11-19' }, history: [{ night: '2026-11-19', jobId: 5, wave: 1, total: 3, ok: 3 }] } }, fails: {}, quarantine: {} }));
  chk(okAll(r) && r.status.groups.length === 0 && r.status.history === 1 && Array.isArray(r.save), 'starý formát (tracks/last/history bez groups a open): načte se, historie zůstane, skupinu jde založit');
  for (const [k, c] of Object.entries({ 'prázdný soubor': '', 'useknutý JSON': '{"users": {"1": {"groups": [', 'null': 'null', 'pole': '[]', 'users jako pole': '{"users":[]}', 'uživatel null': '{"users":{"1":null}}', 'groups jako objekt': '{"users":{"1":{"groups":{"a":1}}}}', 'quarantine/fails null': '{"users":{},"quarantine":null,"fails":null}', 'failed pole, history a open řetězec': '{"users":{"1":{"groups":[{"id":1,"name":"A","devs":[1]}],"failed":[],"history":"x","open":"y"}}}', 'open s neexistujícím jobem': '{"users":{"1":{"groups":[{"id":1,"name":"A","devs":[1]}],"open":[{"jobId":999,"night":"2026-11-19","group":"A"}]}}}', 'devs jako řetězce': '{"users":{"1":{"groups":[{"id":1,"name":"A","devs":["1","2"]}]}}}' })) {
    r = run(c); chk(okAll(r) && !(r.tick && r.tick.lastError), `${k}: nic nespadne${okAll(r) ? '' : ' — ' + first(r)}`);
  }
  r = run('{"users": {"1": {"groups": [');
  chk(r.files && r.files.length > 1, 'BUG: nečitelný auto-upgrade.json se potichu bere jako prázdný a první uložení ho přepíše — skupiny všech uživatelů jsou pryč bez zálohy a bez hlášky v logu'); // BUG: lib/autoupgrade.js:37 — catch {} bez console.error a bez odložení poškozeného souboru
  for (const [k, c] of Object.entries({ 'skupina bez devs': '{"users":{"1":{"groups":[{"id":1,"name":"A"}]}}}', 'skupina null': '{"users":{"1":{"groups":[null]}}}', 'skupina bez názvu': '{"users":{"1":{"groups":[{"id":1,"devs":[1]}]}}}', 'devs řetězec, název číslo': '{"users":{"1":{"groups":[{"id":"1","name":5,"devs":"x"}]}}}', 'uživatel jako řetězec': '{"users":{"1":"x"}}', 'users jako řetězec': '{"users":"x"}' })) {
    r = run(c); chk(okAll(r) && !(r.tick && r.tick.lastError), `BUG: ${k} v souboru: ${first(r)} (GET /api/auto pak vrací 400 a stránka Automat se uživateli nenačte, noc se označí za hotovou)`); // BUG: lib/autoupgrade.js:39-43 — userState neopravuje tvar skupin (devs pole, name řetězec, id číslo) ani uživatele
  }
}

async function partHttp() {
  console.log('\n== 3) HTTP API /api/auto');
  const hd = fs.mkdtempSync(path.join(os.tmpdir(), 'mtu-autog-h-'));
  const PORT = 20000 + Math.floor(Math.random() * 20000);
  const seed = spawnSync(process.execPath, ['--no-warnings', __filename, '--seed', hd], { encoding: 'utf8' });
  const sm = /SEED(.*)/.exec(seed.stdout || ''); if (!sm) throw new Error('naplnění databáze selhalo: ' + seed.stderr);
  const I = JSON.parse(sm[1]);
  const env = { ...process.env, DATA_DIR: hd, PORT: String(PORT), HOST: '127.0.0.1', BASE_PATH: '', MTU_ADMIN_USER: 'admin', USERDB_URL: '', USERDB_KEY: '', RBDB_URL: '', SSO_ISSUER: '', MTU_SMTP_HOST: '' };
  // server se zaslepeným fetch: test nesmí sahat ven (verze si vezme z releases.json)
  const code = `globalThis.fetch = async () => { throw new Error('síť je v testu vypnutá'); }; require(${JSON.stringify(path.join(__dirname, '..', 'server.js'))});`;
  const srv = spawn(process.execPath, ['--no-warnings', '-e', code], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; srv.stdout.on('data', x => out += x); srv.stderr.on('data', x => out += x);
  const base = `http://127.0.0.1:${PORT}`;
  async function call(jar, p, opts = {}) {
    const r = await fetch(base + p, { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json', Cookie: Object.entries(jar || {}).map(([k, v]) => `${k}=${v}`).join('; ') }, body: opts.raw !== undefined ? opts.raw : opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
    if (jar) for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); const k = kv.slice(0, i), v = kv.slice(i + 1); if (v) jar[k] = v; else delete jar[k]; }
    const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
    return { status: r.status, j: j || {}, text };
  }
  try {
    let up = false; for (let i = 0; i < 80 && !up; i++) { await new Promise(r => setTimeout(r, 250)); try { up = (await fetch(base + '/api/whoami')).ok; } catch {} }
    if (!up) throw new Error('server nenaběhl:\n' + out);
    const J = { admin: {}, alice: {}, bob: {}, carol: {} };
    for (const u of Object.keys(J)) { const r = await call(J[u], '/api/login', { method: 'POST', body: { username: u, password: `heslo-${u}-1` } }); if (r.status !== 200) throw new Error(`přihlášení ${u}: ${r.text}`); }
    const grp = { name: 'x', deviceIds: [I.a1] };
    // nepřihlášený
    { const rs = []; for (const [m, p] of [['GET', '/api/auto'], ['POST', '/api/auto/groups'], ['DELETE', '/api/auto/groups/1'], ['PUT', '/api/auto'], ['POST', '/api/auto/release']]) rs.push((await call(null, p, { method: m, body: m === 'GET' ? undefined : grp })).status);
      chk(rs.every(s => s === 401), 'nepřihlášený: všude 401 (' + rs.join(',') + ')'); }
    // nepovolený účet
    { const g = await call(J.carol, '/api/auto'); chk(g.status === 200 && g.j.allowed === false && Object.keys(g.j).length === 1, 'nepovolený účet: GET vrací jen { allowed:false }');
      const rs = []; for (const [m, p] of [['POST', '/api/auto/groups'], ['DELETE', '/api/auto/groups/1'], ['PUT', '/api/auto'], ['POST', '/api/auto/release'], ['POST', '/api/auto/skip-night'], ['POST', '/api/auto/test-mail'], ['POST', '/api/auto/unquarantine'], ['PATCH', '/api/auto'], ['GET', '/api/auto/groups']]) rs.push((await call(J.carol, p, { method: m, body: m === 'GET' ? undefined : grp })).status);
      chk(rs.every(s => s === 403), 'nepovolený účet: všechno kromě GET /api/auto je 403 (' + rs.join(',') + ')'); }
    // uložení, cizí zařízení
    let r = await call(J.alice, '/api/auto/groups', { method: 'POST', body: { name: 'A <b>1</b>', delay_days: '3', deviceIds: [I.a1, String(I.a2), I.b1, I.ad1, 9999] } });
    chk(r.status === 200 && r.j.groups.length === 1 && r.j.groups[0].devs.join() === [I.a1, I.a2].join() && r.j.groups[0].delay_days === 3 && r.j.groups[0].name === 'A <b>1</b>', 'uložení skupiny: vezmou se jen vlastní zařízení, odpověď je nový stav');
    chk(r.j.pickable.slice().sort().join() === [I.a1, I.a2, I.a3, I.a4].sort().join(), 'pickable obsahuje jen vlastní zařízení');
    chk((await call(J.alice, '/api/auto/groups', { method: 'POST', body: { name: 'F', deviceIds: [I.b1] } })).status === 400, 'skupina jen z cizích zařízení → 400');
    // druhý uživatel
    await call(J.bob, '/api/auto/groups', { method: 'POST', body: { name: 'Bobova', deviceIds: [I.b1] } });
    await call(J.bob, '/api/auto/groups', { method: 'POST', body: { id: 1, name: 'Bobova2', deviceIds: [I.b1, I.a1] } });
    r = await call(J.bob, '/api/auto'); chk(r.j.groups.length === 1 && r.j.groups[0].devs.join() === String(I.b1) && !/A <b>|127\.9\.1\.1"/.test(r.text), 'druhý uživatel: úprava „id 1“ mění jeho skupinu, odpověď neobsahuje nic cizího');
    await call(J.bob, '/api/auto/groups/1', { method: 'DELETE' });
    r = await call(J.alice, '/api/auto'); chk(r.j.groups.length === 1 && r.j.groups[0].name === 'A <b>1</b>', 'DELETE skupiny 1 druhým uživatelem se cizí skupiny 1 nedotkne');
    // rozbité vstupy
    r = await call(J.alice, '/api/auto/groups', { method: 'POST', raw: '{"name": "x", ' }); chk(r.status === 400 && /JSON/.test(r.j.error), 'rozbitý JSON → 400 „neplatný JSON“');
    r = await call(J.alice, '/api/auto/groups', { method: 'POST', raw: '' }); chk(r.status === 400, 'prázdné tělo → 400');
    r = await call(J.alice, '/api/auto/groups', { method: 'POST', raw: 'null' }); chk(r.status === 400 && !/Cannot read|properties of/.test(r.j.error || ''), 'BUG: tělo „null“ vrací text výjimky JavaScriptu: ' + r.j.error); // BUG: lib/autoupgrade.js:102 (saveGroup), :61 (validate), server.js:662 (skip-night) — tělo není objekt
    r = await call(J.alice, '/api/auto', { method: 'PUT', raw: 'null' }); chk(r.status === 400 && !/Cannot use|operator/.test(r.j.error || ''), 'BUG: PUT /api/auto s tělem „null“ vrací text výjimky: ' + r.j.error); // BUG: lib/autoupgrade.js:61
    { let res = ''; try { res = String((await call(J.alice, '/api/auto/groups', { method: 'POST', raw: JSON.stringify({ name: 'h', deviceIds: [I.a3], pad: 'x'.repeat(3 * 1024 * 1024) }) })).status); } catch (e) { res = 'spojení ukončeno'; }
      chk(res === 'spojení ukončeno' || res === '400' || res === '413', 'tělo 3 MB se odmítne (' + res + ')');
      r = await call(J.alice, '/api/auto'); chk(r.status === 200 && r.j.groups.length === 1, 'po obřím těle server žije a nic se neuložilo'); }
    // metody
    { const rs = []; for (const [m, p] of [['GET', '/api/auto/groups'], ['PATCH', '/api/auto'], ['POST', '/api/auto'], ['DELETE', '/api/auto/groups'], ['DELETE', '/api/auto']]) rs.push((await call(J.alice, p, { method: m, body: m === 'GET' ? undefined : {} })).status);
      chk(rs.every(s => s === 404), 'špatné metody / cesty → 404 (' + rs.join(',') + ')'); }
    r = await call(J.alice, '/api/auto/groups/999', { method: 'DELETE' }); const r2 = await call(J.alice, '/api/auto/groups/abc', { method: 'DELETE' });
    chk(r.status === 404 && (r2.status === 404 || r2.status === 400), `BUG: DELETE neexistující (${r.status}) a nečíselné (${r2.status}) skupiny vrací 200 a zapíše do auditu „job smazán“`); // BUG: server.js:661 — deleteGroup nevrací, jestli něco smazal; audit se píše vždy
    chk((await call(J.alice, '/api/auto/unquarantine', { method: 'POST', body: { version: '7.1' } })).status === 403, 'zrušit karanténu smí jen správce (uživatel 403)');
    // prázdné výchozí zpoždění tak, jak ho pošle formulář
    r = await call(J.alice, '/api/auto', { method: 'PUT', body: { auto_delay_days: parseFloat('') } });
    chk(r.status === 400 || r.j.settings.auto_delay_days !== 0, `BUG: formulář s prázdným polem „výchozí zpoždění“ uloží 0 dní (HTTP ${r.status}, auto_delay_days=${r.j.settings && r.j.settings.auto_delay_days})`); // BUG: lib/autoupgrade.js:65 + public/app.js:1097
    await call(J.alice, '/api/auto', { method: 'PUT', body: { auto_delay_days: 5 } });
    // zásahy správce do zařízení ve skupině
    await call(J.alice, '/api/auto/groups', { method: 'POST', body: { id: 1, name: 'A', deviceIds: [I.a1, I.a2, I.a3] } });
    chk((await call(J.admin, '/api/devices/' + I.a2, { method: 'PUT', body: { owner_id: I.bob } })).status === 200 && (await call(J.admin, '/api/devices/' + I.a1, { method: 'DELETE' })).status === 200, 'správce jedno zařízení převede jinému a jedno smaže');
    r = await call(J.alice, '/api/auto'); const g0 = r.j.groups[0];
    chk(r.status === 200 && g0.devs.length === 3 && g0.devices.filter(x => /už není ve správě/.test(x.name)).length === 2 && g0.devices.filter(x => x.host).length === 1 && g0.next.length === 1, 'GET /api/auto po převodu a smazání: nespadne, dva kusy „(už není ve správě)“ bez adresy, plánuje se jen zbylý');
    await call(J.admin, '/api/devices/' + I.a3, { method: 'DELETE' });
    r = await call(J.alice, '/api/auto'); const gd = r.j.groups[0];
    r = await call(J.alice, '/api/auto/groups', { method: 'POST', body: { id: gd.id, name: gd.name, delay_days: gd.delay_days, enabled: !gd.enabled, deviceIds: gd.devs } });
    chk(r.status === 200, `BUG: skupinu, ve které nezbylo žádné dostupné zařízení, nejde tlačítkem vypnout (HTTP ${r.status}: ${r.j.error || ''}) — jde jen smazat`); // BUG: lib/autoupgrade.js:108
    // správce a pohled řadového správce
    r = await call(J.admin, '/api/auto/groups', { method: 'POST', body: { name: 'Adm', deviceIds: [I.ad1, I.a4, I.b1] } });
    chk(r.status === 200 && r.j.groups[0].devs.slice().sort().join() === [I.ad1, I.a4, I.b1].sort().join() && r.j.pickable.includes(I.a4) && r.j.pickable.includes(I.b1), 'správce nástroje: do jobu smí i cizí zařízení (20.11.2026)', JSON.stringify(r.j.groups[0].devs));
    const n1 = (await call(J.admin, '/api/auto')).j;
    chk(n1.groups[0].next.length === 3 && !n1.groups[0].devices.some(x => /už není ve správě/.test(x.name)), 'správce nástroje: cizí zařízení se plánují a ve výpisu mají název', JSON.stringify(n1.groups[0].skipped || {}));
    await call(J.admin, '/api/view-as', { method: 'POST', body: { user: true } });
    const n2 = (await call(J.admin, '/api/auto')).j;
    chk(JSON.stringify(n1.groups) === JSON.stringify(n2.groups) && n2.pickable.join() === String(I.ad1), 'pohled řadového správce (mtu_asuser): stejné joby, v nabídce jen vlastní zařízení');
    r = await call(J.admin, '/api/auto/groups', { method: 'POST', body: { name: 'AdmU', deviceIds: [I.a4] } });
    chk(r.status === 400, 'pohled řadového správce: nový job s cizím zařízením nejde uložit');
    chk((await call(J.admin, '/api/auto/unquarantine', { method: 'POST', body: { version: 'x' } })).status === 403, 'v pohledu řadového správce je zrušení karantény 403');
    r = await call(J.admin, '/api/auto/groups', { method: 'POST', body: { id: 1, name: 'Adm2', deviceIds: [I.ad1, I.a4] } });
    chk(r.status === 200 && r.j.groups[0].name === 'Adm2' && r.j.groups[0].devs.slice().sort().join() === [I.ad1, I.a4].sort().join(), 'v pohledu řadového správce jde job upravit; cizí zařízení, které v něm už bylo, zůstane');
    await call(J.admin, '/api/view-as', { method: 'POST', body: { user: false } });
    // odebrané povolení, pokus povolit si sám
    await call(J.admin, '/api/settings', { method: 'PUT', body: { auto_users: 'admin, bob' } });
    r = await call(J.alice, '/api/auto'); chk(r.status === 200 && r.j.allowed === false && !r.j.groups, 'po odebrání povolení: GET jen { allowed:false }');
    chk((await call(J.alice, '/api/auto/groups/1', { method: 'DELETE' })).status === 403 && (await call(J.alice, '/api/auto/groups', { method: 'POST', body: grp })).status === 403, 'po odebrání povolení: úpravy skupin 403');
    await call(J.alice, '/api/settings/mine', { method: 'PUT', body: { auto_users: '*', auto_pause: false } }); await call(J.bob, '/api/auto', { method: 'PUT', body: { auto_users: '*' } });
    chk((await call(J.alice, '/api/auto')).j.allowed === false && (await call(J.admin, '/api/settings')).j.global.auto_users === 'admin, bob', 'uživatel si auto_users nepřepíše vlastním nastavením ani přes PUT /api/auto');
    await call(J.admin, '/api/users/' + I.bob, { method: 'PUT', body: { disabled: true } });
    chk((await call(J.bob, '/api/auto')).status === 401, 'zakázaný účet: 401');
    // audit
    const au = (await call(J.admin, '/api/audit')); const rows = Array.isArray(au.j) ? au.j : [];
    const has = (user, action, detail) => rows.some(x => x.user === user && x.action === action && (!detail || detail.test(x.detail || '')));
    chk(has('alice', 'automat: job uložen', /„A <b>1<\/b>“, 2 zařízení, zpoždění 3/) && has('bob', 'automat: job smazán', /#1/) && has('admin', 'automat: job uložen', /Adm2/), 'audit: uložení i smazání skupiny se zapisuje pod správným účtem');
    chk(!rows.some(x => x.user === 'carol' && /^automat/.test(x.action)), 'audit: odmítnuté požadavky nepovoleného účtu se nezapisují jako provedené');
  } finally {
    srv.kill();
    await new Promise(r => setTimeout(r, 300));
    try { fs.rmSync(hd, { recursive: true, force: true }); } catch {}
  }
}

(async () => {
  try { await partLib(); } catch (e) { console.error(e.stack || e); bad++; }
  try { partPersist(); } catch (e) { console.error(e.stack || e); bad++; }
  try { await partHttp(); } catch (e) { console.error(e.stack || e); bad++; }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  console.log(bad ? `\nSELHALO: ${bad} (z toho ${bugs} označených BUG = známé chyby k opravě)` : '\nvše v pořádku');
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
