import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Deliberate allowlist: new source files require a CLI-only scope review.
export const publicFiles = new Set([
  '.github/workflows/ci.yml', '.githooks/pre-commit', '.githooks/pre-push',
  '.gitignore', 'AGENTS.md', 'LICENSE', 'LICENSES-glyphs.txt', 'README.md',
  'THIRD_PARTY_NOTICES.md', 'bin/nesterm.mjs', 'docs/release-spec.md',
  'install.sh', 'package.json', 'package-lock.json',
  'scripts/check-public-scope.mjs', 'scripts/capture.mjs',
  'scripts/demo-events.mjs', 'scripts/generate-glyphs.mjs',
  'scripts/record-terminal.mjs', 'scripts/release.mjs',
  'scripts/runtime-paths.mjs', 'scripts/terminal-video.mjs',
  'src/emulator.mjs', 'src/glyphs.mjs', 'src/renderer.mjs',
  'src/shape.mjs', 'src/terminal.mjs',
  'test/core.test.mjs', 'test/installer.test.mjs',
  'test/terminal.test.mjs', 'test/public-scope.test.mjs',
]);

export function assertPublicPaths(paths) {
  const rejected = paths.filter(path => !publicFiles.has(path));
  if (rejected.length) throw new Error(`CLI-only publication: unapproved paths:\n${rejected.join('\n')}`);
}

export function checkPublicScope(ref) {
  if (ref && !/^[a-f0-9]{40,64}$/.test(ref)) throw new Error('Expected a full commit object ID');
  const args = ref ? ['ls-tree', '-r', '--name-only', '-z', ref] : ['ls-files', '--cached', '-z'];
  const paths = execFileSync('git', args, { encoding: 'utf8', timeout: 10000 }).split('\0').filter(Boolean);
  assertPublicPaths(paths);
  console.log(`CLI-only publication: ${paths.length} approved paths`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--ref')) throw new Error('Usage: check-public-scope.mjs [--ref COMMIT]');
  checkPublicScope(args[1]);
}
