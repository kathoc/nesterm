import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installer = path.join(root, 'install.sh');

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

async function makeTar(cwd, output, entry) {
  const result = await run('tar', ['-czf', output, entry], { cwd });
  assert.equal(result.code, 0, `tar failed: ${result.stderr}`);
}

function nodePlatformName() {
  const os = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : null;
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : null;
  return os && arch ? `node-v24.21.0-${os}-${arch}` : null;
}

async function createFixture(base) {
  const webRoot = path.join(base, 'web');
  const releaseDir = path.join(webRoot, 'release');
  const badDir = path.join(webRoot, 'bad');
  const nodeDir = path.join(webRoot, 'node');
  const packageRoot = path.join(base, 'release-src', 'package');
  await mkdir(path.join(packageRoot, 'bin'), { recursive: true });
  await mkdir(releaseDir, { recursive: true });
  await mkdir(badDir, { recursive: true });
  await mkdir(nodeDir, { recursive: true });

  const cli = `#!/usr/bin/env node
if (process.argv.includes('--help')) {
  console.log('fixture nesterm help');
} else {
  console.log('fixture nesterm', ...process.argv.slice(2));
}
`;
  await writeFile(path.join(packageRoot, 'bin', 'nesterm.mjs'), cli);
  await writeFile(path.join(packageRoot, 'package.json'), '{"name":"nesterm","version":"0.1.0","type":"module"}\n');

  const archiveName = 'nesterm-0.1.0.tgz';
  const archivePath = path.join(releaseDir, archiveName);
  await makeTar(path.dirname(packageRoot), archivePath, 'package');
  const archive = await readFile(archivePath);
  const sums = `${sha256(archive)}  ${archiveName}\n`;
  await writeFile(path.join(releaseDir, 'SHA256SUMS'), sums);
  await writeFile(path.join(badDir, archiveName), archive);
  await writeFile(path.join(badDir, 'SHA256SUMS'), `${'0'.repeat(64)}  ${archiveName}\n`);

  const nodeName = nodePlatformName();
  if (nodeName) {
    const nodeRoot = path.join(base, 'node-src', nodeName);
    const wrapper = path.join(nodeRoot, 'bin', 'node');
    await mkdir(path.dirname(wrapper), { recursive: true });
    const escapedNode = process.execPath.replaceAll("'", "'\\''");
    await writeFile(wrapper, `#!/bin/sh\nexec '${escapedNode}' "$@"\n`);
    await chmod(wrapper, 0o755);
    await writeFile(path.join(nodeRoot, 'LICENSE'), 'fixture Node.js license\n');
    const nodeArchiveName = `${nodeName}.tar.gz`;
    const nodeArchivePath = path.join(nodeDir, nodeArchiveName);
    await makeTar(path.dirname(nodeRoot), nodeArchivePath, nodeName);
    const nodeArchive = await readFile(nodeArchivePath);
    await writeFile(path.join(nodeDir, 'SHASUMS256.txt'), `${sha256(nodeArchive)}  ${nodeArchiveName}\n`);
  }

  return { webRoot, nodeName };
}

async function startServer(webRoot) {
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://fixture').pathname);
      const relative = pathname.replace(/^\/+/, '');
      const resolved = path.resolve(webRoot, relative);
      if (!resolved.startsWith(`${path.resolve(webRoot)}${path.sep}`)) {
        response.writeHead(403).end();
        return;
      }
      const body = await readFile(resolved);
      response.writeHead(200, { 'content-length': body.length });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function installerEnv(prefix, baseUrl, extra = {}) {
  return {
    ...process.env,
    NESTERM_PREFIX: prefix,
    NESTERM_RELEASE_BASE_URL: `${baseUrl}/release`,
    ...extra,
  };
}

test('POSIX installer works from local verified release fixtures', { timeout: 60_000 }, async (t) => {
  const sandbox = await mkdtemp(path.join(tmpdir(), 'nesterm-installer-test-'));
  t.after(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });
  const fixture = await createFixture(sandbox);
  const server = await startServer(fixture.webRoot);
  t.after(() => server.close());

  await t.test('installs, launches, supports spaces, and preserves unknown files on reinstall', async () => {
    const prefix = path.join(sandbox, 'prefix with spaces');
    const first = await run('sh', [installer], { env: installerEnv(prefix, server.baseUrl) });
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /Installed nesterm 0\.1\.0\./);
    assert.match(first.stdout, new RegExp(prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const launcher = path.join(prefix, 'bin', 'nesterm');
    const launch = await run(launcher, ['--help'], {
      env: { ...process.env, PATH: '/nonexistent' },
    });
    assert.equal(launch.code, 0, launch.stderr);
    assert.equal(launch.stdout, 'fixture nesterm help\n');

    const unrelated = path.join(prefix, 'keep-me.txt');
    const managedUnknown = path.join(prefix, 'lib', 'nesterm', 'keep-me-too.txt');
    await writeFile(unrelated, 'outside managed root\n');
    await writeFile(managedUnknown, 'inside managed root\n');
    const second = await run('sh', [installer], { env: installerEnv(prefix, server.baseUrl) });
    assert.equal(second.code, 0, second.stderr);
    assert.equal(await readFile(unrelated, 'utf8'), 'outside managed root\n');
    assert.equal(await readFile(managedUnknown, 'utf8'), 'inside managed root\n');
  });

  await t.test('rejects a release whose checksum does not match', async () => {
    const prefix = path.join(sandbox, 'bad-hash-prefix');
    const result = await run('sh', [installer], {
      env: installerEnv(prefix, server.baseUrl, {
        NESTERM_RELEASE_BASE_URL: `${server.baseUrl}/bad`,
      }),
    });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /SHA-256 mismatch/);
    await assert.rejects(readFile(path.join(prefix, 'bin', 'nesterm')));
  });

  await t.test('rejects an unmanaged launcher collision without changing it', async () => {
    const prefix = path.join(sandbox, 'collision-prefix');
    const launcher = path.join(prefix, 'bin', 'nesterm');
    await mkdir(path.dirname(launcher), { recursive: true });
    await writeFile(launcher, 'user-owned\n');
    const result = await run('sh', [installer], { env: installerEnv(prefix, server.baseUrl) });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /unmanaged launcher/);
    assert.equal(await readFile(launcher, 'utf8'), 'user-owned\n');
  });

  await t.test('downloads and uses the verified private Node fixture', { skip: !fixture.nodeName }, async () => {
    const prefix = path.join(sandbox, 'private-node-prefix');
    const systemInstall = await run('sh', [installer], {
      env: installerEnv(prefix, server.baseUrl),
    });
    assert.equal(systemInstall.code, 0, systemInstall.stderr);

    const result = await run('sh', [installer], {
      env: installerEnv(prefix, server.baseUrl, {
        NESTERM_FORCE_NODE_DOWNLOAD: '1',
        NESTERM_NODE_BASE_URL: `${server.baseUrl}/node`,
      }),
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Downloading private Node\.js 24\.21\.0 runtime/);
    assert.equal(
      await readFile(path.join(prefix, 'lib', 'nesterm', 'current', 'runtime', 'LICENSE'), 'utf8'),
      'fixture Node.js license\n',
    );
    const launch = await run(path.join(prefix, 'bin', 'nesterm'), ['--help'], {
      env: { ...process.env, PATH: '/nonexistent' },
    });
    assert.equal(launch.code, 0, launch.stderr);
    assert.equal(launch.stdout, 'fixture nesterm help\n');
  });

  await t.test('rejects linked bin or lib ancestors', async () => {
    const prefix = path.join(sandbox, 'linked-ancestor-prefix');
    const outside = path.join(sandbox, 'must-stay-empty');
    await mkdir(prefix, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(prefix, 'lib'));
    const result = await run('sh', [installer], { env: installerEnv(prefix, server.baseUrl) });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /linked path/);
    await assert.rejects(readFile(path.join(outside, 'nesterm', '.nesterm-managed')));
  });
});
