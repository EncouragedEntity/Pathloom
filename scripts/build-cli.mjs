// Builds the `pathloom` CLI in release mode and copies it where Tauri expects a sidecar:
// apps/desktop/src-tauri/binaries/pathloom-<target-triple>[.exe]
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const triple = execFileSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8' }).trim();
execFileSync('cargo', ['build', '-p', 'pathloom-cli', '--release'], { cwd: root, stdio: 'inherit' });
const ext = process.platform === 'win32' ? '.exe' : '';
const outDir = join(root, 'apps', 'desktop', 'src-tauri', 'binaries');
mkdirSync(outDir, { recursive: true });
copyFileSync(join(root, 'target', 'release', `pathloom${ext}`), join(outDir, `pathloom-${triple}${ext}`));
console.log(`CLI sidecar ready: binaries/pathloom-${triple}${ext}`);
