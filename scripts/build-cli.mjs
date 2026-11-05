// Builds the `pathloom` CLI in release mode and copies it where Tauri expects a sidecar:
// apps/desktop/src-tauri/binaries/pathloom-<target-triple>[.exe]
//
// Target: TAURI_ENV_TARGET_TRIPLE (set by `tauri build --target ...`), else the host. For the universal macOS
// build it builds both Apple targets and joins them with `lipo`, because Tauri checks each architecture's
// sidecar while compiling and bundles the universal one.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const host = execFileSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8' }).trim();
const wanted = process.env.TAURI_ENV_TARGET_TRIPLE || host;
const outDir = join(root, 'apps', 'desktop', 'src-tauri', 'binaries');
mkdirSync(outDir, { recursive: true });

/** Build for `triple` and copy the binary next to the app; returns the copied path. */
function build(triple) {
  const ext = triple.includes('windows') ? '.exe' : '';
  const args = ['build', '-p', 'pathloom-cli', '--release'];
  if (triple !== host) args.push('--target', triple);
  execFileSync('cargo', args, { cwd: root, stdio: 'inherit' });
  const built = triple === host ? join(root, 'target', 'release', `pathloom${ext}`) : join(root, 'target', triple, 'release', `pathloom${ext}`);
  const out = join(outDir, `pathloom-${triple}${ext}`);
  copyFileSync(built, out);
  console.log(`CLI sidecar ready: binaries/pathloom-${triple}${ext}`);
  return out;
}

if (wanted === 'universal-apple-darwin') {
  const parts = ['aarch64-apple-darwin', 'x86_64-apple-darwin'].map(build);
  execFileSync('lipo', ['-create', '-output', join(outDir, 'pathloom-universal-apple-darwin'), ...parts], { stdio: 'inherit' });
  console.log('CLI sidecar ready: binaries/pathloom-universal-apple-darwin');
} else {
  build(wanted);
}
