'use strict';
// Přihlášení přes OpenID Connect (Keycloak SSO). Authorization code flow + PKCE, session v podepsané cookie.
const crypto = require('crypto');
const cfg = require('./config');

let meta = null, metaAt = 0;
const states = new Map(); // state -> {verifier, nonce, exp, next}

function enabled() { return !!(cfg.sso.clientId && cfg.sso.clientSecret && cfg.sso.discoveryUrl); }

async function discovery() {
  if (meta && Date.now() - metaAt < 6 * 3600e3) return meta;
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 10000);
  try {
    const r = await fetch(cfg.sso.discoveryUrl, { signal: ac.signal });
    if (!r.ok) throw new Error(`SSO discovery HTTP ${r.status}`);
    meta = await r.json(); metaAt = Date.now();
    return meta;
  } finally { clearTimeout(t); }
}

function b64url(buf) { return Buffer.from(buf).toString('base64url'); }

/** vrátí URL, kam přesměrovat prohlížeč */
async function loginUrl(next = '') {
  const m = await discovery();
  const state = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const nonce = b64url(crypto.randomBytes(16));
  for (const [k, v] of states) if (v.exp < Date.now()) states.delete(k);
  states.set(state, { verifier, nonce, exp: Date.now() + 10 * 60e3, next });
  const u = new URL(m.authorization_endpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', cfg.sso.clientId);
  u.searchParams.set('redirect_uri', cfg.sso.redirectUri);
  u.searchParams.set('scope', cfg.sso.scope);
  u.searchParams.set('state', state);
  u.searchParams.set('nonce', nonce);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

/** výměna kódu za token + userinfo; vrací {email, name, sub, next} */
async function callback(code, state) {
  const st = states.get(state);
  if (!st || st.exp < Date.now()) throw new Error('neplatný nebo expirovaný stav přihlášení, zkus to znovu');
  states.delete(state);
  const m = await discovery();
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: cfg.sso.redirectUri, client_id: cfg.sso.clientId, client_secret: cfg.sso.clientSecret, code_verifier: st.verifier });
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 15000);
  let tok;
  try {
    const r = await fetch(m.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: ac.signal });
    tok = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(tok.error_description || tok.error || `SSO token HTTP ${r.status}`);
  } finally { clearTimeout(t); }
  // userinfo (ověřený serverem SSO)
  const ac2 = new AbortController(); const t2 = setTimeout(() => ac2.abort(), 15000);
  let ui;
  try {
    const r = await fetch(m.userinfo_endpoint, { headers: { authorization: 'Bearer ' + tok.access_token }, signal: ac2.signal });
    ui = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`SSO userinfo HTTP ${r.status}`);
  } finally { clearTimeout(t2); }
  // nonce z id_token (bez ověření podpisu — identita bereme z userinfo přes back-channel)
  try { const p = JSON.parse(Buffer.from(String(tok.id_token || '').split('.')[1] || '', 'base64url').toString('utf8')); if (p.nonce && p.nonce !== st.nonce) throw new Error('nonce nesouhlasí'); } catch (e) { if (/nonce/.test(e.message)) throw e; }
  const email = String(ui.email || ui.preferred_username || '').toLowerCase();
  const name = ui.name || ui.preferred_username || email;
  if (!email) throw new Error('SSO nevrátilo e-mail ani uživatelské jméno');
  const allowed = cfg.sso.allowedEmails;
  if (allowed.length && !allowed.includes(email)) throw new Error(`účet ${email} nemá k upgradovači přístup (SSO_ALLOWED_EMAILS)`);
  return { email, name, sub: ui.sub || '', next: st.next, idToken: tok.id_token || '' };
}

async function logoutUrl(idToken, postLogout) {
  try { const m = await discovery(); if (!m.end_session_endpoint) return ''; const u = new URL(m.end_session_endpoint); if (idToken) u.searchParams.set('id_token_hint', idToken); if (postLogout) u.searchParams.set('post_logout_redirect_uri', postLogout); u.searchParams.set('client_id', cfg.sso.clientId); return u.toString(); } catch { return ''; }
}

module.exports = { enabled, loginUrl, callback, logoutUrl };
