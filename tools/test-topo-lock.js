#!/usr/bin/env node
'use strict';
// Zámek předek↔potomek napříč souběžnými dávkami/joby (5.11.2026): dávky běží současně, ale restart se nesmí křížit mezi
// zařízením a jeho (byť vzdáleným) předkem/potomkem v topologii — jinak by se navzájem odřízly. Dřív conflictFor hlídal jen
// přímé (jednohopové) sousedy; teď i celý svislý řetěz parent_id. Test: sameVerticalChain + conflictFor na víc úrovní.
const fs = require('fs'), os = require('os'), path = require('path');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mtu-topo-'));
process.env.DATA_DIR = DATA; process.env.MTU_SECRET = 'test-secret-1234567890'; process.env.MTU_PASSWORD = 'heslotest1234'; process.env.MTU_ADMIN_USER = 'admin';
const db = require('../lib/db');
const { Runner, RunnerPool, sameVerticalChain, physicallyAdjacent } = require('../lib/runner');
let fail = 0; const chk = (n, ok, e='') => { console.log(`  ${ok?'✓':'✗'} ${n}${e?' — '+e:''}`); if (!ok) fail++; };

// topologie: A(kořen) → B → C → D (hluboký řetěz) ; B → E (sourozenecká větev pod B)
const A = db.insertDevice({ host: '10.1.0.1', port: 22 });
const B = db.insertDevice({ host: '10.1.0.2', port: 22 }); db.updateDevice(B, { parent_id: A });
const C = db.insertDevice({ host: '10.1.0.3', port: 22 }); db.updateDevice(C, { parent_id: B });
const D = db.insertDevice({ host: '10.1.0.4', port: 22 }); db.updateDevice(D, { parent_id: C });
const E = db.insertDevice({ host: '10.1.0.5', port: 22 }); db.updateDevice(E, { parent_id: B });
const raw = (id) => db.getDeviceRaw(id);

// sameVerticalChain: svislý řetěz přes víc úrovní true, sourozenci/nesouvisející false
chk('A↔D (praděd↔pravnuk) = svislý řetěz', sameVerticalChain(raw(A), raw(D)) === true);
chk('D↔A opačně = svislý řetěz', sameVerticalChain(raw(D), raw(A)) === true);
chk('A↔C (přes B) = svislý řetěz', sameVerticalChain(raw(A), raw(C)) === true);
chk('C↔E (sourozenci pod B) = NENÍ svislý řetěz', sameVerticalChain(raw(C), raw(E)) === false);
chk('D↔E = NENÍ svislý řetěz', sameVerticalChain(raw(D), raw(E)) === false);
chk('A↔A (sám se sebou) = false', sameVerticalChain(raw(A), raw(A)) === false);
// kontrola že mezeru zavírá právě vícehopová vazba (A a D nejsou přímo sousedé)
chk('A↔D NENÍ přímý soused (physicallyAdjacent)', physicallyAdjacent(raw(A), raw(D)) === false);

// conflictFor: jiný runner právě dělá kořen A → upgrade pravnuka D musí počkat (napříč dávkami)
const pool = new RunnerPool();
const busy = new Runner(); busy.ownerId = 1; busy.currentJobId = 101; busy.currentDeviceId = A; pool.runners.set(101, busy);
const self = new Runner(); self.ownerId = 2; self.currentJobId = 102; self.pool = pool;
chk('D čeká, když se restartuje jeho vzdálený předek A', !!pool.conflictFor(raw(D), self));
chk('E nečeká na C (jiná větev)', (() => { const b2 = new Runner(); b2.ownerId = 1; b2.currentJobId = 103; b2.currentDeviceId = C; const p2 = new RunnerPool(); p2.runners.set(103, b2); return p2.conflictFor(raw(E), self) === null; })());
// opačný směr: běží pravnuk D → restart kořene A musí počkat
chk('A čeká, když se upgraduje jeho vzdálený potomek D', (() => { const b3 = new Runner(); b3.ownerId = 1; b3.currentJobId = 104; b3.currentDeviceId = D; const p3 = new RunnerPool(); p3.runners.set(104, b3); return !!p3.conflictFor(raw(A), self); })());

console.log(fail ? `\n${fail} chyb` : '\nvše v pořádku');
process.exit(fail ? 1 : 0);
