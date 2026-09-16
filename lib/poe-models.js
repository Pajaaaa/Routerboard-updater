'use strict';
/**
 * Tabulka PoE-out portů podle modelu RouterBOARDu (ověřeno 16.9.2026 z mikrotik.com / help.mikrotik.com, stránka PoE-Out).
 * Účel: PoE prvek nad zařízením neblokuje upgrade, když zařízení visí na portu, který napájet neumí
 * (RB4011 má PoE-out jen na ether10, hEX S jen na ether5, RB5009UPr jen na ether1–8, …).
 *
 * Model přichází ve dvou podobách: board-name z MNDP souseda („RB960PGS", „C53UiG+5HPaxD2HPaxD")
 * a produktové jméno ze skenu („hEX PoE", „hAP ax^3") — regexy pokrývají obě.
 * ports: čísla etherN s PoE-out; [] = model PoE-out nemá (ověřeno); nenalezen = neznámý model (null).
 */
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

const MODELS = [
  // routery s jedním PoE-out portem
  { re: /^RB4011|^RB3011|^RB2011/i, ports: [10] },
  { re: /^RB760iGS|^hEX S\b|^RB951Ui|^RB952Ui|^RB962UiGS|^RBD53iG|^RB450Gx4|^E62iUGS|^hAP ac\^?3\b|^hAP ac(?! ?\^?2)\b|^hAP\b(?! (ax|lite|mini|ac\^?2))|^hAP ax S/i, ports: [5] },
  { re: /^C52iG|^C53UiG|^hAP ax\^?[23]\b/i, ports: [1] },
  { re: /^L009/i, ports: [8] },
  { re: /^RBwsAP|^wsAP ac lite/i, ports: [3] },
  { re: /^RBmAP2nD|^RBcAPGi|^cAPGi|^mAP\b(?! lite)|^cAP (ac|ax|XL ac)/i, ports: [2] },
  // 4portové PoE routery/switche (ether2–ether5)
  { re: /^RB960PGS|^RB750UP|^RB750P(r2|-PBr2)?\b|^RBOmniTik(UPA|PG)|^OmniTIK 5 PoE|^OmniTIK UPA|^CSS106-1G-4P|^RB260GSP|^hEX PoE|^PowerBox|^PowerBOX/i, ports: range(2, 5) },
  // RB5009UPr+S+: ether1–ether8 (UG varianta PoE-out nemá)
  { re: /^RB5009UPr/i, ports: range(1, 8) },
  // netPower
  { re: /^CRS318-16P|^netPower 16P/i, ports: range(1, 16) },
  { re: /^CSS610-1Gi-7R|^netPower Lite 7R/i, ports: [8] },
  { re: /^CRS318-1Fi-15Fr|^netPower 15FR/i, ports: [15] },
  // PoE switche
  { re: /^CRS320-8P-8B/i, ports: range(1, 16) },
  { re: /^CRS328-24P/i, ports: range(1, 24) },
  { re: /^CRS354-48P/i, ports: range(1, 48) },
  { re: /^CRS112-8P|^CSS610-8P/i, ports: range(1, 8) },
  // ověřeně bez PoE-out (jinak by je chytil obecný odhad podle jména nebo identity)
  { re: /^RB5009UG|^RB1100|^RB912UAG|^RB922UAGS|^RB921|^RBOmniTikG|^RBOmniTikU-|^OmniTIK 5( ac)?$|^OmniTIK U-|^RBD52G|^hAP ac\^?2|^RBmAPL|^mAP lite|^RBcAP2nD|^RB941|^hAP lite|^RB931|^hAP mini|^RB750(r2|Gr3|GL)?$|^hEX( lite)?$|^RB951G|^RB751|^L11UG|^L22UGS|^L41G|^wAPG|^wAP ax|^CRS326|^CRS317|^CRS125|^CRS310|^CRS309|^CRS312|^CRS305|^CRS212|^CSS610-8G|^CSS318|^CSS326|^CCR/i, ports: [] },
];

/** PoE-out porty modelu: pole čísel etherN ([] = nemá), null = model neznáme */
function poeOutPorts(board) {
  const b = String(board || '').replace(/^RB (?=[A-Za-z])/, '').trim();
  if (!b) return null;
  const m = MODELS.find(x => x.re.test(b));
  return m ? m.ports.slice() : null;
}

/** je to PoE prvek? tabulka má přednost, u neznámého modelu odhad podle jména */
function isPoeBoard(board) {
  const p = poeOutPorts(board);
  return p ? p.length > 0 : /PoE|netPower|PowerBox|-\d+P\b/i.test(String(board || ''));
}

/** fyzický port z názvu rozhraní souseda („bridge1/ether10", „bridge-osicky/ether2-osicky", „sfp-sfpplus1-switch", „vlan31") */
function physicalPort(name) {
  const seg = String(name || '').split('/').pop().trim();
  if (!seg) return null;
  const m = /^ether(\d+)/i.exec(seg);
  if (m) return { kind: 'ether', n: +m[1], name: seg };
  if (/^(sfp|qsfp|wlan|wifi|ath|wl\d|combo)/i.test(seg)) return { kind: 'nopoe', name: seg }; // optika a rádio PoE-out nemají
  return null; // bridge, vlan, bonding, br0 … → port nejde určit
}

/** lidsky: [2,3,4,5] → „ether2–ether5", [10] → „ether10", [1,8] → „ether1, ether8" */
function describePorts(ports) {
  const p = [...new Set(ports)].sort((a, b) => a - b);
  if (!p.length) return 'žádný';
  const out = [];
  for (let i = 0; i < p.length;) {
    let j = i; while (j + 1 < p.length && p[j + 1] === p[j] + 1) j++;
    out.push(j - i >= 1 ? `ether${p[i]}–ether${p[j]}` : `ether${p[i]}`);
    i = j + 1;
  }
  return out.join(', ');
}

/**
 * Napájí PoE prvek (model `board`, případně naskenované PoE porty `scannedPorts` = [{name, mode}]) zařízení, které visí na jeho portu `portName`?
 * → { powers: true|false|null, reason } — null = nejde rozhodnout (neznámý model nebo neurčitelný port)
 */
function powersOnPort(board, portName, scannedPorts) {
  const phys = physicalPort(portName);
  if (!phys) return { powers: null, reason: portName ? `port ${portName} nejde převést na fyzické rozhraní` : 'port souseda není znám' };
  if (Array.isArray(scannedPorts)) {
    // sken zná porty s poe-out (auto-on/forced-on) přímo podle jména
    const hit = scannedPorts.some(pp => pp.name === phys.name || (phys.kind === 'ether' && new RegExp(`^ether${phys.n}(?!\\d)`, 'i').test(pp.name || '')));
    return hit ? { powers: true, reason: `port ${phys.name} má podle skenu zapnutý PoE-out` } : { powers: false, reason: `PoE-out má podle skenu zapnutý jen na ${scannedPorts.map(pp => pp.name).join(', ') || 'žádném portu'}, ne na ${phys.name}` };
  }
  if (phys.kind === 'nopoe') return { powers: false, reason: `${phys.name} je optika/rádio bez PoE-out` };
  const ports = poeOutPorts(board);
  if (!ports) return { powers: null, reason: `model ${board || '?'} v tabulce PoE-out portů není` };
  if (ports.includes(phys.n)) return { powers: true, reason: `${phys.name} je PoE-out port (${board}: ${describePorts(ports)})` };
  return { powers: false, reason: `${board} má PoE-out jen na ${describePorts(ports)}, tohle zařízení visí na ${phys.name}` };
}

module.exports = { MODELS, poeOutPorts, isPoeBoard, physicalPort, describePorts, powersOnPort };
