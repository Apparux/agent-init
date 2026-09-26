import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { executeLifecycle } from '../../src/installation/lifecycle.js';
import { HARNESS_REGISTRY } from '../../src/installation/harnesses.js';
import { createInstallationFixture } from './helpers.js';

test('failed fresh install removes its empty discovery parent chain', async (t) => {
  const { homeDir, runtime } = await createInstallationFixture(t);
  const entry = HARNESS_REGISTRY[0];
  const root = path.join(homeDir, entry.skillsDir.split('/')[0]);
  await rm(root, { recursive: true });

  const result = await executeLifecycle({ operation: 'install' }, {
    ...runtime,
    async afterMutation(name) {
      if (name === `install:${entry.key}-published`) throw new Error('injected install failure');
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.error.message, /injected install failure/);
  await assert.rejects(lstat(root), { code: 'ENOENT' });
});

for (const interference of ['foreign-file', 'directory', 'symlink']) {
  test(`rollback preserves and reports a parent changed by ${interference}`, async (t) => {
    const { disposableRoot, homeDir, runtime } = await createInstallationFixture(t);
    const root = path.join(homeDir, HARNESS_REGISTRY[0].skillsDir.split('/')[0]);
    await rm(root, { recursive: true });
    const outside = path.join(disposableRoot, 'outside');
    await mkdir(outside);
    let changed = false;
    const result = await executeLifecycle({ operation: 'install' }, {
      ...runtime,
      async afterJournalSnapshot(journal) {
        if (changed || journal.completed.at(-1)?.action !== 'create-parent') return;
        changed = true;
        if (interference === 'foreign-file') {
          await writeFile(path.join(root, 'foreign.txt'), 'keep me');
        } else {
          await rename(root, path.join(disposableRoot, 'original-parent'));
          if (interference === 'directory') await mkdir(root);
          else await symlink(outside, root, 'dir');
        }
        throw new Error('injected parent interference');
      },
    });

    assert.equal(changed, true);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'ROLLBACK_FAILED');
    assert.ok(result.error.preserved.includes(root));
    assert.ok(result.error.unresolved.includes(root));
    assert.match(result.error.remediation, /Inspect.*journal/);
    assert.equal((await lstat(root)).isSymbolicLink(), interference === 'symlink');
    if (interference === 'foreign-file') assert.equal(await readFile(path.join(root, 'foreign.txt'), 'utf8'), 'keep me');
    assert.deepEqual(await readdir(outside), []);
    assert.ok((await readdir(homeDir)).some((name) => name.includes('.journal-')));
  });
}

test('rollback reports unresolved payload assets together with preserved discovery parents', async (t) => {
  const { homeDir, runtime } = await createInstallationFixture(t);
  const root = path.join(homeDir, HARNESS_REGISTRY[0].skillsDir.split('/')[0]);
  const canonical = path.join(homeDir, '.agent-init', 'current');
  await rm(root, { recursive: true });
  const result = await executeLifecycle({ operation: 'install' }, {
    ...runtime,
    async afterMutation(name) {
      if (name !== `install:${HARNESS_REGISTRY[0].key}-published`) return;
      await writeFile(path.join(root, 'foreign.txt'), 'foreign parent content');
      await writeFile(path.join(canonical, 'skills', 'agent-init', 'foreign.txt'), 'foreign payload content');
      throw new Error('injected');
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ROLLBACK_FAILED');
  assert.ok(result.error.unresolved.includes(canonical));
  assert.ok(result.error.unresolved.includes(root));
  assert.ok(result.error.preserved.includes(root));
  assert.equal(await readFile(path.join(root, 'foreign.txt'), 'utf8'), 'foreign parent content');
  assert.equal(await readFile(path.join(canonical, 'skills', 'agent-init', 'foreign.txt'), 'utf8'), 'foreign payload content');
});

test('rollback preserves children beneath a replaced operation-created ancestor', async (t) => {
  const { disposableRoot, homeDir, runtime } = await createInstallationFixture(t);
  const parent = path.join(homeDir, HARNESS_REGISTRY[0].skillsDir);
  const root = path.dirname(parent);
  await rm(root, { recursive: true });
  let changed = false;
  const result = await executeLifecycle({ operation: 'install' }, {
    ...runtime,
    async afterJournalSnapshot(journal) {
      const completion = journal.completed.at(-1);
      if (changed || completion?.action !== 'create-parent' || completion.path !== parent) return;
      changed = true;
      const saved = path.join(disposableRoot, 'saved-parent');
      await rename(root, saved);
      await mkdir(root);
      await rename(path.join(saved, 'skills'), parent);
      throw new Error('injected ancestor replacement');
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ROLLBACK_FAILED');
  assert.ok(result.error.preserved.includes(root));
  assert.ok(result.error.preserved.includes(parent));
  assert.equal((await lstat(parent)).isDirectory(), true);
});

test('replacement during parent creation is never adopted as operation-owned', async (t) => {
  const { disposableRoot, homeDir, runtime } = await createInstallationFixture(t);
  const root = path.join(homeDir, HARNESS_REGISTRY[0].skillsDir.split('/')[0]);
  await rm(root, { recursive: true });
  let replaced = false;
  const result = await executeLifecycle({ operation: 'install' }, {
    ...runtime,
    async afterMutation(name, target) {
      if (!replaced && name === 'parent:created') {
        replaced = true;
        await rename(target, path.join(disposableRoot, 'original-parent'));
        await mkdir(target);
      }
      if (name === `install:${HARNESS_REGISTRY[0].key}-published`) throw new Error('injected');
    },
  });
  assert.equal(replaced, true);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ROLLBACK_FAILED');
  assert.ok(result.error.preserved.includes(root));
  assert.equal((await lstat(root)).isDirectory(), true);
  assert.deepEqual(await readdir(root), []);
});

test('failed install never reclaims pre-existing empty parents', async (t) => {
  const { homeDir, runtime } = await createInstallationFixture(t);
  const parent = path.join(homeDir, HARNESS_REGISTRY[0].skillsDir);
  for (const name of await readdir(parent)) await rm(path.join(parent, name));
  const before = await lstat(parent);
  const result = await executeLifecycle({ operation: 'install' }, {
    ...runtime,
    afterMutation(name) {
      if (name === `install:${HARNESS_REGISTRY[0].key}-published`) throw new Error('injected');
    },
  });
  assert.equal(result.ok, false);
  assert.equal((await lstat(parent)).ino, before.ino);
  assert.deepEqual(await readdir(parent), []);
});

test('successful uninstall retains discovery parents created by the successful install', async (t) => {
  const { homeDir, runtime } = await createInstallationFixture(t);
  const root = path.join(homeDir, HARNESS_REGISTRY[0].skillsDir.split('/')[0]);
  await rm(root, { recursive: true });
  assert.equal((await executeLifecycle({ operation: 'install' }, runtime)).ok, true);
  const parent = path.join(homeDir, HARNESS_REGISTRY[0].skillsDir);
  const before = await lstat(parent);
  assert.equal((await executeLifecycle({ operation: 'uninstall' }, runtime)).ok, true);
  assert.equal((await lstat(parent)).ino, before.ino);
  assert.deepEqual(await readdir(parent), []);
});

async function addCustomHarness(homeDir) {
  const configDir = path.join(homeDir, '.config', 'agent-init');
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(configDir, 'harnesses.json'), JSON.stringify({
    schemaVersion: 1,
    harnesses: [{ id: 'custom', label: 'Custom', skillsDir: '.custom/deep/nested/skills' }],
  }));
}

test('failed reconcile reclaims its custom nested parent chain without changing the installation', async (t) => {
  const { homeDir, runtime } = await createInstallationFixture(t);
  const installed = await executeLifecycle({ operation: 'install' }, runtime);
  assert.equal(installed.ok, true);
  const manifestBefore = await readFile(installed.paths.manifest, 'utf8');
  await addCustomHarness(homeDir);
  const result = await executeLifecycle({ operation: 'update' }, {
    ...runtime,
    afterMutation(name) {
      if (name === 'reconcile:custom-published') throw new Error('injected reconcile failure');
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /injected reconcile failure/);
  await assert.rejects(lstat(path.join(homeDir, '.custom')), { code: 'ENOENT' });
  assert.equal(await readFile(installed.paths.manifest, 'utf8'), manifestBefore);
});

test('recovery reclaims custom nested parents after interrupted reconcile', async (t) => {
  const { homeDir, runtime } = await createInstallationFixture(t);
  assert.equal((await executeLifecycle({ operation: 'install' }, runtime)).ok, true);
  await addCustomHarness(homeDir);
  crashInstall(runtime, `runtime.afterMutation = (name) => {
    if (name === 'reconcile:custom-published') process.exit(77);
  };`, 'update');

  const result = await executeLifecycle({ operation: 'uninstall' }, runtime);

  assert.equal(result.ok, true, JSON.stringify(result));
  await assert.rejects(lstat(path.join(homeDir, '.custom')), { code: 'ENOENT' });
});

for (const operation of ['install', 'update']) {
  test(`parent rollback resumes after a second crash during ${operation} recovery`, async (t) => {
    const { homeDir, runtime } = await createInstallationFixture(t);
    if (operation === 'update') {
      assert.equal((await executeLifecycle({ operation: 'install' }, runtime)).ok, true);
      await addCustomHarness(homeDir);
    } else {
      await rm(path.join(homeDir, HARNESS_REGISTRY[0].skillsDir.split('/')[0]), { recursive: true });
    }
    const mutation = operation === 'update' ? 'reconcile:custom-published' : `install:${HARNESS_REGISTRY[0].key}-published`;
    crashInstall(runtime, `runtime.afterMutation = (name) => {
      if (name === ${JSON.stringify(mutation)}) process.exit(77);
    };`, operation);
    crashInstall(runtime, `runtime.afterJournalSnapshot = (journal) => {
      if (journal.phase === 'parent-rollback') process.exit(77);
    };`, 'uninstall');

    const result = await executeLifecycle({ operation: 'uninstall' }, runtime);

    assert.equal(result.ok, true, JSON.stringify(result));
    const rootName = operation === 'update' ? '.custom' : HARNESS_REGISTRY[0].skillsDir.split('/')[0];
    await assert.rejects(lstat(path.join(homeDir, rootName)), { code: 'ENOENT' });
  });
}

for (const operation of ['install', 'update']) {
  test(`throwing parent rollback checkpoint retains recoverable evidence for ${operation}`, async (t) => {
    const { homeDir, runtime } = await createInstallationFixture(t);
    if (operation === 'update') {
      assert.equal((await executeLifecycle({ operation: 'install' }, runtime)).ok, true);
      await addCustomHarness(homeDir);
    } else {
      await rm(path.join(homeDir, HARNESS_REGISTRY[0].skillsDir.split('/')[0]), { recursive: true });
    }
    const result = await executeLifecycle({ operation }, {
      ...runtime,
      afterMutation(name) {
        if (name === (operation === 'update' ? 'reconcile:custom-published' : `install:${HARNESS_REGISTRY[0].key}-published`)) throw new Error('injected install failure');
      },
      afterJournalSnapshot(journal) {
        if (journal.phase === 'parent-rollback') throw new Error('checkpoint failed');
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'ROLLBACK_FAILED');
    assert.match(result.error.remediation, /checkpoint/i);
    assert.ok((await readdir(homeDir)).some((name) => name.includes('.journal-')));
    const retry = await executeLifecycle({ operation: 'uninstall' }, runtime);
    assert.equal(retry.ok, true, JSON.stringify(retry));
    await assert.rejects(lstat(path.join(homeDir, operation === 'update' ? '.custom' : HARNESS_REGISTRY[0].skillsDir.split('/')[0])), { code: 'ENOENT' });
  });
}

test('recovery resumes after deleting only the deepest parent in a nested chain', async (t) => {
  const { homeDir, runtime } = await createInstallationFixture(t);
  assert.equal((await executeLifecycle({ operation: 'install' }, runtime)).ok, true);
  await addCustomHarness(homeDir);
  crashInstall(runtime, `runtime.afterMutation = (name) => {
    if (name === 'reconcile:custom-published') process.exit(77);
  };`, 'update');
  crashInstall(runtime, `runtime.afterMutation = (name) => {
    if (name === 'parent:removed') process.exit(77);
  };`, 'uninstall');
  await assert.rejects(lstat(path.join(homeDir, '.custom/deep/nested/skills')), { code: 'ENOENT' });
  assert.equal((await lstat(path.join(homeDir, '.custom/deep/nested'))).isDirectory(), true);

  const result = await executeLifecycle({ operation: 'uninstall' }, runtime);

  assert.equal(result.ok, true, JSON.stringify(result));
  await assert.rejects(lstat(path.join(homeDir, '.custom')), { code: 'ENOENT' });
});

test('failed repair reclaims only newly recreated discovery parents', async (t) => {
  const { homeDir, runtime } = await createInstallationFixture(t);
  assert.equal((await executeLifecycle({ operation: 'install' }, runtime)).ok, true);
  const root = path.join(homeDir, HARNESS_REGISTRY[0].skillsDir.split('/')[0]);
  await rm(root, { recursive: true });
  const result = await executeLifecycle({ operation: 'install' }, {
    ...runtime,
    afterJournalSnapshot(journal) {
      if (journal.completed.at(-1)?.action === 'create-parent') throw new Error('injected repair failure');
    },
  });
  assert.equal(result.ok, false);
  await assert.rejects(lstat(root), { code: 'ENOENT' });
});

function crashInstall(runtime, hook, operation = 'install') {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { executeLifecycle } from ${JSON.stringify(new URL('../../src/installation/lifecycle.js', import.meta.url).href)};
    const runtime = ${JSON.stringify(runtime)};
    ${hook}
    const result = await executeLifecycle({ operation: ${JSON.stringify(operation)} }, runtime);
    process.stderr.write(JSON.stringify(result));
  `], { encoding: 'utf8' });
  assert.equal(child.status, 77, child.stderr);
}

test('retained parent rollback can be retried in the same process after foreign content is resolved', async (t) => {
  const { homeDir, runtime } = await createInstallationFixture(t);
  const root = path.join(homeDir, HARNESS_REGISTRY[0].skillsDir.split('/')[0]);
  await rm(root, { recursive: true });
  const foreign = path.join(root, 'foreign.txt');
  let injected = false;
  const failed = await executeLifecycle({ operation: 'install' }, {
    ...runtime,
    async afterJournalSnapshot(journal) {
      if (injected || journal.completed.at(-1)?.action !== 'create-parent') return;
      injected = true;
      await writeFile(foreign, 'owned by another process');
      throw new Error('injected');
    },
  });
  assert.equal(failed.error.code, 'ROLLBACK_FAILED');
  await rm(foreign);

  const result = await executeLifecycle({ operation: 'uninstall' }, runtime);

  assert.equal(result.ok, true, JSON.stringify(result));
  await assert.rejects(lstat(root), { code: 'ENOENT' });
});

test('reconcile parent rollback resumes after preserved foreign content is resolved', async (t) => {
  const { homeDir, runtime } = await createInstallationFixture(t);
  assert.equal((await executeLifecycle({ operation: 'install' }, runtime)).ok, true);
  await addCustomHarness(homeDir);
  const root = path.join(homeDir, '.custom');
  const foreign = path.join(root, 'foreign.txt');
  const failed = await executeLifecycle({ operation: 'update' }, {
    ...runtime,
    async afterMutation(name) {
      if (name !== 'reconcile:custom-published') return;
      await writeFile(foreign, 'foreign');
      throw new Error('injected');
    },
  });
  assert.equal(failed.error.code, 'ROLLBACK_FAILED');
  await rm(foreign);

  const result = await executeLifecycle({ operation: 'uninstall' }, runtime);

  assert.equal(result.ok, true, JSON.stringify(result));
  await assert.rejects(lstat(root), { code: 'ENOENT' });
});

test('recovery preserves a parent created before its identity completion was durable', async (t) => {
  const { homeDir, runtime } = await createInstallationFixture(t);
  const root = path.join(homeDir, HARNESS_REGISTRY[0].skillsDir.split('/')[0]);
  await rm(root, { recursive: true });
  crashInstall(runtime, `runtime.afterMutation = (name) => {
    if (name === 'parent:created') process.exit(77);
  };`);
  const before = await lstat(root);

  for (let retry = 0; retry < 2; retry += 1) {
    const result = await executeLifecycle({ operation: 'uninstall' }, runtime);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'ROLLBACK_FAILED', JSON.stringify(result));
    assert.ok(result.error.preserved.includes(root));
    assert.equal((await lstat(root)).ino, before.ino);
  }
});

test('EEXIST during parent creation never grants rollback ownership', async (t) => {
  const { homeDir, runtime } = await createInstallationFixture(t);
  const root = path.join(homeDir, HARNESS_REGISTRY[0].skillsDir.split('/')[0]);
  await rm(root, { recursive: true });
  let identity;
  const result = await executeLifecycle({ operation: 'install' }, {
    ...runtime,
    async beforeMutation(name, target) {
      if (name === `parent:create:${path.basename(root)}`) {
        await mkdir(target);
        identity = (await lstat(target)).ino;
      }
    },
    afterMutation(name) {
      if (name === `install:${HARNESS_REGISTRY[0].key}-published`) throw new Error('injected');
    },
  });
  assert.equal(result.ok, false);
  assert.equal((await lstat(root)).ino, identity);
  assert.deepEqual(await readdir(root), []);
});

test('rollback never follows a replaced ancestor to its original child directory', async (t) => {
  const { disposableRoot, homeDir, runtime } = await createInstallationFixture(t);
  const parent = path.join(homeDir, HARNESS_REGISTRY[0].skillsDir);
  const root = path.dirname(parent);
  const saved = path.join(disposableRoot, 'original-tree');
  await rm(root, { recursive: true });
  let replaced = false;
  const result = await executeLifecycle({ operation: 'install' }, {
    ...runtime,
    afterMutation(name) {
      if (name === `install:${HARNESS_REGISTRY[0].key}-published`) throw new Error('injected');
    },
    async beforeMutation(name, target) {
      if (replaced || name !== 'parent:remove' || target !== parent) return;
      replaced = true;
      await rename(root, saved);
      await symlink(saved, root, 'dir');
    },
  });
  assert.equal(replaced, true);
  assert.equal(result.error.code, 'ROLLBACK_FAILED');
  assert.equal((await lstat(root)).isSymbolicLink(), true);
  assert.equal((await lstat(path.join(saved, 'skills'))).isDirectory(), true);
});

for (const corruption of ['operationId', 'outside-path', 'missing-identity', 'null-record']) {
  test(`recovery refuses invalid parent evidence: ${corruption}`, async (t) => {
    const { homeDir, runtime } = await createInstallationFixture(t);
    const root = path.join(homeDir, HARNESS_REGISTRY[0].skillsDir.split('/')[0]);
    await rm(root, { recursive: true });
    crashInstall(runtime, `runtime.afterJournalSnapshot = (journal) => {
      if (journal.completed.at(-1)?.action === 'create-parent') process.exit(77);
    };`);
    const journals = (await readdir(homeDir)).filter((name) => name.includes('.journal-')).sort();
    const journalPath = path.join(homeDir, journals.at(-1));
    const journal = JSON.parse(await readFile(journalPath, 'utf8'));
    const record = journal.completed.find((entry) => entry.action === 'create-parent');
    if (corruption === 'operationId') record.operationId = 'another-operation';
    if (corruption === 'outside-path') record.path = homeDir;
    if (corruption === 'missing-identity') delete record.entryIdentity;
    if (corruption === 'null-record') journal.completed.push(null);
    await writeFile(journalPath, JSON.stringify(journal));

    const result = await executeLifecycle({ operation: 'uninstall' }, runtime);

    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'AMBIGUOUS_OPERATION', JSON.stringify(result));
    assert.equal((await lstat(root)).isDirectory(), true);
  });
}

test('legacy journals without creation evidence never reclaim discovery parents', async (t) => {
  const { homeDir, runtime } = await createInstallationFixture(t);
  const root = path.join(homeDir, HARNESS_REGISTRY[0].skillsDir.split('/')[0]);
  await rm(root, { recursive: true });
  crashInstall(runtime, `runtime.afterJournalSnapshot = (journal) => {
    if (journal.completed.at(-1)?.action === 'create-parent') process.exit(77);
  };`);
  const journals = (await readdir(homeDir)).filter((name) => name.includes('.journal-')).sort();
  const journalPath = path.join(homeDir, journals.at(-1));
  const journal = JSON.parse(await readFile(journalPath, 'utf8'));
  journal.intents = journal.intents.filter((entry) => entry.action !== 'create-parent');
  journal.completed = journal.completed.filter((entry) => entry.action !== 'create-parent');
  await writeFile(journalPath, JSON.stringify(journal));

  const result = await executeLifecycle({ operation: 'uninstall' }, runtime);

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal((await lstat(root)).isDirectory(), true);
});

test('recovery reclaims journal-owned empty discovery parents after an interrupted install', async (t) => {
  const { homeDir, runtime } = await createInstallationFixture(t);
  const root = path.join(homeDir, HARNESS_REGISTRY[0].skillsDir.split('/')[0]);
  await rm(root, { recursive: true });
  crashInstall(runtime, `runtime.afterJournalSnapshot = (journal) => {
    if (journal.completed.at(-1)?.action === 'create-parent') process.exit(77);
  };`);

  const result = await executeLifecycle({ operation: 'uninstall' }, runtime);

  assert.equal(result.ok, true, JSON.stringify(result));
  await assert.rejects(lstat(root), { code: 'ENOENT' });
});
