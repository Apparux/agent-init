import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const workflow = await readFile(path.join(projectRoot, '.github/workflows/release.yml'), 'utf8');
const workflowPlatform = { skip: process.platform === 'win32' && 'Ubuntu workflow requires bash/tar' };

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', timeout: 15_000, ...options });
}

// Execute only the named release steps, not setup, installation, or a real publish.
function releaseStep(name) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  assert.notEqual(start, -1, `Missing workflow step: ${name}`);
  const end = workflow.indexOf('\n      - ', start + 1);
  const body = workflow.slice(start, end === -1 ? undefined : end);
  const command = body.match(/^        run: (.+)$/m)?.[1];
  assert.ok(command, `Missing run command: ${name}`);
  const script = command === '|'
    ? body.slice(body.indexOf('        run: |\n') + '        run: |\n'.length)
      .split('\n').map((line) => line.replace(/^ {10}/, '')).join('\n')
    : command;
  const envBlock = body.match(/^        env:\n((?:          .+\n)+)/m)?.[1] ?? '';
  return {
    id: body.match(/^        id: (\w+)$/m)?.[1],
    script,
    env: Object.fromEntries([...envBlock.matchAll(/^          (\w+): (.+)$/gm)]
      .map(([, key, value]) => [key, value])),
  };
}

async function runStep(fixture, name) {
  const step = releaseStep(name);
  const resolve = (value) => value.replace(/\$\{\{ steps\.(\w+)\.outputs\.(\w+) \}\}/g,
    (_, id, key) => {
      assert.ok(Object.hasOwn(fixture.outputs[id] ?? {}, key), `Missing output: ${id}.${key}`);
      return fixture.outputs[id][key];
    });
  const outputPath = path.join(fixture.root, 'github-output');
  await writeFile(outputPath, '');
  const result = run('bash', ['-e', '-o', 'pipefail', '-c', resolve(step.script)], {
    cwd: fixture.root,
    env: {
      ...fixture.env,
      ...Object.fromEntries(Object.entries(step.env).map(([key, value]) => [key, resolve(value)])),
      GITHUB_OUTPUT: outputPath,
    },
  });
  const outputs = Object.fromEntries((await readFile(outputPath, 'utf8')).trim().split('\n')
    .filter(Boolean).map((line) => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
  if (step.id) fixture.outputs[step.id] = outputs;
  return { ...result, outputs };
}

async function packageFixture(t, changes = {}) {
  // Spaces exercise quoting of script paths and environment options.
  const root = await mkdtemp(path.join(tmpdir(), 'ai-release-ssot space-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const entry of ['package.json', 'LICENSE', 'README.md', 'bin', 'src', 'skills', 'scripts']) {
    await cp(path.join(projectRoot, entry), path.join(root, entry), { recursive: true });
  }
  const pkg = { ...JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')), ...changes };
  await writeFile(path.join(root, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  const home = path.join(root, 'home');
  const packed = path.join(root, 'packed');
  const shim = path.join(root, 'shim');
  await Promise.all([mkdir(home), mkdir(packed), mkdir(shim)]);
  await writeFile(path.join(home, 'user.npmrc'), '');
  await writeFile(path.join(home, 'global.npmrc'), '');
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    npm_config_userconfig: path.join(home, 'user.npmrc'),
    npm_config_globalconfig: path.join(home, 'global.npmrc'),
    npm_config_cache: path.join(home, 'npm-cache'),
    npm_config_offline: 'true',
    npm_config_update_notifier: 'false',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
  };
  // A changed package needs a fresh derived manifest, not a second version source.
  const generated = run(process.execPath, ['scripts/release-manifest.js'], { cwd: root, env });
  assert.equal(generated.status, 0, generated.stderr);
  const pack = run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', packed], {
    cwd: root, env,
  });
  assert.equal(pack.status, 0, pack.stderr);
  const [artifact] = JSON.parse(pack.stdout);
  const tarball = path.join(packed, artifact.filename);
  // A boundary double returns a non-conventional filename for a real tarball.
  artifact.filename = 'release candidate.tgz';
  await writeFile(path.join(root, 'pack-result.json'), JSON.stringify([artifact]));
  await writeFile(path.join(shim, 'npm-double.mjs'), `
import { appendFileSync, copyFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
appendFileSync('npm-requests.jsonl', JSON.stringify(args) + '\\n');
if (args[0] === 'pack') {
  const [artifact] = JSON.parse(readFileSync('pack-result.json', 'utf8'));
  const destination = args[args.indexOf('--pack-destination') + 1];
  copyFileSync(process.env.PACK_SOURCE, path.join(destination, artifact.filename));
  console.log(JSON.stringify([artifact]));
} else if (args[0] !== 'publish') {
  throw new Error('Unexpected npm command: ' + JSON.stringify(args));
}
`);
  await writeFile(path.join(shim, 'npm'),
    `#!/bin/sh\nexec "${process.execPath}" "${path.join(shim, 'npm-double.mjs')}" "$@"\n`,
    { mode: 0o755 });
  return {
    root, pkg, artifact, tarball, outputs: {},
    env: { ...env, PACK_SOURCE: tarball, PATH: `${shim}${path.delimiter}${env.PATH}` },
  };
}

async function registryDouble(fixture) {
  const tarballUrl = 'https://registry.invalid/packed-artifact.tgz';
  const payload = {
    published: {
      name: fixture.pkg.name,
      version: fixture.pkg.version,
      dist: { shasum: fixture.artifact.shasum, integrity: fixture.artifact.integrity, tarball: tarballUrl },
    },
    latest: { name: fixture.pkg.name, version: fixture.pkg.version },
    tarball: (await readFile(fixture.tarball)).toString('base64'),
  };
  await writeFile(path.join(fixture.root, 'registry-payload.json'), JSON.stringify(payload));
  const preload = path.join(fixture.root, 'registry-double.cjs');
  await writeFile(preload, `
const { appendFileSync, readFileSync } = require('node:fs');
const payload = JSON.parse(readFileSync('registry-payload.json', 'utf8'));
globalThis.fetch = async (url) => {
  appendFileSync('registry-requests.jsonl', JSON.stringify(url) + '\\n');
  if (url === payload.published.dist.tarball) {
    return { ok: true, arrayBuffer: async () => Buffer.from(payload.tarball, 'base64') };
  }
  return { ok: true, json: async () => url.endsWith('/latest') ? payload.latest : payload.published };
};
`);
  fixture.env.NODE_OPTIONS = `--require=${JSON.stringify(preload)}`;
  return { payload, tarballUrl };
}

async function recordedRequests(fixture, name) {
  return (await readFile(path.join(fixture.root, `${name}-requests.jsonl`), 'utf8'))
    .trim().split('\n').map((line) => JSON.parse(line));
}

test('release extraction uses the filename returned by npm pack', workflowPlatform, async (t) => {
  const fixture = await packageFixture(t);
  const derived = await runStep(fixture, 'Derive release version from package.json');
  assert.equal(derived.status, 0, derived.stderr);
  const built = await runStep(fixture, 'Build release artifact');
  assert.equal(built.status, 0, built.stderr);
  assert.equal(built.outputs.filename, 'release candidate.tgz');
  const unpacked = JSON.parse(await readFile(
    path.join(fixture.root, '.release-artifact/unpacked/package/package.json'), 'utf8',
  ));
  assert.equal(unpacked.version, fixture.pkg.version);
});

for (const version of [undefined, '9.8.7-ssot.1']) {
  test(`package version flows through CLI, pack, publish input and registry requests (${version ?? 'current'})`,
    workflowPlatform, async (t) => {
      const fixture = await packageFixture(t, version ? { version } : {});
      const cli = run(process.execPath, ['bin/agent-init.js', '--version'], {
        cwd: fixture.root, env: fixture.env,
      });
      assert.equal(cli.status, 0, cli.stderr);
      assert.equal(cli.stdout, `agent-init ${fixture.pkg.version}\n`);
      for (const name of ['Derive release version from package.json', 'Verify release metadata',
        'Build release artifact', 'Verify release artifact', 'Publish npm package']) {
        const result = await runStep(fixture, name);
        assert.equal(result.status, 0, `${name}: ${result.stderr}`);
      }
      assert.equal(fixture.outputs.version.name, fixture.pkg.name);
      assert.equal(fixture.outputs.version.version, fixture.pkg.version);
      assert.equal(fixture.outputs.pack.filename, 'release candidate.tgz');
      assert.equal(fixture.artifact.version, fixture.pkg.version);
      const packedCli = run(process.execPath,
        ['.release-artifact/unpacked/package/bin/agent-init.js', '--version'], {
          cwd: fixture.root, env: fixture.env,
        });
      assert.equal(packedCli.status, 0, packedCli.stderr);
      assert.equal(packedCli.stdout, cli.stdout);
      assert.deepEqual(await recordedRequests(fixture, 'npm'), [
        ['pack', '--ignore-scripts', '--json', '--pack-destination', '.release-artifact'],
        ['publish', '.release-artifact/release candidate.tgz', '--access', 'public', '--tag', 'latest'],
      ]);
      const { tarballUrl } = await registryDouble(fixture);
      const registry = await runStep(fixture, 'Verify published registry artifact');
      assert.equal(registry.status, 0, registry.stderr);
      assert.deepEqual(await recordedRequests(fixture, 'registry'), [
        `https://registry.npmjs.org/%40apparux%2Fagent-init/${fixture.pkg.version}`,
        'https://registry.npmjs.org/%40apparux%2Fagent-init/latest',
        tarballUrl,
      ]);
      assert.match(registry.stdout, new RegExp(`Verified registry version: ${fixture.pkg.version.replaceAll('.', '\\.')}\\n`));
    });
}

async function verifiedArtifact(t, changes = {}) {
  const fixture = await packageFixture(t, changes);
  for (const name of ['Derive release version from package.json', 'Build release artifact', 'Verify release artifact']) {
    const result = await runStep(fixture, name);
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
  }
  return fixture;
}

test('dynamic package identity propagates without weakening the approved release identity',
  workflowPlatform, async (t) => {
    const fixture = await verifiedArtifact(t, { name: '@ssot-fixture/dynamic-package', version: '9.8.7-ssot.1' });
    const metadata = await runStep(fixture, 'Verify release metadata');
    assert.equal(metadata.status, 1);
    assert.match(metadata.stderr, /Release metadata mismatch/);
    assert.equal(fixture.outputs.version.name, '@ssot-fixture/dynamic-package');
    const { tarballUrl } = await registryDouble(fixture);
    const registry = await runStep(fixture, 'Verify published registry artifact');
    assert.equal(registry.status, 0, registry.stderr);
    assert.deepEqual(await recordedRequests(fixture, 'registry'), [
      'https://registry.npmjs.org/%40ssot-fixture%2Fdynamic-package/9.8.7-ssot.1',
      'https://registry.npmjs.org/%40ssot-fixture%2Fdynamic-package/latest',
      tarballUrl,
    ]);
  });

test('release verification rejects mismatched artifact metadata and file lists', workflowPlatform, async (t) => {
  const fixture = await verifiedArtifact(t);
  for (const [name, mutate, error] of [
    ['name', (artifact) => { artifact.name = '@wrong/package'; }, /Release artifact name mismatch/],
    ['version', (artifact) => { artifact.version = '0.0.0-mismatch'; }, /Release artifact version mismatch/],
    ['filename', (artifact) => { artifact.filename = 'wrong.tgz'; }, /Release artifact filename mismatch/],
    ['entry count', (artifact) => { artifact.entryCount += 1; }, /Release artifact entryCount mismatch/],
    ['file list', (artifact) => { artifact.files.pop(); }, /Release artifact file manifest mismatch/],
    ['file mode', (artifact) => { artifact.files[0].mode ^= 0o111; }, /Release artifact file manifest mismatch/],
    ['shasum format', (artifact) => { artifact.shasum = 'invalid'; }, /Invalid artifact shasum/],
    ['integrity format', (artifact) => { artifact.integrity = 'invalid'; }, /Invalid artifact integrity/],
  ]) {
    await t.test(name, async () => {
      const artifact = structuredClone(fixture.artifact);
      mutate(artifact);
      await writeFile(path.join(fixture.root, '.release-artifact/pack.json'), JSON.stringify([artifact]));
      const result = await runStep(fixture, 'Verify release artifact');
      assert.equal(result.status, 1);
      assert.match(result.stderr, error);
      assert.deepEqual(result.outputs, {});
    });
  }
});

test('release verification rejects mismatched packed version and tree digest', workflowPlatform, async (t) => {
  const fixture = await verifiedArtifact(t);
  const unpackedRoot = path.join(fixture.root, '.release-artifact/unpacked/package');
  await t.test('packed package version', async (t) => {
    const metadataPath = path.join(unpackedRoot, 'package.json');
    const original = await readFile(metadataPath, 'utf8');
    t.after(() => writeFile(metadataPath, original));
    await writeFile(metadataPath, JSON.stringify({ ...JSON.parse(original), version: '0.0.0-mismatch' }));
    const result = await runStep(fixture, 'Verify release artifact');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Packed metadata mismatch/);
  });
  await t.test('tree digest', async () => {
    const readme = path.join(unpackedRoot, 'README.md');
    await writeFile(readme, `${await readFile(readme, 'utf8')}\ntampered\n`);
    const result = await runStep(fixture, 'Verify release artifact');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Release artifact tree digest mismatch/);
  });
});

test('registry verification rejects mismatched versions and digests without network access',
  workflowPlatform, async (t) => {
    const fixture = await verifiedArtifact(t);
    const { payload } = await registryDouble(fixture);
    for (const [name, mutate, error] of [
      ['package version', (data) => { data.published.version = '0.0.0-mismatch'; }, /Registry metadata mismatch/],
      ['latest version', (data) => { data.latest.version = '0.0.0-mismatch'; }, /Registry metadata mismatch/],
      ['shasum', (data) => { data.published.dist.shasum = '0'.repeat(40); }, /Registry digest mismatch/],
      ['integrity', (data) => { data.published.dist.integrity = 'sha512-wrong'; }, /Registry digest mismatch/],
      ['downloaded digest', (data) => { data.tarball = Buffer.from('tampered').toString('base64'); }, /Downloaded registry artifact mismatch/],
    ]) {
      await t.test(name, async () => {
        const changed = structuredClone(payload);
        mutate(changed);
        await writeFile(path.join(fixture.root, 'registry-payload.json'), JSON.stringify(changed));
        const result = await runStep(fixture, 'Verify published registry artifact');
        assert.equal(result.status, 1);
        assert.match(result.stderr, error);
      });
    }
  });

test('packed filenames cannot escape the artifact directory or inject workflow outputs',
  workflowPlatform, async (t) => {
    const fixture = await packageFixture(t);
    const derived = await runStep(fixture, 'Derive release version from package.json');
    assert.equal(derived.status, 0, derived.stderr);
    for (const filename of ['../escaped.tgz', 'injected\noutput.tgz', 'not-a-tarball.zip']) {
      await t.test(JSON.stringify(filename), async () => {
        await writeFile(path.join(fixture.root, 'pack-result.json'), JSON.stringify([{ ...fixture.artifact, filename }]));
        const built = await runStep(fixture, 'Build release artifact');
        assert.equal(built.status, 1);
        assert.match(built.stderr, /Invalid packed filename/);
        assert.deepEqual(built.outputs, {});
      });
    }
  });
