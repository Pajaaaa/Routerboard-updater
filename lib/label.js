'use strict';
// Popisek zařízení: primárně /system identity; když je prázdná nebo výchozí („MikroTik“, nebo název modelu — RouterOS 7 přepisuje
// výchozí identitu na model), vezme se název z evidence/ručně zadaný, nakonec IP. Sdílí to server i UI (public/app.js má stejnou logiku).
function genericIdentity(d) {
  const id = String(d.identity || '').trim();
  if (!id) return true;
  if (/^mikrotik$/i.test(id)) return true;
  const models = [d.board_name, d.model].map(x => String(x || '').trim().toLowerCase()).filter(Boolean);
  return models.includes(id.toLowerCase());
}
function devLabel(d) {
  if (!d) return '';
  const name = d.name !== undefined ? d.name : d.dev_name;
  if (!genericIdentity(d)) return d.identity;
  return name || d.identity || d.host || '';
}
module.exports = { devLabel, genericIdentity };
