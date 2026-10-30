// Copies the Python and Clang WebAssembly runtimes out of node_modules so they
// are served from our own origin. That keeps runs private, lets the service
// worker cache them for offline use, and needs no CDN for the core languages.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'vendor');
const version = (pkg) => JSON.parse(readFileSync(join(root, 'node_modules', pkg, 'package.json'), 'utf8')).version;

const groups = {
  pyodide: {
    from: 'node_modules/pyodide',
    files: ['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'],
  },
  clang: {
    from: 'node_modules/@yowasp/clang/gen',
    files: ['bundle.js', 'llvm-resources.tar', 'llvm.core.wasm', 'llvm.core2.wasm', 'llvm.core3.wasm', 'llvm.core4.wasm'],
  },
};

rmSync(out, { recursive: true, force: true });
for (const [name, { from, files }] of Object.entries(groups)) {
  mkdirSync(join(out, name), { recursive: true });
  for (const file of files) cpSync(join(root, from, file), join(out, name, file));
}
writeFileSync(
  join(out, 'manifest.json'),
  JSON.stringify({ pyodide: version('pyodide'), clang: version('@yowasp/clang') }, null, 2),
);
writeFileSync(join(out, 'version.js'), `self.RUNTIME_VERSION = ${JSON.stringify(`${version('pyodide')}-${version('@yowasp/clang')}`)};\n`);
console.log(`vendored pyodide ${version('pyodide')} and clang ${version('@yowasp/clang')}`);
