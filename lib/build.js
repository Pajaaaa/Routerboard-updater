'use strict';
/*
 * MikroTik upgrader — hromadný bezpečný upgrade RouterOS v síti hkfree.org
 * Autor: Pavel Vlček (hkfree.org), 2026. Původní dílo.
 *
 * Číslo verze = pořadí commitu v gitu, ke kterému se přidává zkrácený hash. Na serveru se čte ze souboru BUILD,
 * který při nasazení zapíše deploy.sh (nasazený strom .git nemá); při vývoji se dopočítá přímo z gitu.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const AUTHOR = 'Pavel Vlček';
const ORG = 'hkfree.org';
const PROJECT = 'MikroTik upgrader';
const YEAR = 2026;
const REPO = 'github.com/Pajaaaa/Routerboard-updater';
const root = path.join(__dirname, '..');

function fromFile() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(root, 'BUILD'), 'utf8'));
    if (j && j.commits) return { commits: Number(j.commits), commit: String(j.commit || ''), builtAt: String(j.builtAt || ''), origin: String(j.stamp || '') };
  } catch { /* soubor není (vývoj) */ }
  return null;
}
function fromGit() {
  try {
    const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return { commits: Number(git('rev-list', '--count', 'HEAD')), commit: git('rev-parse', '--short', 'HEAD'), builtAt: git('log', '-1', '--format=%cI') };
  } catch { /* není git (nasazený strom) */ }
  return null;
}

const b = fromFile() || fromGit() || { commits: 0, commit: '', builtAt: '' };
const ORIGIN = b.origin || '';
const version = `1.${b.commits}`;
const info = {
  project: PROJECT, author: AUTHOR, org: ORG, year: YEAR, origin: ORIGIN, repo: REPO,
  version, commit: b.commit, builtAt: b.builtAt,
  full: `${PROJECT} v${version}${b.commit ? ` (${b.commit})` : ''} — © ${YEAR} ${AUTHOR}, ${ORG}`,
};
// HTTP hlavička smí být jen ASCII, proto bez diakritiky
info.header = `${PROJECT} v${version}${b.commit ? ` (${b.commit})` : ''} (${AUTHOR.normalize('NFD').replace(/[\u0300-\u036f]/g, '')}, ${ORG})${ORIGIN ? ` ${ORIGIN}` : ''}`;
module.exports = info;
