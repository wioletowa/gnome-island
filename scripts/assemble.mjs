// Copies the compiled JS and static files into dist/<uuid>, compiles the
// schema, and optionally installs or zips the result.
import {cpSync, mkdirSync, rmSync, readFileSync, readdirSync, existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join, resolve} from 'node:path';
import {homedir} from 'node:os';

const root = resolve(import.meta.dirname, '..');
const meta = JSON.parse(readFileSync(join(root, 'metadata.json'), 'utf8'));
const out = join(root, 'dist', meta.uuid);

rmSync(out, {recursive: true, force: true});
mkdirSync(out, {recursive: true});
cpSync(join(root, 'build'), out, {recursive: true});
for (const f of ['metadata.json', 'stylesheet.css', 'LICENSE'])
    cpSync(join(root, f), join(out, f));
cpSync(join(root, 'schemas'), join(out, 'schemas'), {recursive: true});
execFileSync('glib-compile-schemas', [join(out, 'schemas')]);
for (const f of ['ambient.d.ts', 'gi-extra.d.ts'])
    rmSync(join(out, f), {force: true});
// Compile translations into locale/<lang>/LC_MESSAGES/<domain>.mo.
const poDir = join(root, 'po');
if (existsSync(poDir)) {
    for (const po of readdirSync(poDir).filter(f => f.endsWith('.po'))) {
        const lang = po.slice(0, -3);
        const dir = join(out, 'locale', lang, 'LC_MESSAGES');
        mkdirSync(dir, {recursive: true});
        execFileSync('msgfmt', ['-o', join(dir, `${meta['gettext-domain']}.mo`), join(poDir, po)]);
    }
}

const args = process.argv.slice(2);
if (args.includes('--install')) {
    const base = process.env.ISLAND_INSTALL_DIR ??
        join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local/share'), 'gnome-shell/extensions');
    const dest = join(base, meta.uuid);
    rmSync(dest, {recursive: true, force: true});
    mkdirSync(base, {recursive: true});
    cpSync(out, dest, {recursive: true});
    console.log(`installed to ${dest}`);
}
if (args.includes('--pack')) {
    const zip = join(root, 'dist', `${meta.uuid}.shell-extension.zip`);
    rmSync(zip, {force: true});
    execFileSync('zip', ['-qr', zip, '.'], {cwd: out});
    console.log(`packed ${zip}`);
}
if (!existsSync(join(out, 'extension.js')))
    throw new Error('extension.js missing from build');
