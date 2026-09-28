import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPublicPaths, publicFiles } from '../scripts/check-public-scope.mjs';

test('approved CLI source and tooling pass publication guard', () => {
  assert.doesNotThrow(() => assertPublicPaths([...publicFiles]));
});

test('browser interfaces, vendors, browser tooling and unknown paths are rejected', () => {
  for (const path of [
    'web/app.mjs', 'web/index.html', 'web/styles.css', 'web/controller.mjs',
    'vendor/brickboy/touch.ts', 'scripts/build.mjs', 'scripts/serve.mjs',
    'scripts/browser-check.mjs', 'scripts/controller-check.mjs',
    'test/input-router.test.mjs', 'src/browser-ui.mjs', 'public/index.html',
    'game.nes', '.env', 'artifacts/session.webm',
  ]) assert.throws(() => assertPublicPaths(['src/emulator.mjs', path]), /CLI-only publication/);
});
