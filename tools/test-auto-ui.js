#!/usr/bin/env node
'use strict';
// Stránka Automat ve skutečném DOM (jsdom) nad skutečnou serverovou logikou (lib/autoupgrade.js, lib/db.js v dočasném DATA_DIR):
// escapování, editor jobu (hledání, hromadné označení, chyby, překreslení), formulář nastavení, stavy panelu, viditelnost.
// Server se nespouští (ten by hned zkoušel SSH na zkušební zařízení) — malé náhradní směrování /api/auto* níže kopíruje server.js.
// Kontroly označené „BUG:“ popisují chyby nalezené při testování 20.11.2026 a selhávají, dokud nejsou opravené.
// Použití: node tools/test-auto-ui.js   (exit 1 při selhání; bez jsdom se přeskočí jako tools/ui-real.js)
const fs = require('fs'), os = require('os'), path = require('path');
let JSDOM, VirtualConsole; try { ({ JSDOM, VirtualConsole } = require('jsdom')); } catch { console.log('test-auto-ui: jsdom není nainstalován (npm install), přeskakuji'); process.exit(0); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtu-autoui-'));
process.env.DATA_DIR = dir; process.env.MTU_SECRET = 'test-secret-1234567890'; process.env.MTU_PASSWORD = 'x'; process.env.USERDB_URL = ''; process.env.MTU_SMTP_HOST = '';
const nowSec = Date.now() / 1000, day = 86400;
fs.writeFileSync(path.join(dir, 'releases.json'), JSON.stringify({
  'v7-long-term': [{ version: '7.24.6', releasedAt: nowSec - 30 * day }], 'v7-stable': [{ version: '7.25.1', releasedAt: nowSec - 2 * day }], 'v6-long-term': [{ version: '6.49.24', releasedAt: nowSec - 40 * day }] }));
const db = require('../lib/db');
const V = require('../lib/versions');
const auto = require('../lib/autoupgrade');
const mail = require('../lib/mail');
const mails = []; let mailOn = true; mail.enabled = () => mailOn; mail.send = async (m) => { mails.push(m); return 'ok'; };

const NASTY = '<img src=x onerror="window.__xss=1">"\'&\\<script>window.__xss=2</script>';
const mkUser = (name, role) => { const id = db.insertUser({ name, pass_hash: '', role }); return db.getUser(id); };
let n = 0;
const mkDev = (owner, f = {}) => { const id = db.insertDevice({ host: `192.0.2.${++n}`, port: 22, owner_id: owner, username: 'a', password: 'b' }); db.updateDevice(id, { version: '7.24.4', scan_status: 'ok', userdb_member: 1, model: 'SXTsq', board_name: 'SXTsq', track: 'v7-long-term', name: 'kus ' + n, userdb_ap: 'AP ' + (n % 3), ...f }); return id; };
const me = mkUser('pajavlk', 'admin'), other = mkUser('kolega', 'user');
db.setSettings({ ...db.getSettings(), auto_users: 'pajavlk' }); // scéna „nepovolený účet“: správce automat omezil na vyjmenované účty (výchozí je *)
const D = [mkDev(me.id, { name: NASTY, identity: NASTY, model: NASTY, userdb_ap: NASTY, version: '7.20.1' }), mkDev(me.id, { name: 'Zluty kun', model: 'RB750' })];
for (let i = 0; i < 6; i++) D.push(mkDev(me.id));
const OD = mkDev(other.id, { name: 'kolegovo' });

// ---- náhrada serveru: /api/auto* podle server.js (větev „automatický upgrade“), zbytek jen tolik, aby se aplikace vykreslila
let uid = me.id, failAuto = false; const calls = [];
function route(method, p, b) {
  const user = db.getUser(uid); const admin = user.role === 'admin';
  const J = (status, data) => ({ status, data });
  if (p === '/whoami') return J(200, { authed: true, sso: false, passwordLogin: true, registration: false, admin, user: { id: user.id, name: user.name, canAdmin: admin }, userdb: { enabled: false }, serverStartedAt: Date.now() });
  if (p === '/login') { const u = db.listUsers().find(x => x.name === b.username); if (!u) return J(401, { error: 'špatné jméno nebo heslo' }); uid = u.id; return J(200, { ok: true }); }
  if (p === '/logout') return J(200, { ok: true });
  if (p.startsWith('/state')) return J(200, { devices: db.listDevices().filter(d => admin || d.owner_id === user.id), jobs: [], latest: V.getLatest(user.id), settings: db.getSettings(user.id), settingsOwn: db.getUserSettings(user.id), settingsGlobal: admin ? db.getSettings() : undefined, runner: { running: false, jobs: [] }, tracks: ['v7-long-term', 'v7-stable', 'v6-long-term'], scanning: [], checkProg: null, discovery: null, admin, autoAllowed: auto.allowed(user), user: { id: user.id, name: user.name, canAdmin: admin } });
  if (p === '/users') return J(200, db.listUsers());
  if (p.startsWith('/jobs/')) return J(404, { error: 'job neexistuje' });
  if (p === '/auto' || p.startsWith('/auto/')) {
    if (failAuto) throw new TypeError('Failed to fetch');
    if (method === 'GET' && p === '/auto') return J(200, auto.statusFor(user));
    if (method === 'POST' && p === '/auto/unquarantine') { if (!admin) return J(403, { error: 'tuhle akci smí jen správce' }); auto.unquarantine(String(b.version || '')); return J(200, auto.statusFor(user)); }
    if (!auto.allowed(user)) return J(403, { error: 'automatický upgrade pro tvůj účet zatím není povolený' });
    if (method === 'PUT' && p === '/auto') { const v = auto.validate(b); if (v.error) return J(400, { error: v.error }); db.setUserSettings(uid, { ...db.getUserSettings(uid), ...v.values }); return J(200, auto.statusFor(user)); }
    if (method === 'POST' && p === '/auto/groups/move') { const r = auto.moveGroup(uid, b.id, b.dir); if (r.error) return J(400, { error: r.error }); return J(200, auto.statusFor(user)); }
    if (method === 'POST' && p === '/auto/groups') { const r = auto.saveGroup(uid, b); if (r.error) return J(400, { error: r.error }); return J(200, auto.statusFor(user)); }
    if (method === 'DELETE' && p.startsWith('/auto/groups/')) { auto.deleteGroup(uid, p.split('/').pop()); return J(200, auto.statusFor(user)); }
    if (method === 'POST' && p === '/auto/skip-night') { auto.skipNight(user, b.skip !== false); return J(200, auto.statusFor(user)); }
    if (method === 'POST' && p === '/auto/release') { auto.release(uid); return J(200, auto.statusFor(user)); }
    if (method === 'POST' && p === '/auto/test-mail') return auto.testMail(user, b.to).then(to => J(200, { ...auto.statusFor(user), sent: to.join(', ') }), e => J(502, { error: 'e-mail se nepodařilo odeslat: ' + e.message }));
  }
  return J(404, { error: 'not found' });
}

const root = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/<script src="[^"]*"><\/script>/g, '');
const errors = [];
const vc = new VirtualConsole(); vc.on('jsdomError', (e) => errors.push(String(e && e.message || e))); vc.on('error', (m) => errors.push(String(m)));
const unhandled = []; process.on('unhandledRejection', (e) => unhandled.push(String(e && e.message || e)));
const dom = new JSDOM(html, { url: 'http://127.0.0.1:1/mikrotik/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc });
const w = dom.window, doc = w.document;
w.fetch = async (url, opts = {}) => {
  const p = String(url).replace(/^.*?\/api/, ''); const method = opts.method || 'GET'; const body = opts.body ? JSON.parse(opts.body) : {};
  calls.push({ method, p, body, raw: opts.body });
  const r = await route(method, p, body);
  // JSON tam i zpět: undefined zmizí a NaN se změní na null stejně jako po síti
  const data = JSON.parse(JSON.stringify(r.data));
  return { status: r.status, ok: r.status >= 200 && r.status < 300, statusText: String(r.status), headers: { get: () => 'application/json' }, json: async () => data, text: async () => JSON.stringify(data) };
};
w.EventSource = function () { this.close = () => {}; };
const confirms = []; let confirmAnswer = true;
w.scrollTo = () => {}; w.confirm = (m) => { confirms.push(String(m)); return confirmAnswer; }; w.prompt = () => null; w.alert = () => {};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ev = (code) => w.eval(code);
const $ = (s) => doc.querySelector(s), $$ = (s) => [...doc.querySelectorAll(s)];
const txt = (s = '#autobox') => { const e = $(s); return e ? e.textContent : ''; };
const toast = () => { const t = $('#toast'); return t && t.style.display !== 'none' ? { err: /err/.test(t.className), text: t.textContent } : null; };
const hideToast = () => { const t = $('#toast'); if (t) t.style.display = 'none'; };
const type = (el, v) => { el.focus(); el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); };
const fresh = async () => { ev('state.autoAt = 0; state.autoEdit = null; state.autoDraft = null; if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); state.view = "auto"; render()'); await sleep(40); };
const us = () => auto._state().users[String(me.id)];
let bad = 0;
const chk = (ok, msg, extra = '') => { if (!ok) { console.error('  ✗ ' + msg + (extra ? ' — ' + extra : '')); bad++; } else console.log('  ✓ ' + msg); };
const noJunk = (where) => { const t = txt('#main'); const m = t.match(/undefined|NaN|\bnull\b|Invalid Date|\[object|1\. 1\. 1970/); chk(!m && !errors.length, `${where}: bez výjimky a bez „undefined/NaN/null“`, m ? `…${t.slice(Math.max(0, m.index - 60), m.index + 30)}…` : errors.join(' | ')); errors.length = 0; };

(async () => {
  try {
    const sc = doc.createElement('script'); sc.textContent = fs.readFileSync(path.join(root, 'app.js'), 'utf8'); doc.body.appendChild(sc);
    await sleep(300);
    chk(ev('state.authed && state.autoAllowed') === true && !errors.length, 'aplikace naběhla, účet má automat povolený', errors.join(' | '));

    console.log('viditelnost');
    chk(!!$('nav button[data-view=auto]'), 'povolený účet má položku Automat v menu');
    $('nav button[data-view=auto]').click(); await sleep(60);
    chk(!!$('#autof') && !!$('#autognew'), 'stránka Automat se vykreslí (formulář nastavení + tlačítko nového jobu)');
    noJunk('prázdný automat bez jobů');

    console.log('editor jobu');
    $('#autognew').click();
    chk(!!$('#autoedit') && $$('#autogrows tr[data-txt]').length === D.length, 'nový job: editor s mými zařízeními', `řádků ${$$('#autogrows tr[data-txt]').length}`);
    chk(!$('#autobox img') && !$('#autobox script') && !w.__xss, 'editor: název/identity/model/APčko zařízení se neinterpretují jako HTML');
    chk($$('#autog button:not([type])').length === 1 && $$('#autog button[type=button]').length === 3, 'editor: jediné odesílací tlačítko, ostatní type="button"');
    calls.length = 0; $('#autog button.primary').click(); await sleep(30);
    chk(toast() && toast().err && /název/.test(toast().text) && !!$('#autoedit'), 'uložení bez názvu: chyba, editor zůstane');
    type($('#autog [name=name]'), 'G ' + NASTY); type($('#autog [name=delay_days]'), '3');
    hideToast(); $('#autog button.primary').click(); await sleep(30);
    chk(toast() && toast().err && /zařízení/.test(toast().text) && !!$('#autoedit') && $('#autog [name=name]').value === 'G ' + NASTY && $('#autog [name=delay_days]').value === '3', 'uložení bez zařízení: chyba, editor zůstane s rozepsanými hodnotami');
    const q = $('#autogq'); type(q, 'ZLUTY');
    const vis = () => $$('#autogrows tr[data-txt]').filter(r => !r.hidden);
    chk(vis().length === 1 && /Zluty kun/.test(vis()[0].textContent), 'hledání filtruje řádky bez ohledu na velikost písmen', `viditelných ${vis().length}`);
    const kd = new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }); q.dispatchEvent(kd);
    chk(kd.defaultPrevented, 'Enter ve vyhledávání formulář neodešle');
    $('#autogall').click();
    chk(ev('state.autoEdit.sel.size') === 1 && $('#autogcnt').textContent === '1', '„označit zobrazené“ při filtru označí jen zobrazené, počítadlo sedí');
    type(q, '');
    chk(vis().length === D.length && $$('#autogrows input:checked').length === 1, 'po zrušení filtru jsou vidět všechna a výběr zůstal');
    $('#autogall').click(); type(q, 'zluty'); $('#autognone').click(); type(q, '');
    chk(ev('state.autoEdit.sel.size') === D.length - 1, '„odznačit zobrazené“ při filtru odznačí jen zobrazené');
    // překreslení celé stránky (živá událost, klik jinde) nesmí rozepsaný job ztratit
    doc.activeElement.blur(); ev('render()'); await sleep(30);
    chk(!!$('#autoedit') && $('#autog [name=name]').value === 'G ' + NASTY && $$('#autogrows input:checked').length === D.length - 1, 'výběr a název přežijí překreslení stránky');
    ev('state.view = "devices"; render()'); await sleep(20); ev('state.view = "auto"; render()'); await sleep(30);
    chk(!!$('#autoedit') && ev('state.autoEdit.sel.size') === D.length - 1, 'odchod na jinou stránku a návrat: rozepsaný job zůstane');
    { // BUG: public/app.js:1076 (drawAuto přepíše #autobox celý) — seznam zařízení v editoru po překreslení odskroluje na začátek
      const tw = $('#autoedit .tablewrap'); tw.scrollTop = 120;
      if (tw.scrollTop === 120) { $$('#autogrows input')[5].focus(); ev('renderLive()'); await sleep(30); chk($('#autoedit .tablewrap').scrollTop === 120, 'BUG: překreslení z pozadí během zaškrtávání zachová pozici seznamu zařízení', `scrollTop ${$('#autoedit .tablewrap').scrollTop}`); }
    }
    calls.length = 0; hideToast(); $('#autog button.primary').click(); await sleep(40);
    chk(!$('#autoedit') && toast() && !toast().err && us().groups.length === 1 && us().groups[0].devs.length === D.length - 1 && us().groups[0].delay_days === 3, 'uložení jobu: editor se zavře, skupina je na serveru');
    chk(!$('#autobox img') && !$('#autobox script') && !w.__xss && txt().includes('G ' + NASTY), 'panel: název skupiny a zařízení se neinterpretují jako HTML');
    noJunk('panel s jedním jobem');
    { // BUG: public/app.js:1091 — dvojí odeslání (dvojklik na Uložit) pošle dva POSTy; druhý skončí chybou „job s tímhle názvem už máš“, přestože se uložilo
      $('#autognew').click(); type($('#autog [name=name]'), 'Dvojklik'); $(`[data-gdev="${D[1]}"]`).click();
      calls.length = 0; hideToast(); const b = $('#autog button.primary'); b.click(); b.click(); await sleep(50);
      chk(calls.filter(c => c.p === '/auto/groups').length === 1 && !(toast() && toast().err), 'BUG: dvojklik na „Uložit job“ odešle jeden požadavek a neskončí chybou', `požadavků ${calls.filter(c => c.p === '/auto/groups').length}, toast ${JSON.stringify(toast())}`);
      await fresh();
    }

    console.log('hlavní panel: joby');
    const gid = us().groups[0].id;
    { // BUG: public/app.js:1031 — vypnutý job (a job při vynechané noci) pořád hlásí „Nejbližší noc půjde N“
      us().groups.find(g => g.name === 'Dvojklik').enabled = false; await fresh();
      const p = $$('[data-group]').find(e => /Dvojklik/.test(e.textContent));
      chk(p && /vypnutý/.test(p.textContent) && !/Nejbližší noc půjde \d/.test(p.textContent), 'BUG: vypnutý job netvrdí „Nejbližší noc půjde N“', p ? p.textContent.replace(/\s+/g, ' ').slice(0, 160) : '');
    }
    { // BUG: public/app.js:1010/1022 + lib/autoupgrade.js:106 — kus, který už není ve výběru (smazaný, cizí, neřízený), se v editoru počítá jako vybraný, ale není vidět
      us().groups[0].devs.push(987654); await fresh();
      $(`[data-gedit="${gid}"]`).click();
      chk(+$('#autogcnt').textContent === $$('#autogrows input:checked').length, 'BUG: počítadlo „vybráno“ odpovídá zaškrtnutým řádkům i u jobu se zaniklým zařízením', `počítadlo ${$('#autogcnt').textContent}, zaškrtnuto ${$$('#autogrows input:checked').length}`);
      $('#autogcancel').click();
      chk(!$('#autoedit') && ev('state.autoEdit') === null, '„Zrušit“ editor zavře');
    }
    { // BUG: public/app.js:1103 — Vypnout/Zapnout posílá celý job znovu (deviceIds), server zaniklé kusy potichu vyhodí …
      $(`[data-gtoggle="${gid}"]`).click(); await sleep(40);
      chk(us().groups[0].enabled === false, 'Vypnout job vypne');
      chk(us().groups[0].devs.includes(987654), 'BUG: Vypnout/Zapnout nemění seznam zařízení jobu (dočasně nedostupný kus z něj nevypadne)', `devs ${JSON.stringify(us().groups[0].devs)}`);
      // … a job, kterému nezbylo žádné dostupné zařízení, nejde vypnout ani zapnout („vyber aspoň jedno zařízení“)
      const g2 = us().groups.find(g => g.name === 'Dvojklik'); g2.devs = [987655]; g2.enabled = true; await fresh();
      hideToast(); $(`[data-gtoggle="${g2.id}"]`).click(); await sleep(40);
      chk(g2.enabled === false && !(toast() && toast().err), 'BUG: job bez dostupných zařízení jde vypnout', JSON.stringify(toast()));
      us().groups[0].enabled = true; us().groups[0].devs = us().groups[0].devs.filter(id => id !== 987654); await fresh();
    }
    { // smazání s potvrzením
      const g2 = us().groups.find(g => g.name === 'Dvojklik');
      confirms.length = 0; confirmAnswer = false; $(`[data-gdel="${g2.id}"]`).click(); await sleep(30);
      chk(confirms.length === 1 && us().groups.length === 2, 'Smazat: odmítnuté potvrzení nic nesmaže');
      { // pořadí jobů: číslování a šipky
        const ids0 = us().groups.map(g => g.id); const heads = () => $$('[data-group] h2').map(h => h.textContent.trim().slice(0, 2)).join('');
        chk(heads() === '1.2.' && $$('[data-gmove="up"]')[0].disabled && $$('[data-gmove="down"]')[1].disabled && !$$('[data-gmove="down"]')[0].disabled, 'joby jsou očíslované; první nejde nahoru, poslední dolů');
        $$('[data-gmove="down"]')[0].click(); await sleep(40);
        chk(us().groups.map(g => g.id).join() === [...ids0].reverse().join() && $$('[data-group]').map(e => +e.dataset.group).join() === [...ids0].reverse().join() && heads() === '1.2.', 'šipka dolů job posune, stránka se překreslí v novém pořadí');
        $$('[data-gmove="up"]')[1].click(); await sleep(40);
        chk(us().groups.map(g => g.id).join() === ids0.join(), 'šipka nahoru ho vrátí');
      }
      confirmAnswer = true; $(`[data-gdel="${g2.id}"]`).click(); await sleep(40);
      chk(us().groups.length === 1 && !/Dvojklik/.test(txt()), 'Smazat: po potvrzení job zmizí');
    }
    { // BUG: public/app.js:1111 (loadAuto, keš 30 s) — po smazání zařízení jinde stránka dál ukazuje staré joby a sama se neobnoví
      const victim = D[7]; const name = db.getDevice(victim).name; await fresh();
      chk(txt().includes(name), 'zařízení jobu je v panelu vidět');
      db.deleteDevice(victim); calls.length = 0;
      ev(`state.devices = state.devices.filter(d => d.id !== ${victim}); renderLive()`); await sleep(60); // totéž udělá SSE „device-deleted“
      chk(calls.some(c => c.p === '/auto') || !$$('[data-group] table').some(t => t.textContent.includes(name)), 'BUG: po smazání zařízení (událost device-deleted) se plán jobů načte znovu', 'smazané zařízení je dál v „Nejbližší noc půjde“');
      await fresh();
    }

    console.log('formulář nastavení');
    const f = () => $('#autof');
    chk($$('#autof button:not([type])').length === 1, 'formulář: jediné odesílací tlačítko (Uložit)');
    { // BUG: public/app.js:1097 — parseFloat('') = NaN → JSON null → server Number(null) = 0: smazané pole uloží zpoždění 0 dní
      type(f().elements.auto_delay_days, ''); doc.activeElement.blur(); hideToast(); f().querySelector('button.primary').click(); await sleep(40);
      chk(db.getSettings(me.id).auto_delay_days === 5 || (toast() && toast().err), 'BUG: prázdné „výchozí zpoždění“ se neuloží jako 0 dní (chyba, nebo zůstane původních 5)', `uloženo ${db.getSettings(me.id).auto_delay_days}, odesláno ${(calls.filter(c => c.method === 'PUT').pop() || {}).raw}`);
      db.setUserSettings(me.id, { ...db.getUserSettings(me.id), auto_delay_days: 5 }); await fresh();
    }
    type(f().elements.auto_window, '25:00-xx'); hideToast(); f().querySelector('button.primary').click(); await sleep(40);
    chk(toast() && toast().err && /okno/.test(toast().text) && f().elements.auto_window.value === '25:00-xx' && db.getSettings(me.id).auto_window === '01:00-04:30', 'neplatné okno: chyba, rozepsaná hodnota zůstane, nic se neuloží');
    { // BUG: public/app.js:1076 — rozepsané nastavení není nikde uložené; stačí překreslení z pozadí ve chvíli, kdy fokus není v textovém poli (po kliknutí na Uložit je na tlačítku)
      f().querySelector('button.primary').focus(); ev('renderLive()'); await sleep(40);
      chk(f().elements.auto_window.value === '25:00-xx', 'BUG: překreslení z pozadí nezahodí rozepsané (neuložené) nastavení', `v poli je „${f().elements.auto_window.value}“`);
      await fresh();
    }
    $$('#autof [name=auto_day]').forEach(c => { if (c.checked) c.click(); }); hideToast(); f().querySelector('button.primary').click(); await sleep(40);
    chk(toast() && toast().err && /den/.test(toast().text), 'žádný den v týdnu: chyba');
    await fresh();
    confirms.length = 0; confirmAnswer = false; calls.length = 0; f().elements.auto_enable.click(); f().querySelector('button.primary').click(); await sleep(40);
    chk(confirms.length === 1 && /01:00-04:30/.test(confirms[0]) && !calls.some(c => c.method === 'PUT'), 'zapnutí: potvrzovací dialog, odmítnutí nic neodešle');
    confirmAnswer = true; f().querySelector('button.primary').click(); await sleep(40);
    chk(db.getSettings(me.id).auto_enable === true && !$('#autoskip') && /nejbližší okno/.test(txt('#autof')), 'zapnutí po potvrzení: uloženo, ukáže nejbližší okno (tlačítko „vynechat noc“ zrušeno)');
    noJunk('zapnutý automat');
    type(f().elements.auto_mail_to, 'a@b.test, <x>"@c'); hideToast(); f().querySelector('button.primary').click(); await sleep(40);
    chk(toast() && toast().err && /e-mail/.test(toast().text), 'neplatná adresa pro hlášení: chyba');
    { // BUG: public/app.js:1107 + lib/autoupgrade.js:339 — zkušební e-mail jde na ULOŽENOU adresu; rozepsanou ignoruje (bez uložené adresy hlásí „vyplň adresu“, i když vyplněná je) a po úspěchu ji překreslení smaže
      doc.activeElement.blur(); await fresh();
      type(f().elements.auto_mail_to, 'nova@example.test'); doc.activeElement.blur(); mails.length = 0; hideToast(); $('#automail').click(); await sleep(40);
      chk(mails.some(m => String(m.to).includes('nova@example.test')), 'BUG: zkušební e-mail odejde na adresu vyplněnou ve formuláři', `odesláno: ${JSON.stringify(mails.map(m => m.to))}, toast ${JSON.stringify(toast())}`);
      await fresh();
    }

    console.log('stavy panelu');
    Object.assign(us(), { halted: `job #5 „${NASTY}“: ${NASTY}`, haltedAt: Date.now() - 3600e3, failed: { [D[2]]: { version: '7.24.6', at: 1, error: NASTY, label: NASTY } }, lastError: { at: Date.now() - day * 1000, error: NASTY }, mailError: { at: Date.now() - 7200e3, error: NASTY },
      open: [{ jobId: 777, night: '2026-11-19', at: 1, group: NASTY, groupId: 1, targets: {}, devs: {} }], history: [{ night: '2026-11-18', jobId: 5, group: NASTY, targets: { 'v7-long-term': '7.24.6' + NASTY }, total: 3, ok: 1, failed: 2, unreachable: 0, skipped: 0 }] });
    auto._state().quarantine['7.99.1' + NASTY] = 'selhala ' + NASTY;
    await fresh();
    chk(!!$('#autorelease') && $$('#autobox .banner').length >= 4 && !!$('[data-unq]') && $$('[data-autojob]').length === 2, 'zastaveno po chybě + chyba spuštění + chyba e-mailu + karanténa + rozjetý job + historie se vykreslí');
    chk(!$('#autobox img') && !$('#autobox script') && !w.__xss, 'texty chyb, karanténa, historie a název skupiny se neinterpretují jako HTML');
    chk($('[data-unq]').dataset.unq === '7.99.1' + NASTY, 'verze v atributu data-unq je správně escapovaná');
    noJunk('zastavený automat');
    { // BUG: public/app.js:1109 — odkaz na job, který už neexistuje (historie drží 40 nocí, joby se mažou): nic se nestane, jen nezachycená výjimka
      unhandled.length = 0; hideToast(); $('[data-autojob="5"]').click(); await sleep(60);
      chk(!unhandled.length && toast() && toast().err, 'BUG: klik na smazaný job z historie ohlásí chybu (ne nezachycené odmítnutí)', `nezachyceno: ${unhandled.join(' | ')}`);
      unhandled.length = 0; ev('state.view = "auto"');
    }
    $('#autorelease').click(); await sleep(40);
    chk(!us().halted && !$('#autorelease') && !$('#autobox .banner.err'), '„Zkontroloval jsem, uvolnit“ zastavení zruší');
    $('[data-unq]').click(); await sleep(40);
    chk(!Object.keys(auto._state().quarantine).length && !$('[data-unq]'), 'správce zruší karanténu verze');
    mailOn = false; await fresh();
    chk(/MTU_SMTP_HOST/.test(txt('#autof')) && !$('#automail'), 'server bez SMTP: upozornění a bez tlačítka zkušebního e-mailu');
    noJunk('bez SMTP'); mailOn = true;
    db.setUserSettings(me.id, { ...db.getUserSettings(me.id), auto_window: 'nesmysl' }); db.setSettings({ ...db.getSettings(), auto_pause: true }); await fresh();
    chk(/Noční okno nejde přečíst/.test(txt()) && /pozastavil/.test(txt()) && !$('#autoskip'), 'neplatné okno + pozastaveno správcem: obě upozornění, bez „vynechat noc“');
    noJunk('neplatné okno, pozastaveno');
    db.setUserSettings(me.id, { ...db.getUserSettings(me.id), auto_window: '01:00-04:30', auto_enable: false }); db.setSettings({ ...db.getSettings(), auto_pause: false });
    us().groups[0].enabled = true; us().history = []; us().open = []; delete us().lastError; delete us().mailError; await fresh();
    chk(/Automat je vypnutý/.test(txt()), 'vypnutý automat: upozornění, že joby jsou jen náhled');
    noJunk('vypnutý automat');
    { // BUG: public/app.js:1029 — verze bez známého data vydání (lib/autoupgrade.js:90: matureAt = 0) se u čekajících kusů vypíše jako „dozraje 1. 1. 1970“
      ev(`state.auto = JSON.parse(JSON.stringify(state.auto)); state.auto.groups[0].next = []; state.auto.groups[0].waiting = [{ id: 1, name: 'a', version: '7.1', to: '7.2', matureAt: 0 }]; drawAuto()`);
      chk(!/1970/.test(txt()), 'BUG: čekající kus s neznámým datem vydání cíle se nevypíše jako „dozraje 1. 1. 1970“', (txt().match(/Čeká na dozrání[^.]*\./) || [''])[0]);
    }
    { // BUG: public/app.js:1041–1061 — odpověď bez některých polí (starší server při nasazování) shodí vykreslení
      const r = ev(`(() => { const keep = state.auto; try { state.auto = { allowed: true, settings: keep.settings, windowValid: true }; drawAuto(); return 'ok'; } catch (e) { return e.message; } finally { state.auto = keep; } })()`);
      chk(r === 'ok', 'BUG: odpověď bez polí mail/groups/pickable/open nevyhodí výjimku', r);
      const r2 = ev(`(() => { const keep = state.auto; try { state.auto = { allowed: true, settings: keep.settings, windowValid: true, mail: { enabled: false, to: '' } }; drawAuto(); const t = document.querySelector('#autobox').textContent; state.autoEdit = { id: 0, name: '', delay: '', enabled: true, sel: new Set(), q: '' }; drawAuto(); return /undefined|NaN|null/.test(t + document.querySelector('#autobox').textContent) ? 'undefined v textu' : 'ok'; } catch (e) { return e.message; } finally { state.auto = keep; state.autoEdit = null; } })()`);
      chk(r2 === 'ok', 'odpověď bez groups/pickable/open/history se vykreslí (panel i editor)', r2);
    }
    { // BUG: public/app.js:1112–1115 — když se /api/auto nepodaří načíst, stránka zůstane prázdná bez jediného slova
      failAuto = true; ev('state.auto = null; state.autoAt = 0; render()'); await sleep(60); failAuto = false;
      chk(txt().trim().length > 0, 'BUG: nepovedené načtení /api/auto stránka ohlásí (není prázdná)', `obsah #autobox: „${txt()}“`);
      await fresh();
    }

    console.log('fokus a prohlížeče, kde klik na tlačítko fokus nepřevezme (Safari, Firefox na macOS)');
    { // BUG: public/app.js:1075 — ochrana „nepřepisovat rozepsaný formulář“ spolkne i překreslení vyvolané uživatelem
      f().elements.auto_window.focus(); $('#autognew').click();
      chk(!!$('#autoedit'), 'BUG: „+ Nový job“ otevře editor, i když fokus zůstal v textovém poli nastavení');
      doc.activeElement.blur(); ev('state.autoEdit = { id: 0, name: "", delay: "", enabled: true, sel: new Set(), q: "" }; drawAuto()');
      type($('#autog [name=name]'), 'Rozepsany'); $('#autogcancel').click();
      chk(!$('#autoedit'), 'BUG: „Zrušit“ zavře editor, i když fokus zůstal v poli názvu (jinak jde „zrušený“ job dál uložit)');
      doc.activeElement.blur(); await fresh();
    }

    console.log('souhra se zbytkem aplikace');
    { // BUG: lib/db.js:291 + public/app.js:1210 — „Zahodit vlastní hodnoty“ na stránce Nastavení smaže i nastavení automatu (vypne ho, okno, dny, adresu) bez varování
      db.setUserSettings(me.id, { ...db.getUserSettings(me.id), auto_enable: true, auto_window: '02:00-03:00', auto_mail_to: 'x@y.test' });
      { const keep = Object.fromEntries(Object.entries(db.getUserSettings(me.id)).filter(([k]) => auto.KEYS.includes(k))); db.clearUserSettings(me.id); db.setUserSettings(me.id, keep); } // totéž udělá DELETE /api/settings/mine (server.js)
      const s = db.getSettings(me.id);
      chk(s.auto_enable === true && s.auto_window === '02:00-03:00', 'BUG: zrušení vlastního nastavení (Nastavení → zahodit vlastní hodnoty) nevypne automat a nesmaže jeho okno', `auto_enable=${s.auto_enable}, auto_window=${s.auto_window}`);
    }
    { // mobilní šířka: tabulky .cards přepisují display řádků — atribut hidden pak nic neschová
      const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
      const cards = /table\.cards tr\{[^}]*display:block/.test(css);
      const hiddenRule = /\[hidden\][^{}]*\{[^}]*display:\s*none\s*!important/.test(css);
      // BUG: public/style.css:222 + public/app.js:1016/1084 — na mobilu (karty) hledání v editoru nic neskryje (ověřeno v Chromiu 390 px: 9 řádků hidden, všech 10 vidět)
      chk(!cards || hiddenRule, 'BUG: řádky skryté hledáním (atribut hidden) zůstanou skryté i v mobilním zobrazení tabulek .cards', 'style.css nemá pravidlo [hidden]{display:none!important} a table.cards tr{display:block} atribut přebije');
    }
    console.log('nepovolený účet a přihlášení jiného účtu ve stejném okně');
    await fresh(); $(`[data-gedit="${gid}"]`).click();
    $('#logout').click(); await sleep(40);
    const un = $('#un'), pw = $('#pw'); un.value = 'kolega'; pw.value = 'x'; $('#loginf').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); await sleep(120);
    chk(ev('state.auth.user.name') === 'kolega' && ev('state.autoAllowed') === false && !$('nav button[data-view=auto]'), 'nepovolený účet nemá položku Automat');
    ev('state.view = "auto"; render()'); await sleep(40);
    chk(!$('#autobox') && !/G <img/.test(txt('#main')), 'nepovolený účet po ručním přechodu na stránku Automat nic z automatu nevidí');
    const r403 = await route('POST', '/auto/groups', { name: 'x', deviceIds: [OD] });
    chk(r403.status === 403, 'server nepovolenému účtu uložení jobu odmítne');
    { // BUG: public/app.js:163 ($('#logout').onclick) — state.auto / state.autoEdit / state.autoAt přežijí odhlášení; další účet v témže okně vidí joby (názvy, zařízení, adresu, chyby) předchozího a jeho rozepsaný editor
      db.setSettings({ ...db.getSettings(), auto_users: '*' });
      await ev('loadState()'); ev('state.view = "auto"; render()'); await sleep(60);
      chk(!$('#autoedit') && !txt().includes('G <img'), 'BUG: po odhlášení a přihlášení jiného účtu ve stejném okně nejsou vidět joby předchozího účtu', $('#autoedit') ? 'otevřený editor cizího jobu „' + $('#autog [name=name]').value.slice(0, 20) + '…“' : 'cizí joby v panelu');
    }
    chk(!errors.length && !unhandled.length, 'za celý běh žádná výjimka v prohlížeči', [...errors, ...unhandled].join(' | '));
  } catch (e) { console.error('  ✗ test spadl: ' + (e.stack || e)); bad++; }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  console.log(bad ? `test-auto-ui: ${bad} kontrol selhalo` : 'test-auto-ui: OK');
  process.exit(bad ? 1 : 0);
})();
