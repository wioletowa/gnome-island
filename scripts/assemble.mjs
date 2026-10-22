// Copies the compiled JS and static files into dist/<uuid>, compiles the
// schema, and optionally installs or zips the result.
import {cpSync, mkdirSync, rmSync, readFileSync, existsSync} from 'node:fs';
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
rmSync(join(out, 'ambient.d.ts'), {force: true});

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
