'use strict';
const crypto = require('crypto');
const cfg = require('./config');

const key = crypto.createHash('sha256').update('mtu-enc:' + cfg.secret).digest();
const sigKey = crypto.createHash('sha256').update('mtu-sig:' + cfg.secret).digest();

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return 'v1:' + iv.toString('base64') + ':' + tag.toString('base64') + ':' + ct.toString('base64');
}
function decrypt(blob) {
  if (!blob) return '';
  const [v, iv, tag, ct] = String(blob).split(':');
  if (v !== 'v1') throw new Error('neznámý formát šifrovaného hesla');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}
function sign(data) {
  return crypto.createHmac('sha256', sigKey).update(data).digest('base64url');
}
function makeSession(user) {
  const exp = Date.now() + cfg.sessionDays * 86400e3;
  const payload = Buffer.from(JSON.stringify({ exp, n: crypto.randomBytes(8).toString('hex'), u: { id: user.id, name: user.name, role: user.role } })).toString('base64url');
  return payload + '.' + sign(payload);
}
/** hash hesla uživatele webu: scrypt, náhodná sůl */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pw), salt, 32, { N: 16384, r: 8, p: 1 });
  return 'v1:' + salt.toString('base64') + ':' + h.toString('base64');
}
function verifyPassword(pw, stored) {
  if (!stored) return false;
  const [v, salt, h] = String(stored).split(':');
  if (v !== 'v1' || !salt || !h) return false;
  const got = crypto.scryptSync(String(pw), Buffer.from(salt, 'base64'), 32, { N: 16384, r: 8, p: 1 });
  const want = Buffer.from(h, 'base64');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
/** vrací objekt session ({user}) nebo null */
function checkSession(token) {
  if (!token || typeof token !== 'string') return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const good = sign(payload);
  if (good.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(good), Buffer.from(sig))) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return p.exp > Date.now() && p.u && p.u.id ? { user: p.u } : null;
  } catch { return null; }
}
function safeEqual(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}
function token(n = 24) { return crypto.randomBytes(n).toString('base64url'); }

module.exports = { encrypt, decrypt, makeSession, checkSession, safeEqual, token, hashPassword, verifyPassword };
