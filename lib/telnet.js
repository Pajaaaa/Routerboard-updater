'use strict';
// Minimální telnet klient pro RouterOS — jen pro nouzové opravy, když SSH nejde (poškozený host key: „Corrupt host's key,
// regenerating it! Reboot required!“ → KEY_EXCHANGE_FAILED). Přihlásí se jako <user>+ct (bez barev, hloupý terminál), pošle příkazy,
// na dotaz [y/N] odpoví y. Vrací přepis. Nikde jinde se telnet nepoužívá.
const net = require('net');

function stripIac(buf) {
  // odpovědět na IAC DO/WILL zápornou volbou, ostatní IAC sekvence zahodit; vrátí {text, reply}
  const out = [], reply = [];
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b !== 255) { out.push(b); continue; }
    const cmd = buf[i + 1], opt = buf[i + 2];
    if (cmd === 253) { reply.push(255, 252, opt); i += 2; }      // DO → WONT
    else if (cmd === 251) { reply.push(255, 254, opt); i += 2; } // WILL → DONT
    else if (cmd === 254 || cmd === 252) i += 2;                 // DONT/WONT → nic
    else if (cmd === 250) { while (i < buf.length && !(buf[i] === 255 && buf[i + 1] === 240)) i++; i++; } // SB … SE
    else i += 1;
  }
  return { text: Buffer.from(out).toString('latin1'), reply: Buffer.from(reply) };
}

/**
 * telnetRun({host, port, username, password, timeoutMs}, ['/system identity print', ...]) → přepis
 * Každý příkaz se pošle až po výzvě „] > “; dotaz „[y/N]“ potvrdí y; po příkazu, který restartuje router, spojení spadne — bere se jako konec.
 */
function telnetRun({ host, port = 23, username, password, timeoutMs = 20000 }, commands) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port });
    let text = '', transcript = '', stage = 'login', idx = 0, done = false;
    const finish = (err) => { if (done) return; done = true; clearTimeout(timer); try { sock.destroy(); } catch {} err ? reject(err) : resolve(transcript); };
    const timer = setTimeout(() => finish(new Error(`telnet: timeout (${Math.round(timeoutMs / 1000)} s) ve fázi ${stage}`)), timeoutMs);
    const send = (s) => { transcript += s + '\n'; sock.write(s + '\r\n'); };
    sock.on('error', (e) => { if (stage === 'sent-reboot') finish(); else finish(new Error('telnet: ' + e.message)); });
    sock.on('close', () => { if (stage === 'done' || stage === 'sent-reboot') finish(); else finish(new Error('telnet: spojení uzavřeno ve fázi ' + stage)); });
    sock.on('data', (buf) => {
      const { text: t, reply } = stripIac(buf);
      if (reply.length) sock.write(reply);
      text += t; transcript += t;
      const tail = text.slice(-300);
      if (stage === 'login' && /Login:\s*$/i.test(tail)) { sock.write(username + '+ct\r\n'); stage = 'password'; text = ''; return; }
      if (stage === 'password' && /Password:\s*$/i.test(tail)) { sock.write(password + '\r\n'); stage = 'prompt'; text = ''; return; }
      if (/Login:\s*$/i.test(tail) && stage !== 'login') { finish(new Error('telnet: přihlášení odmítnuto (špatné jméno nebo heslo)')); return; }
      if (/\[y\/N\]\s*:?\s*$/i.test(tail)) { transcript += '\n[auto] y\n'; sock.write('y\r\n'); text = ''; return; }
      if (/\]\s?>\s*$/.test(tail)) {
        if (idx >= commands.length) { stage = 'done'; send('/quit'); finish(); return; }
        const cmd = commands[idx++];
        stage = /\/system reboot/.test(cmd) ? 'sent-reboot' : 'prompt';
        text = ''; send(cmd);
        if (stage === 'sent-reboot') setTimeout(() => finish(), 4000);
      }
    });
  });
}

module.exports = { telnetRun };
