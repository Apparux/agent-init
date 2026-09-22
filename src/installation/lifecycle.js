import { randomBytes as secureRandomBytes } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import {
  copyTree,
  digestTree,
  entryFingerprint,
  readRegularFileNoFollow,
} from './filesystem.js';
import {
  MANIFEST_SCHEMA_VERSION,
  OWNER_MARKER,
  publishJsonNoReplace,
  readManifest,
  removeRegularIfIdentity,
  replaceJsonCas,
  restoreJsonRollback,
  serializeJson,
  validateManifest,
} from './manifest.js';
import {
  InstallationError,
  resolveInstallationPaths,
  validateManagedAncestors,
} from './paths.js';
import { compareVersions, validatePackagePayload } from './payload.js';
import {
  inspectTarget,
  linkResolvesToCanonical,
  materializeTarget,
  removeOwnedTarget,
} from './targets.js';
import {
  acquireOperation,
  inspectOperationControl,
  markOperationInactive,
  recordCompletion,
  removeRecoveredOperation,
  recordIntent,
  releaseOperation,
  resumeRecoveredOperation,
  updateOperation,
} from './transaction.js';

function randomHex(runtime, bytes = 16) {
  const generator = runtime.randomBytes ?? secureRandomBytes;
  const value = generator(bytes);
  if (!Buffer.isBuffer(value) || value.length !== bytes) {
    throw new InstallationError(
      'INVALID_RUNTIME',
      'Runtime randomBytes() did not return the requested Buffer.',
      { remediation: 'Use the production runtime or a valid cryptographic random source.' },
    );
  }
  return value.toString('hex');
}

function isoNow(runtime) {
  const value = (runtime.now ?? (() => new Date()))();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) {
    throw new InstallationError(
      'INVALID_RUNTIME',
      'Runtime clock did not return a valid date.',
      { remediation: 'Use a valid runtime clock.' },
    );
  }
  return date.toISOString();
}

async function inspectInitialState(paths, runtime) {
  await validateManagedAncestors(paths, paths.installRoot);
  for (const parent of Object.values(paths.targetParents)) {
    await validateManagedAncestors(paths, parent);
  }

  const installRoot = await entryFingerprint(paths.installRoot);
  let manifest = null;
  if (installRoot.type !== 'missing') {
    if (installRoot.type !== 'directory') {
      throw new InstallationError(
        'INSTALL_CONFLICT',
        `Stable installation path is not a directory: ${paths.installRoot}`,
        { path: paths.installRoot, remediation: 'Move the conflicting entry and retry.' },
      );
    }
    manifest = await readManifest(paths.manifest, {
      packageName: runtime.packageName,
      paths,
    });
    if (!manifest) {
      const entries = await readdir(paths.installRoot);
      if (entries.length !== 0) {
        throw new InstallationError(
          'PARTIAL_INSTALLATION',
          `Stable installation directory has no valid manifest: ${paths.installRoot}`,
          {
            path: paths.installRoot,
            remediation: 'Preserve and inspect the unknown contents before retrying.',
          },
        );
      }
    }
  }

  const targets = {};
  for (const name of ['codex', 'claude']) {
    targets[name] = await inspectTarget(
      paths,
      name,
      manifest?.targets?.[name] ?? null,
      manifest,
    );
  }
  return { installRoot, manifest, targets };
}

function throwOnInstallConflict(state, paths) {
  if (!state.manifest && state.installRoot.type !== 'missing') {
    throw new InstallationError(
      'PARTIAL_INSTALLATION',
      `Stable installation directory is not a managed installation: ${paths.installRoot}`,
      {
        path: paths.installRoot,
        remediation: 'Remove the empty directory after review, or restore its manifest.',
      },
    );
  }
  for (const target of Object.values(state.targets)) {
    if (target.status === 'foreign' || target.status === 'ambiguous' || target.status === 'owned-drifted') {
      throw new InstallationError(
        'INSTALL_CONFLICT',
        `Existing ${target.name} target is not safely managed: ${target.path}`,
        {
          path: target.path,
          targetState: target.status,
          remediation: 'Preserve or move the existing target, then retry install.',
        },
      );
    }
  }
}

async function readCanonicalMarker(paths) {
  try {
    const marker = JSON.parse(
      await readRegularFileNoFollow(paths.canonicalMarker, 'utf8'),
    );
    if (marker?.schemaVersion !== 1) {
      throw new Error(`Unsupported canonical marker schema: ${paths.canonicalMarker}`);
    }
    return marker;
  } catch (error) {
    return { error };
  }
}

async function validateCanonicalLayout(root) {
  const rootFingerprint = await entryFingerprint(root);
  if (rootFingerprint.type !== 'directory') {
    return { valid: false, reason: 'Canonical root is not a regular directory.' };
  }
  let rootEntries;
  try {
    rootEntries = (await readdir(root)).sort();
  } catch (error) {
    return { valid: false, reason: error.message };
  }
  if (
    rootEntries.length !== 2 ||
    rootEntries[0] !== OWNER_MARKER ||
    rootEntries[1] !== 'skills'
  ) {
    return { valid: false, reason: 'Canonical root contains unknown or missing entries.' };
  }
  const markerFingerprint = await entryFingerprint(path.join(root, OWNER_MARKER));
  const skillsRoot = path.join(root, 'skills');
  const skillsFingerprint = await entryFingerprint(skillsRoot);
  if (markerFingerprint.type !== 'file' || skillsFingerprint.type !== 'directory') {
    return { valid: false, reason: 'Canonical marker or skills entry has an unexpected type.' };
  }
  const skillEntries = (await readdir(skillsRoot)).sort();
  if (skillEntries.length !== 1 || skillEntries[0] !== 'agent-init') {
    return { valid: false, reason: 'Canonical skills directory contains unknown entries.' };
  }
  const skillFingerprint = await entryFingerprint(path.join(skillsRoot, 'agent-init'));
  if (skillFingerprint.type !== 'directory') {
    return { valid: false, reason: 'Canonical agent-init payload is not a regular directory.' };
  }
  return { valid: true };
}

async function inspectCanonical(paths, manifest) {
  const root = await entryFingerprint(paths.canonicalRoot);
  if (root.type === 'missing') {
    return { status: manifest ? 'owned-broken' : 'missing', root, removable: false };
  }
  if (!manifest) return { status: 'foreign', root, removable: false };
  if (root.type !== 'directory') {
    return { status: 'owned-drifted', root, removable: false };
  }
  const layout = await validateCanonicalLayout(paths.canonicalRoot);
  if (!layout.valid) {
    return { status: 'owned-drifted', root, layout, removable: false };
  }
  const marker = await readCanonicalMarker(paths);
  if (marker.error || marker.installId !== manifest.installId) {
    return { status: 'owned-drifted', root, marker, removable: false };
  }
  let digest;
  try {
    digest = await digestTree(paths.canonicalSkill);
  } catch (error) {
    return { status: 'owned-drifted', root, marker, error, removable: false };
  }
  if (digest !== manifest.canonical.digest) {
    return { status: 'owned-drifted', root, marker, digest, removable: false };
  }
  return { status: 'owned-valid', root, marker, digest, removable: true };
}

async function removeIfSameSymlink(targetPath, identity) {
  const current = await entryFingerprint(targetPath);
  if (current.type === 'symlink' && current.identity === identity) {
    await unlink(targetPath);
    return true;
  }
  return false;
}

async function detachAndDeleteOwnedDirectory(options) {
  const {
    livePath,
    quarantinePath,
    expectedIdentity,
    verifyDetached,
  } = options;
  const current = await entryFingerprint(livePath);
  if (current.type !== 'directory' || current.identity !== expectedIdentity) return false;
  await rename(livePath, quarantinePath);
  let verified = false;
  try {
    const detached = await entryFingerprint(quarantinePath);
    verified =
      detached.type === 'directory' &&
      detached.identity === expectedIdentity &&
      (await verifyDetached(quarantinePath));
    if (!verified) {
      const destination = await entryFingerprint(livePath);
      if (destination.type === 'missing') await rename(quarantinePath, livePath);
      return false;
    }
    await rm(quarantinePath, { recursive: true });
    return true;
  } catch (error) {
    if (!verified) {
      const destination = await entryFingerprint(livePath).catch(() => ({ type: 'unknown' }));
      if (destination.type === 'missing') await rename(quarantinePath, livePath).catch(() => {});
    }
    throw error;
  }
}

async function rollbackFreshInstall(created, paths, operation, installId, digest) {
  const unresolved = [];
  for (const target of [...created.targets].reverse()) {
    if (target.mode === 'symlink') {
      if (!(await removeIfSameSymlink(target.path, target.entryIdentity))) {
        unresolved.push(target.path);
      }
      continue;
    }
    const quarantine = path.join(
      path.dirname(target.path),
      `.agent-init-rollback-${operation.operationId}-${target.name}`,
    );
    const removed = await detachAndDeleteOwnedDirectory({
      livePath: target.path,
      quarantinePath: quarantine,
      expectedIdentity: target.identity,
      verifyDetached: async (detachedPath) => {
        let marker;
        try {
          marker = JSON.parse(await readRegularFileNoFollow(path.join(detachedPath, OWNER_MARKER), 'utf8'));
        } catch {
          return false;
        }
        return (
          marker.installId === installId &&
          marker.targetId === target.targetId &&
          (await digestTree(detachedPath, { exclude: [OWNER_MARKER] })) === digest
        );
      },
    });
    if (!removed) unresolved.push(target.path);
  }

  if (created.manifest) {
    const current = await entryFingerprint(paths.manifest);
    if (current.type === 'file' && current.identity === created.manifest.identity) {
      await unlink(paths.manifest);
    } else {
      unresolved.push(paths.manifest);
    }
  }

  if (created.canonical) {
    const quarantine = path.join(
      paths.installRoot,
      `.rollback-${operation.operationId}`,
    );
    const removed = await detachAndDeleteOwnedDirectory({
      livePath: paths.canonicalRoot,
      quarantinePath: quarantine,
      expectedIdentity: created.canonical.identity,
      verifyDetached: async (detachedPath) => {
        let marker;
        try {
          marker = JSON.parse(
            await readRegularFileNoFollow(path.join(detachedPath, OWNER_MARKER), 'utf8'),
          );
        } catch {
          return false;
        }
        return (
          marker.installId === installId &&
          (await digestTree(path.join(detachedPath, 'skills', 'agent-init'))) === digest
        );
      },
    });
    if (!removed) unresolved.push(paths.canonicalRoot);
  }
  if (created.installRoot) await rmdir(paths.installRoot).catch(() => {});
  return unresolved;
}

async function repairMissingTargets(payload, paths, runtime, operation, oldManifest) {
  const current = await inspectInitialState(paths, runtime);
  const canonical = await inspectCanonical(paths, current.manifest);
  if (
    !current.manifest ||
    current.manifest.installId !== oldManifest.installId ||
    canonical.status !== 'owned-valid'
  ) {
    throw new InstallationError(
      'OWNERSHIP_MISMATCH',
      `Installation changed before repair: ${paths.installRoot}`,
      { path: paths.installRoot, remediation: 'Run doctor and inspect the changed ownership evidence.' },
    );
  }
  const repairNames = Object.values(current.targets)
    .filter((target) => target.status === 'owned-broken' && target.fingerprint.type === 'missing')
    .map((target) => target.name);
  if (
    repairNames.length === 0 ||
    Object.values(current.targets).some(
      (target) => !['owned-valid', 'owned-broken'].includes(target.status),
    )
  ) {
    throw new InstallationError(
      'OWNERSHIP_MISMATCH',
      `Only proven missing managed targets can be repaired: ${paths.installRoot}`,
      { path: paths.installRoot, remediation: 'Run doctor and resolve drift or ambiguity manually.' },
    );
  }

  const created = [];
  const rememberPublishedSymlink = (name, record) => {
    if (record.mode === 'symlink' && !created.some((target) => target.name === name)) {
      created.push({ name, ...record });
    }
  };
  const manifestFingerprint = await entryFingerprint(paths.manifest);
  let manifestSwap = null;
  try {
    const nextManifest = structuredClone(current.manifest);
    for (const name of repairNames) {
      const targetId = randomHex(runtime);
      const record = await materializeTarget({
        paths,
        name,
        targetId,
        installId: current.manifest.installId,
        digest: payload.digest,
        sourceSkill: paths.canonicalSkill,
        operation,
        createDirectorySymlink: runtime.createDirectorySymlink,
        beforeMutation: runtime.beforeMutation,
        afterMutation: runtime.afterMutation,
        onPublished: (published) => rememberPublishedSymlink(name, published),
      });
      nextManifest.targets[name] = record;
      if (!created.some((target) => target.name === name)) {
        created.push({ name, ...record });
      }
    }
    nextManifest.updatedAt = isoNow(runtime);
    await recordIntent(operation, {
      action: 'replace-manifest',
      path: paths.manifest,
      expectedIdentity: manifestFingerprint.identity,
      version: nextManifest.version,
    });
    const beforeWrite = await entryFingerprint(paths.manifest);
    if (
      beforeWrite.type !== 'file' ||
      beforeWrite.identity !== manifestFingerprint.identity
    ) {
      throw new InstallationError(
        'OWNERSHIP_MISMATCH',
        `Manifest changed before repair commit: ${paths.manifest}`,
        { path: paths.manifest, remediation: 'Preserve the changed manifest and run doctor.' },
      );
    }
    manifestSwap = await replaceJsonCas(
      paths.manifest,
      nextManifest,
      `${operation.operationId}-manifest-repair`,
      manifestFingerprint.identity,
      {
        keepRollback: true,
        rollbackPath: path.join(
          paths.installRoot,
          `.install.json.rollback-${operation.operationId}`,
        ),
        beforeDetach: () => callBeforeMutation(runtime, 'manifest:repair-before-detach'),
      },
    );
    await recordCompletion(operation, { action: 'replace-manifest', path: paths.manifest });

    const verified = await readManifest(paths.manifest, {
      packageName: runtime.packageName,
      paths,
    });
    for (const name of ['codex', 'claude']) {
      const target = await inspectTarget(paths, name, verified.targets[name], verified);
      if (target.status !== 'owned-valid') {
        throw new InstallationError(
          'PARTIAL_INSTALLATION',
          `Repaired target failed validation: ${target.path}`,
          { path: target.path, remediation: 'Run doctor and inspect the retained operation evidence.' },
        );
      }
    }
    await updateOperation(operation, { phase: 'committed', committed: true });
    if (
      manifestSwap?.rollbackPath &&
      !(await removeRegularIfIdentity(
        manifestSwap.rollbackPath,
        manifestSwap.rollbackIdentity,
      ))
    ) {
      throw new InstallationError(
        'AMBIGUOUS_OPERATION',
        `Manifest rollback identity changed before cleanup: ${manifestSwap.rollbackPath}`,
        { path: manifestSwap.rollbackPath, remediation: 'Preserve the rollback file for manual review.' },
      );
    }
    return {
      ok: true,
      outcome: 'repaired',
      operation: 'install',
      version: runtime.packageVersion,
      paths,
      manifest: verified,
      changed: [...created.map((target) => target.path), paths.manifest],
      preserved: Object.values(paths.targets).filter(
        (targetPath) => !created.some((target) => target.path === targetPath),
      ),
      unresolved: [],
    };
  } catch (error) {
    const unresolved = [];
    for (const target of created.reverse()) {
      if (target.mode === 'symlink') {
        try {
          if (!(await removeIfSameSymlink(target.path, target.entryIdentity))) {
            unresolved.push(target.path);
          }
        } catch {
          unresolved.push(target.path);
        }
      }
    }
    if (manifestSwap?.rollbackPath) {
      const restored = await restoreJsonRollback(
        paths.manifest,
        manifestSwap.identity,
        manifestSwap.rollbackPath,
        manifestSwap.rollbackIdentity,
      ).catch(() => false);
      if (!restored) {
        throw new InstallationError(
          'ROLLBACK_FAILED',
          `Repair failed and the previous manifest could not be restored safely: ${paths.manifest}`,
          {
            path: paths.manifest,
            cause: error,
            unresolved: [paths.manifest, manifestSwap.rollbackPath, ...unresolved],
            remediation: 'Preserve both manifest entries and run doctor before any manual change.',
          },
        );
      }
    }
    if (unresolved.length > 0) {
      throw new InstallationError(
        'ROLLBACK_FAILED',
        `Repair failed and rollback could not prove every target: ${paths.installRoot}`,
        {
          path: paths.installRoot,
          cause: error,
          unresolved,
          remediation: 'Preserve the target and run doctor before any manual change.',
        },
      );
    }
    throw error;
  }
}

async function installFresh(payload, paths, runtime, operation) {
  const installId = randomHex(runtime);
  const installedAt = isoNow(runtime);
  const targetIds = {
    codex: randomHex(runtime),
    claude: randomHex(runtime),
  };
  const created = {
    installRoot: false,
    canonical: null,
    targets: [],
    manifest: null,
  };
  const stagingRoot = path.join(
    paths.installRoot,
    `.staging-${operation.operationId}`,
  );
  const rememberPublishedSymlink = (name, record) => {
    if (record.mode === 'symlink' && !created.targets.some((target) => target.name === name)) {
      created.targets.push({ ...record, name, identity: record.entryIdentity });
    }
  };

  try {
    await recordIntent(operation, {
      action: 'create-install-root',
      path: paths.installRoot,
      expected: 'missing',
    });
    const beforeRoot = await entryFingerprint(paths.installRoot);
    if (beforeRoot.type !== 'missing') {
      throw new InstallationError(
        'INSTALL_CONFLICT',
        `Stable installation path appeared during install: ${paths.installRoot}`,
        {
          path: paths.installRoot,
          remediation: 'Preserve the new entry and resolve the concurrent change before retrying.',
        },
      );
    }
    await mkdir(paths.installRoot);
    created.installRoot = true;
    const installRootFingerprint = await entryFingerprint(paths.installRoot);
    await recordCompletion(operation, {
      action: 'create-install-root',
      path: paths.installRoot,
      entryIdentity: installRootFingerprint.identity,
    });

    await recordIntent(operation, {
      action: 'create-canonical',
      path: paths.canonicalRoot,
      staging: stagingRoot,
      expected: 'missing',
      digest: payload.digest,
      installId,
    });
    await mkdir(stagingRoot);
    await mkdir(path.join(stagingRoot, 'skills'));
    await copyTree(payload.sourceSkill, path.join(stagingRoot, 'skills', 'agent-init'));
    await writeFile(
      path.join(stagingRoot, OWNER_MARKER),
      serializeJson({ schemaVersion: 1, installId }),
      { flag: 'wx', mode: 0o600 },
    );
    if ((await digestTree(path.join(stagingRoot, 'skills', 'agent-init'))) !== payload.digest) {
      throw new InstallationError(
        'INTEGRITY_CONFLICT',
        `Staged canonical payload digest changed: ${stagingRoot}`,
        { path: stagingRoot, remediation: 'Use an intact package and retry.' },
      );
    }
    await callAfterMutation(runtime, 'install:canonical-staged');
    await validateManagedAncestors(paths, paths.installRoot, { allowMissing: false });
    if ((await entryFingerprint(paths.canonicalRoot)).type !== 'missing') {
      throw new InstallationError(
        'INSTALL_CONFLICT',
        `Canonical path appeared during install: ${paths.canonicalRoot}`,
        { path: paths.canonicalRoot, remediation: 'Preserve the new entry and inspect it.' },
      );
    }
    await rename(stagingRoot, paths.canonicalRoot);
    const canonicalFingerprint = await entryFingerprint(paths.canonicalRoot);
    created.canonical = { identity: canonicalFingerprint.identity };
    await recordCompletion(operation, {
      action: 'create-canonical',
      path: paths.canonicalRoot,
      entryIdentity: canonicalFingerprint.identity,
    });
    await callAfterMutation(runtime, 'install:canonical-published');

    const targetRecords = {};
    for (const name of ['codex', 'claude']) {
      const record = await materializeTarget({
        paths,
        name,
        targetId: targetIds[name],
        installId,
        digest: payload.digest,
        sourceSkill: paths.canonicalSkill,
        operation,
        createDirectorySymlink: runtime.createDirectorySymlink,
        beforeMutation: runtime.beforeMutation,
        afterMutation: runtime.afterMutation,
        onPublished: (published) => rememberPublishedSymlink(name, published),
      });
      targetRecords[name] = record;
      if (!created.targets.some((target) => target.name === name)) {
        const fingerprint = await entryFingerprint(record.path);
        created.targets.push({
          ...record,
          name,
          identity: fingerprint.identity,
        });
      }
      await callAfterMutation(runtime, `install:${name}-published`);
    }

    const manifest = {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      package: runtime.packageName,
      version: runtime.packageVersion,
      installId,
      installedAt,
      updatedAt: installedAt,
      installRoot: paths.installRoot,
      canonical: {
        root: paths.canonicalRoot,
        skillPath: paths.canonicalSkill,
        digest: payload.digest,
      },
      targets: targetRecords,
    };
    await recordIntent(operation, {
      action: 'write-manifest',
      path: paths.manifest,
      expected: 'missing',
      version: runtime.packageVersion,
    });
    if ((await entryFingerprint(paths.manifest)).type !== 'missing') {
      throw new InstallationError(
        'INSTALL_CONFLICT',
        `Manifest appeared during install: ${paths.manifest}`,
        { path: paths.manifest, remediation: 'Preserve and inspect the concurrent manifest.' },
      );
    }
    created.manifest = await publishJsonNoReplace(
      paths.manifest,
      manifest,
      `${operation.operationId}-manifest-install`,
      {
        beforePublish: () => callBeforeMutation(runtime, 'manifest:install-before-publish'),
      },
    );
    await recordCompletion(operation, {
      action: 'write-manifest',
      path: paths.manifest,
      entryIdentity: created.manifest.identity,
    });
    await callAfterMutation(runtime, 'install:manifest-published');

    const verifiedManifest = await readManifest(paths.manifest, {
      packageName: runtime.packageName,
      paths,
    });
    const canonical = await inspectCanonical(paths, verifiedManifest);
    const verifiedTargets = {};
    for (const name of ['codex', 'claude']) {
      verifiedTargets[name] = await inspectTarget(
        paths,
        name,
        verifiedManifest.targets[name],
        verifiedManifest,
      );
    }
    if (
      canonical.status !== 'owned-valid' ||
      Object.values(verifiedTargets).some((target) => target.status !== 'owned-valid')
    ) {
      throw new InstallationError(
        'PARTIAL_INSTALLATION',
        `Installed assets did not pass validation: ${paths.installRoot}`,
        { path: paths.installRoot, remediation: 'Inspect the retained lifecycle journal and retry.' },
      );
    }

    await updateOperation(operation, {
      phase: 'committed',
      committed: true,
      manifestVersion: runtime.packageVersion,
    });
    return {
      ok: true,
      outcome: 'installed',
      operation: 'install',
      version: runtime.packageVersion,
      paths,
      manifest: verifiedManifest,
      targets: verifiedTargets,
      changed: [
        paths.canonicalRoot,
        paths.targets.codex,
        paths.targets.claude,
        paths.manifest,
      ],
      preserved: [],
      unresolved: [],
    };
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
    const unresolved = await rollbackFreshInstall(
      created,
      paths,
      operation,
      installId,
      payload.digest,
    ).catch(() => [paths.installRoot]);
    if (unresolved.length > 0) {
      throw new InstallationError(
        'ROLLBACK_FAILED',
        `Fresh installation failed and rollback could not prove every asset: ${paths.installRoot}`,
        {
          path: paths.installRoot,
          cause: error,
          unresolved,
          remediation: 'Run doctor and inspect the retained operation journal before changing files.',
        },
      );
    }
    throw error;
  }
}

async function describeUninstallFailure(paths, operation, manifest, error) {
  const changed = [];
  const preserved = [];
  const unresolved = [];
  for (const completion of operation.journal.completed) {
    if (completion.action === 'remove-target') changed.push(completion.path);
    if (completion.action === 'remove-canonical') changed.push(paths.canonicalRoot);
    if (completion.action === 'remove-manifest') changed.push(paths.manifest);
    if (completion.action === 'remove-install-root') changed.push(paths.installRoot);
    if (completion.action === 'preserve-target') preserved.push(completion.path);
  }
  for (const candidate of [
    paths.targets.codex,
    paths.targets.claude,
    paths.canonicalRoot,
    paths.manifest,
    paths.installRoot,
  ]) {
    if ((await entryFingerprint(candidate)).type !== 'missing') preserved.push(candidate);
  }
  for (const candidate of [
    operation.lockPath,
    operation.descriptorPath,
    ...operation.journalSnapshots.map((snapshot) => snapshot.path),
    ...operation.journal.intents.flatMap((intent) =>
      [intent.quarantine, intent.staging].filter(Boolean),
    ),
  ]) {
    if ((await entryFingerprint(candidate)).type !== 'missing') unresolved.push(candidate);
  }
  return new InstallationError(
    error?.code ?? 'UNEXPECTED_ERROR',
    error?.message ?? `Uninstall stopped after partial changes: ${paths.installRoot}`,
    {
      path: error?.details?.path ?? paths.installRoot,
      cause: error,
      changed: [...new Set(changed)],
      preserved: [...new Set(preserved)],
      unresolved: [...new Set(unresolved)],
      remediation:
        error?.details?.remediation ??
        'Run doctor and retry uninstall to resume from the retained lifecycle evidence.',
      previousManifest: manifest,
    },
  );
}

function doctorCheck(id, status, code, checkPath, message, remediation) {
  return { id, status, code, path: checkPath, message, remediation };
}

function lifecycleControlDoctorChecks(paths, control) {
  if (control.status === 'idle') {
    return [
      doctorCheck(
        'lifecycle-control',
        'ok',
        'IDLE',
        paths.lock,
        'No lifecycle operation is active.',
        null,
      ),
    ];
  }
  if (control.status === 'orphaned') {
    return control.orphanPaths.map((orphanPath, index) =>
      doctorCheck(
        `lifecycle-control-orphan-${index + 1}`,
        'error',
        'ORPHAN_CONTROL',
        orphanPath,
        'Lifecycle control file exists without the authoritative fixed lock.',
        'Preserve the orphan control file and inspect it manually; do not delete it automatically.',
      ),
    );
  }
  return [
    doctorCheck(
      'lifecycle-control',
      control.status === 'busy' ? 'warning' : 'error',
      control.error.code,
      control.error.details?.path ?? paths.lock,
      control.error.message,
      control.error.details?.remediation,
    ),
  ];
}

async function inspectLifecycleResidue(paths) {
  const candidates = [];
  const locations = [
    {
      directory: paths.installRoot,
      patterns: [
        /^\.staging-[a-f0-9]{32}(?:\.failed)?$/,
        /^\.staging-cleanup-[a-f0-9]{32}$/,
        /^\.rollback-[a-f0-9]{32}$/,
        /^\.install\.json\.rollback-[a-f0-9]{32}$/,
        /^\.install\.json\.[a-f0-9]{32}-[a-z0-9-]+\.tmp$/,
      ],
    },
    ...['codex', 'claude'].map((name) => ({
      directory: paths.targetParents[name],
      patterns: [
        new RegExp(
          `^\\.agent-init-staging-[a-f0-9]{32}-${name}(?:\\.failed)?$`,
        ),
        new RegExp(`^\\.agent-init-staging-cleanup-[a-f0-9]{32}-${name}$`),
        new RegExp(`^\\.agent-init-rollback-[a-f0-9]{32}-${name}$`),
      ],
    })),
  ];
  for (const location of locations) {
    const directoryState = await entryFingerprint(location.directory);
    if (directoryState.type === 'missing') continue;
    if (directoryState.type !== 'directory') continue;
    const names = await readdir(location.directory);
    for (const name of names) {
      if (!location.patterns.some((pattern) => pattern.test(name))) continue;
      candidates.push(path.join(location.directory, name));
    }
  }
  return candidates.sort();
}

async function runDoctor(paths, runtime, payload, state, knownControl = undefined) {
  const checks = [];
  const control = knownControl ?? (await inspectOperationControl(paths));
  checks.push(...lifecycleControlDoctorChecks(paths, control));
  const residuePaths = await inspectLifecycleResidue(paths);
  checks.push(
    ...residuePaths.map((residuePath, index) =>
      doctorCheck(
        `lifecycle-residue-${index + 1}`,
        'error',
        'LIFECYCLE_RESIDUE',
        residuePath,
        'Operation-shaped staging or rollback residue remains.',
        'Preserve the residue and inspect the associated lifecycle evidence before retrying a mutating command.',
      ),
    ),
  );

  if (!state.manifest) {
    checks.push(
      doctorCheck(
        'manifest',
        'error',
        'NOT_INSTALLED',
        paths.manifest,
        'Installation manifest is missing.',
        'Run install after resolving any foreign targets.',
      ),
    );
    for (const name of ['codex', 'claude']) {
      const target = state.targets[name];
      checks.push(
        doctorCheck(
          `target-${name}`,
          target.status === 'missing' ? 'error' : 'error',
          target.status === 'missing' ? 'BROKEN_TARGET' : 'OWNERSHIP_MISMATCH',
          target.path,
          target.reason,
          target.status === 'missing'
            ? 'Run install.'
            : 'Preserve the foreign target and resolve the conflict manually.',
        ),
      );
    }
    return {
      ok: false,
      outcome: 'unhealthy',
      operation: 'doctor',
      version: runtime.packageVersion,
      checks,
      changed: [],
    };
  }

  checks.push(
    doctorCheck(
      'manifest',
      'ok',
      'MANIFEST_VALID',
      paths.manifest,
      'Installation manifest is valid.',
      null,
    ),
  );
  checks.push(
    doctorCheck(
      'version',
      state.manifest.version === runtime.packageVersion ? 'ok' : 'warning',
      state.manifest.version === runtime.packageVersion ? 'VERSION_MATCH' : 'VERSION_DIFFERENT',
      paths.manifest,
      `Installed: ${state.manifest.version}; Running: ${runtime.packageVersion}.`,
      state.manifest.version === runtime.packageVersion
        ? null
        : 'Use an intended package version and run update if an upgrade is required.',
    ),
  );
  const canonical = await inspectCanonical(paths, state.manifest);
  checks.push(
    doctorCheck(
      'canonical',
      canonical.status === 'owned-valid' ? 'ok' : 'error',
      canonical.status === 'owned-valid'
        ? 'CANONICAL_VALID'
        : canonical.status === 'owned-broken'
          ? 'MISSING_CANONICAL_SKILL'
          : 'OWNERSHIP_MISMATCH',
      paths.canonicalRoot,
      canonical.status === 'owned-valid'
        ? 'Canonical mother Skill marker and digest are valid.'
        : `Canonical mother Skill is ${canonical.status}.`,
      canonical.status === 'owned-valid'
        ? null
        : 'Preserve the installation and repair only after reviewing ownership evidence.',
    ),
  );
  checks.push(
    doctorCheck(
      'package-payload',
      state.manifest.version !== runtime.packageVersion ||
      state.manifest.canonical.digest === payload.digest
        ? 'ok'
        : 'error',
      state.manifest.version !== runtime.packageVersion ||
      state.manifest.canonical.digest === payload.digest
        ? 'PACKAGE_PAYLOAD_VALID'
        : 'INTEGRITY_CONFLICT',
      payload.sourceSkill,
      state.manifest.version !== runtime.packageVersion
        ? 'Running package differs in version; digest comparison is informational only.'
        : state.manifest.canonical.digest === payload.digest
          ? 'Running package payload matches the installed digest.'
          : 'Running package reuses the installed version with different payload bytes.',
      state.manifest.version !== runtime.packageVersion ||
      state.manifest.canonical.digest === payload.digest
        ? null
        : 'Use an intact package published under a new version.',
    ),
  );
  for (const name of ['codex', 'claude']) {
    const target = state.targets[name];
    const status = target.status === 'owned-valid' ? 'ok' : 'error';
    const code =
      target.status === 'owned-valid'
        ? 'TARGET_VALID'
        : target.status === 'owned-broken'
          ? 'BROKEN_TARGET'
          : target.status === 'foreign'
            ? 'INSTALL_CONFLICT'
            : 'OWNERSHIP_MISMATCH';
    checks.push(
      doctorCheck(
        `target-${name}`,
        status,
        code,
        target.path,
        `${target.reason}${state.manifest.targets[name] ? ` Mode: ${state.manifest.targets[name].mode}.` : ''}`,
        status === 'ok'
          ? null
          : target.status === 'owned-broken'
            ? 'Run install or update to repair only the missing managed target.'
            : 'Preserve the target and resolve ownership drift manually.',
      ),
    );
  }
  return {
    ok: checks.every((check) => check.status !== 'error'),
    outcome: checks.some((check) => check.status === 'error') ? 'unhealthy' : 'healthy',
    operation: 'doctor',
    version: runtime.packageVersion,
    installedVersion: state.manifest.version,
    checks,
    changed: [],
  };
}

async function validateCanonicalDirectory(root, installId, digest) {
  const fingerprint = await entryFingerprint(root);
  if (fingerprint.type !== 'directory') return { valid: false, fingerprint };
  const layout = await validateCanonicalLayout(root);
  if (!layout.valid) return { valid: false, fingerprint, layout };
  let marker;
  try {
    marker = JSON.parse(await readRegularFileNoFollow(path.join(root, OWNER_MARKER), 'utf8'));
  } catch {
    return { valid: false, fingerprint };
  }
  let actualDigest;
  try {
    actualDigest = await digestTree(path.join(root, 'skills', 'agent-init'));
  } catch {
    return { valid: false, fingerprint };
  }
  return {
    valid: marker.installId === installId && actualDigest === digest,
    fingerprint,
    marker,
    digest: actualDigest,
  };
}

async function validateManagedCopyDirectory(root, manifest, record, digest = record.digest) {
  const fingerprint = await entryFingerprint(root);
  if (fingerprint.type !== 'directory') return { valid: false, fingerprint };
  let marker;
  try {
    marker = JSON.parse(await readRegularFileNoFollow(path.join(root, OWNER_MARKER), 'utf8'));
  } catch {
    return { valid: false, fingerprint };
  }
  let actualDigest;
  try {
    actualDigest = await digestTree(root, { exclude: [OWNER_MARKER] });
  } catch {
    return { valid: false, fingerprint };
  }
  return {
    valid:
      marker.installId === manifest.installId &&
      marker.targetId === record.targetId &&
      actualDigest === digest,
    fingerprint,
    marker,
    digest: actualDigest,
  };
}

async function callBeforeMutation(runtime, name) {
  if (typeof runtime.beforeMutation === 'function') {
    await runtime.beforeMutation(name);
  }
}

async function callAfterMutation(runtime, name) {
  if (typeof runtime.afterMutation === 'function') {
    await runtime.afterMutation(name);
  }
}

async function removeCanonical(
  paths,
  manifest,
  canonical,
  operation,
  afterMutation = undefined,
) {
  if (canonical.status !== 'owned-valid' || !canonical.removable) {
    return {
      action: 'preserved',
      path: paths.canonicalRoot,
      status: canonical.status,
      reason: 'Canonical ownership is not valid.',
    };
  }
  const quarantine = path.join(
    paths.installRoot,
    `.rollback-${operation.operationId}`,
  );
  await recordIntent(operation, {
    action: 'remove-canonical',
    path: paths.canonicalRoot,
    quarantine,
    expectedIdentity: canonical.root.identity,
    digest: manifest.canonical.digest,
    installId: manifest.installId,
  });
  const current = await inspectCanonical(paths, manifest);
  if (
    current.status !== 'owned-valid' ||
    current.root.identity !== canonical.root.identity
  ) {
    return {
      action: 'preserved',
      path: paths.canonicalRoot,
      status: current.status,
      reason: 'Canonical entry changed before removal.',
    };
  }
  if ((await entryFingerprint(quarantine)).type !== 'missing') {
    throw new InstallationError(
      'INSTALL_CONFLICT',
      `Canonical quarantine path already exists: ${quarantine}`,
      { path: quarantine, remediation: 'Preserve and inspect the unexpected entry.' },
    );
  }
  await rename(paths.canonicalRoot, quarantine);
  if (typeof afterMutation === 'function') {
    await afterMutation('uninstall:canonical-detached');
  }
  let detachedValid = false;
  try {
    const detached = await entryFingerprint(quarantine);
    let marker;
    try {
      marker = JSON.parse(
        await readRegularFileNoFollow(path.join(quarantine, OWNER_MARKER), 'utf8'),
      );
    } catch {
      marker = null;
    }
    detachedValid =
      detached.type === 'directory' &&
      detached.identity === canonical.root.identity &&
      marker?.installId === manifest.installId &&
      (await digestTree(path.join(quarantine, 'skills', 'agent-init'))) ===
        manifest.canonical.digest;
    if (!detachedValid) {
      if ((await entryFingerprint(paths.canonicalRoot)).type === 'missing') {
        await rename(quarantine, paths.canonicalRoot);
      }
      return {
        action: 'preserved',
        path: paths.canonicalRoot,
        status: 'ambiguous',
        reason: 'Detached canonical ownership could not be revalidated.',
      };
    }
    await rm(quarantine, { recursive: true });
    if (typeof afterMutation === 'function') {
      await afterMutation('uninstall:canonical-quarantine-removed');
    }
    await recordCompletion(operation, {
      action: 'remove-canonical',
      path: paths.canonicalRoot,
    });
    return { action: 'removed', path: paths.canonicalRoot, status: 'owned-valid' };
  } catch (error) {
    if (!detachedValid && (await entryFingerprint(paths.canonicalRoot)).type === 'missing') {
      await rename(quarantine, paths.canonicalRoot).catch(() => {});
    }
    throw error;
  }
}

async function uninstallOwned(paths, runtime, payload, operation, plannedManifest) {
  const locked = await inspectInitialState(paths, runtime);
  if (
    !locked.manifest ||
    locked.manifest.installId !== plannedManifest.installId ||
    locked.manifest.version !== plannedManifest.version
  ) {
    throw new InstallationError(
      'OWNERSHIP_MISMATCH',
      `Installation changed before uninstall: ${paths.installRoot}`,
      { path: paths.installRoot, remediation: 'Run doctor and inspect the changed installation.' },
    );
  }
  const canonical = await inspectCanonical(paths, locked.manifest);
  if (canonical.status !== 'owned-valid') {
    throw new InstallationError(
      'OWNERSHIP_MISMATCH',
      `Canonical ownership is not valid for uninstall: ${paths.canonicalRoot}`,
      {
        path: paths.canonicalRoot,
        remediation: 'Preserve the installation and resolve canonical drift manually.',
      },
    );
  }
  const rootEntries = (await readdir(paths.installRoot)).sort();
  if (rootEntries.some((name) => !['current', 'install.json'].includes(name))) {
    throw new InstallationError(
      'OWNERSHIP_MISMATCH',
      `Installation root contains unknown top-level assets: ${paths.installRoot}`,
      {
        path: paths.installRoot,
        remediation: 'Preserve unknown files and remove them manually only after review.',
      },
    );
  }

  const rootFingerprint = await entryFingerprint(paths.installRoot);
  await updateOperation(operation, {
    previousManifest: locked.manifest,
    installRootIdentity: rootFingerprint.identity,
  });

  const targetResults = [];
  for (const name of ['codex', 'claude']) {
    const targetResult = await removeOwnedTarget({
      paths,
      name,
      manifest: locked.manifest,
      operation,
      afterMutation: runtime.afterMutation,
    });
    targetResults.push(targetResult);
    if (targetResult.action !== 'removed') {
      await recordCompletion(operation, {
        action: 'preserve-target',
        name,
        path: targetResult.path,
        status: targetResult.status,
      });
    }
    await callAfterMutation(runtime, `uninstall:${name}-processed`);
  }
  const canonicalResult = await removeCanonical(
    paths,
    locked.manifest,
    canonical,
    operation,
    runtime.afterMutation,
  );
  await callAfterMutation(runtime, 'uninstall:canonical-processed');
  if (canonicalResult.action !== 'removed') {
    throw new InstallationError(
      'OWNERSHIP_MISMATCH',
      `Canonical payload was preserved because ownership changed: ${paths.canonicalRoot}`,
      {
        path: paths.canonicalRoot,
        preserved: [paths.canonicalRoot],
        remediation: 'Run doctor and inspect the retained installation.',
      },
    );
  }

  const manifestFingerprint = await entryFingerprint(paths.manifest);
  if (manifestFingerprint.type !== 'file') {
    throw new InstallationError(
      'OWNERSHIP_MISMATCH',
      `Manifest disappeared before uninstall commit: ${paths.manifest}`,
      { path: paths.manifest, remediation: 'Preserve the remaining installation and run doctor.' },
    );
  }
  await recordIntent(operation, {
    action: 'remove-manifest',
    path: paths.manifest,
    expectedIdentity: manifestFingerprint.identity,
  });
  const manifestBeforeRemove = await entryFingerprint(paths.manifest);
  if (
    manifestBeforeRemove.type !== 'file' ||
    manifestBeforeRemove.identity !== manifestFingerprint.identity
  ) {
    throw new InstallationError(
      'OWNERSHIP_MISMATCH',
      `Manifest changed before uninstall commit: ${paths.manifest}`,
      { path: paths.manifest, remediation: 'Preserve the changed manifest and run doctor.' },
    );
  }
  await unlink(paths.manifest);
  await callAfterMutation(runtime, 'uninstall:manifest-unlinked');
  await recordCompletion(operation, { action: 'remove-manifest', path: paths.manifest });
  await callAfterMutation(runtime, 'uninstall:manifest-removed');

  await recordIntent(operation, {
    action: 'remove-install-root',
    path: paths.installRoot,
    expected: 'empty-directory',
  });
  await rmdir(paths.installRoot);
  await callAfterMutation(runtime, 'uninstall:root-rmdir');
  await recordCompletion(operation, {
    action: 'remove-install-root',
    path: paths.installRoot,
  });
  await callAfterMutation(runtime, 'uninstall:root-removed');
  await updateOperation(operation, { phase: 'committed', committed: true });

  return {
    ok: true,
    outcome: 'uninstalled',
    operation: 'uninstall',
    version: runtime.packageVersion,
    paths,
    removed: [
      ...targetResults.filter((item) => item.action === 'removed').map((item) => item.path),
      paths.canonicalRoot,
      paths.manifest,
      paths.installRoot,
    ],
    preserved: targetResults
      .filter((item) => item.action === 'preserved')
      .map((item) => item.path),
    unresolved: [],
    changed: [
      ...targetResults.filter((item) => item.action === 'removed').map((item) => item.path),
      paths.canonicalRoot,
      paths.manifest,
      paths.installRoot,
    ],
  };
}

async function stageUpdateAssets(paths, payload, manifest, operation, runtime) {
  const canonicalStaging = path.join(
    paths.installRoot,
    `.staging-${operation.operationId}`,
  );
  const attempted = [];
  const copyStaging = {};

  async function cleanValidatedStaging() {
    const unresolved = [];
    for (const staged of [...attempted].reverse()) {
      const state = await entryFingerprint(staged.path);
      if (state.type === 'missing') continue;
      if (!staged.identity || state.identity !== staged.identity) {
        unresolved.push(staged.path);
        continue;
      }
      if ((await entryFingerprint(staged.quarantine)).type !== 'missing') {
        unresolved.push(staged.path, staged.quarantine);
        continue;
      }
      const removed = await detachAndDeleteOwnedDirectory({
        livePath: staged.path,
        quarantinePath: staged.quarantine,
        expectedIdentity: staged.identity,
        verifyDetached: staged.verifyDetached,
      });
      if (!removed) unresolved.push(staged.path, staged.quarantine);
    }
    return [...new Set(unresolved)];
  }

  try {
    if ((await entryFingerprint(canonicalStaging)).type !== 'missing') {
      throw new InstallationError(
        'INSTALL_CONFLICT',
        `Canonical staging path already exists: ${canonicalStaging}`,
        { path: canonicalStaging, remediation: 'Preserve and inspect the unexpected staging entry.' },
      );
    }
    const canonicalAttempt = {
      path: canonicalStaging,
      quarantine: path.join(
        paths.installRoot,
        `.staging-cleanup-${operation.operationId}`,
      ),
      identity: null,
      verifyDetached: (detachedPath) =>
        validateCanonicalDirectory(
          detachedPath,
          manifest.installId,
          payload.digest,
        ).then((validation) => validation.valid),
    };
    attempted.push(canonicalAttempt);
    await recordIntent(operation, {
      action: 'stage-canonical-update',
      path: canonicalStaging,
      digest: payload.digest,
    });
    await mkdir(canonicalStaging);
    await mkdir(path.join(canonicalStaging, 'skills'));
    await copyTree(payload.sourceSkill, path.join(canonicalStaging, 'skills', 'agent-init'));
    await writeFile(
      path.join(canonicalStaging, OWNER_MARKER),
      serializeJson({ schemaVersion: 1, installId: manifest.installId }),
      { flag: 'wx', mode: 0o600 },
    );
    const canonicalValidation = await validateCanonicalDirectory(
      canonicalStaging,
      manifest.installId,
      payload.digest,
    );
    if (!canonicalValidation.valid) {
      throw new InstallationError(
        'INTEGRITY_CONFLICT',
        `Staged canonical update failed digest validation: ${canonicalStaging}`,
        { path: canonicalStaging, remediation: 'Use an intact package payload and retry.' },
      );
    }
    canonicalAttempt.identity = canonicalValidation.fingerprint.identity;
    await recordCompletion(operation, {
      action: 'stage-canonical-update',
      path: canonicalStaging,
    });
    await callAfterMutation(runtime, 'update:canonical-staged');

    for (const name of ['codex', 'claude']) {
      const record = manifest.targets[name];
      if (record.mode !== 'copy') continue;
      const staging = path.join(
        path.dirname(record.path),
        `.agent-init-staging-${operation.operationId}-${name}`,
      );
      if ((await entryFingerprint(staging)).type !== 'missing') {
        throw new InstallationError(
          'INSTALL_CONFLICT',
          `Managed-copy staging path already exists: ${staging}`,
          { path: staging, remediation: 'Preserve and inspect the unexpected sibling entry.' },
        );
      }
      const copyAttempt = {
        path: staging,
        quarantine: path.join(
          path.dirname(record.path),
          `.agent-init-staging-cleanup-${operation.operationId}-${name}`,
        ),
        identity: null,
        verifyDetached: (detachedPath) =>
          validateManagedCopyDirectory(
            detachedPath,
            manifest,
            record,
            payload.digest,
          ).then((validation) => validation.valid),
      };
      attempted.push(copyAttempt);
      await recordIntent(operation, {
        action: 'stage-target-update',
        name,
        path: staging,
        digest: payload.digest,
      });
      await copyTree(payload.sourceSkill, staging);
      await writeFile(
        path.join(staging, OWNER_MARKER),
        serializeJson({
          schemaVersion: 1,
          installId: manifest.installId,
          targetId: record.targetId,
        }),
        { flag: 'wx', mode: 0o600 },
      );
      const validation = await validateManagedCopyDirectory(
        staging,
        manifest,
        record,
        payload.digest,
      );
      if (!validation.valid) {
        throw new InstallationError(
          'INTEGRITY_CONFLICT',
          `Staged managed copy failed digest validation: ${staging}`,
          { path: staging, remediation: 'Use an intact package payload and retry.' },
        );
      }
      copyAttempt.identity = validation.fingerprint.identity;
      copyStaging[name] = staging;
      await recordCompletion(operation, {
        action: 'stage-target-update',
        name,
        path: staging,
      });
    }
    return { canonicalStaging, copyStaging };
  } catch (error) {
    const unresolved = await cleanValidatedStaging();
    if (unresolved.length > 0) {
      throw new InstallationError(
        'ROLLBACK_FAILED',
        `Update staging failed and not every staging entry could be removed safely: ${paths.installRoot}`,
        {
          path: paths.installRoot,
          cause: error,
          unresolved,
          remediation: 'Run doctor and inspect operation-bound staging before any manual change.',
        },
      );
    }
    throw error;
  }
}

async function restoreDirectorySwap(swap, validateOld, validateNew) {
  const unresolved = [];
  if (!swap.detached) return unresolved;
  if (!swap.promoted) {
    const old = await validateOld(swap.rollback);
    const destination = await entryFingerprint(swap.live);
    if (old.valid && destination.type === 'missing') {
      await rename(swap.rollback, swap.live);
    } else {
      unresolved.push(swap.live);
    }
    return unresolved;
  }

  const failedNew = `${swap.staging}.failed`;
  if ((await entryFingerprint(failedNew)).type !== 'missing') {
    unresolved.push(failedNew);
    return unresolved;
  }
  const liveNew = await validateNew(swap.live);
  const old = await validateOld(swap.rollback);
  if (!liveNew.valid || !old.valid) {
    unresolved.push(swap.live, swap.rollback);
    return unresolved;
  }
  await rename(swap.live, failedNew);
  const detachedNew = await validateNew(failedNew);
  if (!detachedNew.valid || (await entryFingerprint(swap.live)).type !== 'missing') {
    if ((await entryFingerprint(swap.live)).type === 'missing') {
      await rename(failedNew, swap.live).catch(() => {});
    }
    unresolved.push(swap.live, swap.rollback);
    return unresolved;
  }
  await rename(swap.rollback, swap.live);
  await rm(failedNew, { recursive: true });
  return unresolved;
}

async function upgradeOwned(paths, runtime, payload, operation, plannedManifest) {
  const locked = await inspectInitialState(paths, runtime);
  if (
    !locked.manifest ||
    locked.manifest.installId !== plannedManifest.installId ||
    locked.manifest.version !== plannedManifest.version ||
    locked.manifest.canonical.digest !== plannedManifest.canonical.digest
  ) {
    throw new InstallationError(
      'OWNERSHIP_MISMATCH',
      `Installation changed before update: ${paths.installRoot}`,
      { path: paths.installRoot, remediation: 'Run doctor and inspect the changed installation.' },
    );
  }
  const oldCanonical = await inspectCanonical(paths, locked.manifest);
  if (
    oldCanonical.status !== 'owned-valid' ||
    Object.values(locked.targets).some((target) => target.status !== 'owned-valid')
  ) {
    throw new InstallationError(
      'OWNERSHIP_MISMATCH',
      `Update requires a fully owned installation: ${paths.installRoot}`,
      { path: paths.installRoot, remediation: 'Resolve missing or drifted assets before upgrading.' },
    );
  }

  const manifestFingerprint = await entryFingerprint(paths.manifest);
  await updateOperation(operation, {
    previousManifest: locked.manifest,
    proposedVersion: runtime.packageVersion,
    oldDigest: locked.manifest.canonical.digest,
    newDigest: payload.digest,
  });
  const staged = await stageUpdateAssets(
    paths,
    payload,
    locked.manifest,
    operation,
    runtime,
  );
  const canonicalSwap = {
    live: paths.canonicalRoot,
    staging: staged.canonicalStaging,
    rollback: path.join(paths.installRoot, `.rollback-${operation.operationId}`),
    detached: false,
    promoted: false,
  };
  const copySwaps = {};
  let manifestSwap = null;
  let committed = false;

  try {
    await recordIntent(operation, {
      action: 'swap-canonical-update',
      path: canonicalSwap.live,
      staging: canonicalSwap.staging,
      rollback: canonicalSwap.rollback,
      oldIdentity: oldCanonical.root.identity,
      oldDigest: locked.manifest.canonical.digest,
      newDigest: payload.digest,
    });
    const currentCanonical = await inspectCanonical(paths, locked.manifest);
    if (
      currentCanonical.status !== 'owned-valid' ||
      currentCanonical.root.identity !== oldCanonical.root.identity ||
      (await entryFingerprint(canonicalSwap.rollback)).type !== 'missing'
    ) {
      throw new InstallationError(
        'OWNERSHIP_MISMATCH',
        `Canonical payload changed before update swap: ${paths.canonicalRoot}`,
        { path: paths.canonicalRoot, remediation: 'Preserve the changed payload and run doctor.' },
      );
    }
    await rename(canonicalSwap.live, canonicalSwap.rollback);
    canonicalSwap.detached = true;
    await callAfterMutation(runtime, 'update:canonical-detached');
    const detachedOld = await validateCanonicalDirectory(
      canonicalSwap.rollback,
      locked.manifest.installId,
      locked.manifest.canonical.digest,
    );
    if (!detachedOld.valid) {
      throw new InstallationError(
        'OWNERSHIP_MISMATCH',
        `Detached canonical payload failed ownership validation: ${canonicalSwap.rollback}`,
        { path: canonicalSwap.rollback, remediation: 'Preserve rollback evidence and run doctor.' },
      );
    }
    if ((await entryFingerprint(canonicalSwap.live)).type !== 'missing') {
      throw new InstallationError(
        'INSTALL_CONFLICT',
        `Canonical path appeared during update: ${canonicalSwap.live}`,
        { path: canonicalSwap.live, remediation: 'Preserve the concurrent entry and run doctor.' },
      );
    }
    await rename(canonicalSwap.staging, canonicalSwap.live);
    canonicalSwap.promoted = true;
    await callAfterMutation(runtime, 'update:canonical-promoted');
    const promotedCanonical = await validateCanonicalDirectory(
      canonicalSwap.live,
      locked.manifest.installId,
      payload.digest,
    );
    if (!promotedCanonical.valid) {
      throw new InstallationError(
        'INTEGRITY_CONFLICT',
        `Promoted canonical payload failed validation: ${canonicalSwap.live}`,
        { path: canonicalSwap.live, remediation: 'Preserve operation evidence and run doctor.' },
      );
    }
    await recordCompletion(operation, {
      action: 'swap-canonical-update',
      path: canonicalSwap.live,
    });

    for (const name of ['codex', 'claude']) {
      const record = locked.manifest.targets[name];
      if (record.mode !== 'copy') continue;
      const initialTarget = locked.targets[name];
      const swap = {
        live: record.path,
        staging: staged.copyStaging[name],
        rollback: path.join(
          path.dirname(record.path),
          `.agent-init-rollback-${operation.operationId}-${name}`,
        ),
        detached: false,
        promoted: false,
      };
      copySwaps[name] = swap;
      await recordIntent(operation, {
        action: 'swap-target-update',
        name,
        path: swap.live,
        staging: swap.staging,
        rollback: swap.rollback,
        oldIdentity: initialTarget.fingerprint.identity,
        oldDigest: record.digest,
        newDigest: payload.digest,
      });
      const currentTarget = await inspectTarget(
        paths,
        name,
        record,
        locked.manifest,
      );
      if (
        currentTarget.status !== 'owned-valid' ||
        currentTarget.fingerprint.identity !== initialTarget.fingerprint.identity ||
        (await entryFingerprint(swap.rollback)).type !== 'missing'
      ) {
        throw new InstallationError(
          'OWNERSHIP_MISMATCH',
          `Managed copy changed before update swap: ${swap.live}`,
          { path: swap.live, remediation: 'Preserve the changed target and run doctor.' },
        );
      }
      await rename(swap.live, swap.rollback);
      swap.detached = true;
      await callAfterMutation(runtime, `update:${name}-detached`);
      const detachedOldCopy = await validateManagedCopyDirectory(
        swap.rollback,
        locked.manifest,
        record,
      );
      if (!detachedOldCopy.valid || (await entryFingerprint(swap.live)).type !== 'missing') {
        throw new InstallationError(
          'OWNERSHIP_MISMATCH',
          `Detached managed copy failed validation: ${swap.rollback}`,
          { path: swap.rollback, remediation: 'Preserve operation evidence and run doctor.' },
        );
      }
      await rename(swap.staging, swap.live);
      swap.promoted = true;
      await callAfterMutation(runtime, `update:${name}-promoted`);
      const promotedCopy = await validateManagedCopyDirectory(
        swap.live,
        locked.manifest,
        record,
        payload.digest,
      );
      if (!promotedCopy.valid) {
        throw new InstallationError(
          'INTEGRITY_CONFLICT',
          `Promoted managed copy failed validation: ${swap.live}`,
          { path: swap.live, remediation: 'Preserve operation evidence and run doctor.' },
        );
      }
      await recordCompletion(operation, {
        action: 'swap-target-update',
        name,
        path: swap.live,
      });
    }

    const nextManifest = structuredClone(locked.manifest);
    nextManifest.version = runtime.packageVersion;
    nextManifest.updatedAt = isoNow(runtime);
    nextManifest.canonical.digest = payload.digest;
    for (const name of ['codex', 'claude']) {
      if (nextManifest.targets[name].mode === 'copy') {
        nextManifest.targets[name].digest = payload.digest;
      }
    }
    await recordIntent(operation, {
      action: 'replace-manifest-update',
      path: paths.manifest,
      expectedIdentity: manifestFingerprint.identity,
      oldVersion: locked.manifest.version,
      newVersion: runtime.packageVersion,
    });
    const manifestBeforeWrite = await entryFingerprint(paths.manifest);
    if (
      manifestBeforeWrite.type !== 'file' ||
      manifestBeforeWrite.identity !== manifestFingerprint.identity
    ) {
      throw new InstallationError(
        'OWNERSHIP_MISMATCH',
        `Manifest changed before update commit: ${paths.manifest}`,
        { path: paths.manifest, remediation: 'Preserve the changed manifest and run doctor.' },
      );
    }
    manifestSwap = await replaceJsonCas(
      paths.manifest,
      nextManifest,
      `${operation.operationId}-manifest-update`,
      manifestFingerprint.identity,
      {
        keepRollback: true,
        rollbackPath: path.join(
          paths.installRoot,
          `.install.json.rollback-${operation.operationId}`,
        ),
        beforeDetach: () => callBeforeMutation(runtime, 'manifest:update-before-detach'),
      },
    );
    await callAfterMutation(runtime, 'update:manifest-written');
    await recordCompletion(operation, {
      action: 'replace-manifest-update',
      path: paths.manifest,
    });

    const verifiedManifest = await readManifest(paths.manifest, {
      packageName: runtime.packageName,
      paths,
    });
    const verifiedCanonical = await inspectCanonical(paths, verifiedManifest);
    const verifiedTargets = {};
    for (const name of ['codex', 'claude']) {
      verifiedTargets[name] = await inspectTarget(
        paths,
        name,
        verifiedManifest.targets[name],
        verifiedManifest,
      );
    }
    if (
      verifiedManifest.version !== runtime.packageVersion ||
      verifiedCanonical.status !== 'owned-valid' ||
      Object.values(verifiedTargets).some((target) => target.status !== 'owned-valid')
    ) {
      throw new InstallationError(
        'PARTIAL_INSTALLATION',
        `Updated installation failed final validation: ${paths.installRoot}`,
        { path: paths.installRoot, remediation: 'Preserve operation evidence and run doctor.' },
      );
    }

    await updateOperation(operation, {
      phase: 'committed',
      committed: true,
      manifestVersion: runtime.packageVersion,
    });
    committed = true;
    await callAfterMutation(runtime, 'update:journal-committed');
    if (
      manifestSwap?.rollbackPath &&
      !(await removeRegularIfIdentity(
        manifestSwap.rollbackPath,
        manifestSwap.rollbackIdentity,
      ))
    ) {
      throw new InstallationError(
        'AMBIGUOUS_OPERATION',
        `Manifest rollback identity changed before cleanup: ${manifestSwap.rollbackPath}`,
        { path: manifestSwap.rollbackPath, remediation: 'Preserve the rollback file for manual review.' },
      );
    }
    for (const swap of Object.values(copySwaps)) {
      const old = await validateManagedCopyDirectory(
        swap.rollback,
        locked.manifest,
        locked.manifest.targets[
          Object.keys(copySwaps).find((name) => copySwaps[name] === swap)
        ],
      );
      if (old.valid) await rm(swap.rollback, { recursive: true });
    }
    const oldCanonicalValidation = await validateCanonicalDirectory(
      canonicalSwap.rollback,
      locked.manifest.installId,
      locked.manifest.canonical.digest,
    );
    if (oldCanonicalValidation.valid) {
      await rm(canonicalSwap.rollback, { recursive: true });
    }
    return {
      ok: true,
      outcome: 'updated',
      operation: 'update',
      version: runtime.packageVersion,
      previousVersion: locked.manifest.version,
      paths,
      manifest: verifiedManifest,
      targets: verifiedTargets,
      changed: [
        paths.canonicalRoot,
        ...Object.values(copySwaps).map((swap) => swap.live),
        paths.manifest,
      ],
      preserved: [],
      unresolved: [],
    };
  } catch (error) {
    if (committed) {
      const changed = [
        paths.canonicalRoot,
        ...Object.values(copySwaps).map((swap) => swap.live),
        paths.manifest,
      ];
      const unresolvedCandidates = [
        operation.lockPath,
        operation.descriptorPath,
        ...operation.journalSnapshots.map((snapshot) => snapshot.path),
        manifestSwap?.rollbackPath,
        canonicalSwap.rollback,
        ...Object.values(copySwaps).map((swap) => swap.rollback),
      ].filter(Boolean);
      const unresolved = [];
      for (const candidate of unresolvedCandidates) {
        if ((await entryFingerprint(candidate)).type !== 'missing') {
          unresolved.push(candidate);
        }
      }
      throw new InstallationError(
        'RECOVERABLE_OPERATION',
        `Update committed, but cleanup did not finish: ${paths.installRoot}`,
        {
          path: operation.journalPath,
          cause: error,
          changed,
          unresolved: [...new Set(unresolved)],
          remediation: 'Run doctor for a read-only report, then retry update to complete cleanup.',
        },
      );
    }
    const unresolved = [];
    const expectedManifestRollback = path.join(
      paths.installRoot,
      `.install.json.rollback-${operation.operationId}`,
    );
    if (!manifestSwap) {
      const rollbackState = await entryFingerprint(expectedManifestRollback);
      if (rollbackState.type !== 'missing') {
        unresolved.push(paths.manifest, expectedManifestRollback);
      }
    }
    if (manifestSwap?.rollbackPath) {
      const restored = await restoreJsonRollback(
        paths.manifest,
        manifestSwap.identity,
        manifestSwap.rollbackPath,
        manifestSwap.rollbackIdentity,
      ).catch(() => false);
      if (!restored) {
        unresolved.push(paths.manifest, manifestSwap.rollbackPath);
      }
    }
    for (const [name, swap] of Object.entries(copySwaps).reverse()) {
      unresolved.push(
        ...(await restoreDirectorySwap(
          swap,
          (root) =>
            validateManagedCopyDirectory(
              root,
              locked.manifest,
              locked.manifest.targets[name],
            ),
          (root) =>
            validateManagedCopyDirectory(
              root,
              locked.manifest,
              locked.manifest.targets[name],
              payload.digest,
            ),
        )),
      );
    }
    unresolved.push(
      ...(await restoreDirectorySwap(
        canonicalSwap,
        (root) =>
          validateCanonicalDirectory(
            root,
            locked.manifest.installId,
            locked.manifest.canonical.digest,
          ),
        (root) =>
          validateCanonicalDirectory(
            root,
            locked.manifest.installId,
            payload.digest,
          ),
      )),
    );
    await rm(staged.canonicalStaging, { recursive: true, force: true }).catch(() => {});
    for (const staging of Object.values(staged.copyStaging)) {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
    }
    if (unresolved.length > 0) {
      throw new InstallationError(
        'ROLLBACK_FAILED',
        `Update failed and rollback could not prove every asset: ${paths.installRoot}`,
        {
          path: paths.installRoot,
          cause: error,
          unresolved: [...new Set(unresolved)],
          remediation: 'Run doctor and inspect the retained operation journal before changing files.',
        },
      );
    }
    await updateOperation(operation, {
      phase: 'rolled-back',
      committed: false,
      failureCode: error?.code ?? 'UNEXPECTED_ERROR',
    });
    throw error;
  }
}

function findLastIntent(journal, action, name = undefined) {
  return [...(journal.intents ?? [])]
    .reverse()
    .find((intent) => intent.action === action && (name === undefined || intent.name === name));
}

function findLastCompletion(journal, action, name = undefined) {
  return [...(journal.completed ?? [])]
    .reverse()
    .find((completion) =>
      completion.action === action && (name === undefined || completion.name === name),
    );
}

function ambiguousRecovery(message, journalPath, assetPath = journalPath) {
  return new InstallationError('AMBIGUOUS_OPERATION', message, {
    path: assetPath,
    remediation: `Preserve all assets and inspect the lifecycle journal: ${journalPath}`,
  });
}

function singleJournalRecord(records, action, name, journalPath) {
  const matches = records.filter(
    (record) => record.action === action && (name === undefined || record.name === name),
  );
  if (matches.length > 1) {
    throw ambiguousRecovery(
      `Lifecycle journal contains duplicate ${action} evidence.`,
      journalPath,
    );
  }
  return matches[0] ?? null;
}

function validateFreshInstallJournal(paths, descriptor, journal) {
  const journalPath = descriptor.journalPath;
  if (!Array.isArray(journal.intents) || !Array.isArray(journal.completed)) {
    throw ambiguousRecovery('Fresh-install journal records are not arrays.', journalPath);
  }
  const allowedActions = new Set([
    'create-install-root',
    'create-canonical',
    'create-target-link',
    'create-target-copy',
    'write-manifest',
  ]);
  if (
    [...journal.intents, ...journal.completed].some(
      (record) => !record || !allowedActions.has(record.action),
    )
  ) {
    throw ambiguousRecovery('Fresh-install journal contains an unexpected action.', journalPath);
  }

  const rootIntent = singleJournalRecord(
    journal.intents,
    'create-install-root',
    undefined,
    journalPath,
  );
  const rootCompletion = singleJournalRecord(
    journal.completed,
    'create-install-root',
    undefined,
    journalPath,
  );
  if (
    (rootCompletion && !rootIntent) ||
    (rootIntent &&
      (rootIntent.path !== paths.installRoot || rootIntent.expected !== 'missing')) ||
    (rootCompletion &&
      (rootCompletion.path !== paths.installRoot ||
        typeof rootCompletion.entryIdentity !== 'string'))
  ) {
    throw ambiguousRecovery('Fresh-install root evidence is not operation-bound.', journalPath);
  }

  const canonicalIntent = singleJournalRecord(
    journal.intents,
    'create-canonical',
    undefined,
    journalPath,
  );
  const canonicalCompletion = singleJournalRecord(
    journal.completed,
    'create-canonical',
    undefined,
    journalPath,
  );
  if (
    canonicalCompletion &&
    (!canonicalIntent ||
      canonicalCompletion.path !== paths.canonicalRoot ||
      typeof canonicalCompletion.entryIdentity !== 'string')
  ) {
    throw ambiguousRecovery('Fresh-install canonical completion is invalid.', journalPath);
  }
  if ((canonicalIntent || canonicalCompletion) && !rootCompletion) {
    throw ambiguousRecovery('Fresh-install canonical evidence precedes root creation.', journalPath);
  }
  if (
    canonicalIntent &&
    (canonicalIntent.path !== paths.canonicalRoot ||
      canonicalIntent.staging !==
        path.join(paths.installRoot, `.staging-${journal.operationId}`) ||
      canonicalIntent.expected !== 'missing' ||
      !/^[a-f0-9]{32}$/.test(canonicalIntent.installId) ||
      !/^sha256:[a-f0-9]{64}$/.test(canonicalIntent.digest))
  ) {
    throw ambiguousRecovery('Fresh-install canonical evidence is not operation-bound.', journalPath);
  }

  const targets = {};
  for (const name of ['codex', 'claude']) {
    const linkIntent = singleJournalRecord(
      journal.intents,
      'create-target-link',
      name,
      journalPath,
    );
    const copyIntent = singleJournalRecord(
      journal.intents,
      'create-target-copy',
      name,
      journalPath,
    );
    const linkCompletion = singleJournalRecord(
      journal.completed,
      'create-target-link',
      name,
      journalPath,
    );
    const copyCompletion = singleJournalRecord(
      journal.completed,
      'create-target-copy',
      name,
      journalPath,
    );
    if (
      (linkCompletion && !linkIntent) ||
      (copyCompletion && !copyIntent) ||
      (linkCompletion && copyIntent) ||
      (linkCompletion && copyCompletion)
    ) {
      throw ambiguousRecovery(
        `Fresh-install ${name} target completion is invalid.`,
        journalPath,
      );
    }
    const intent = copyIntent ?? linkIntent;
    const completion = copyIntent ? copyCompletion : linkCompletion;
    if (
      completion &&
      (typeof completion.entryIdentity !== 'string' ||
        (linkCompletion &&
          completion.linkText !== undefined &&
          typeof completion.linkText !== 'string'))
    ) {
      throw ambiguousRecovery(
        `Fresh-install ${name} target completion has invalid identity evidence.`,
        journalPath,
      );
    }
    if (!intent) {
      targets[name] = null;
      continue;
    }
    if (!canonicalCompletion) {
      throw ambiguousRecovery(
        `Fresh-install ${name} target evidence precedes canonical publication.`,
        journalPath,
      );
    }
    const expectedLinkText =
      path.relative(path.dirname(paths.targets[name]), paths.canonicalSkill) || '.';
    const expectedStaging = path.join(
      path.dirname(paths.targets[name]),
      `.agent-init-staging-${journal.operationId}-${name}`,
    );
    if (
      (linkIntent &&
        (linkIntent.path !== paths.targets[name] ||
          linkIntent.expected !== 'missing' ||
          linkIntent.linkText !== expectedLinkText ||
          !/^[a-f0-9]{32}$/.test(linkIntent.targetId))) ||
      (copyIntent &&
        (copyIntent.path !== paths.targets[name] ||
          copyIntent.expected !== 'missing' ||
          copyIntent.staging !== expectedStaging ||
          copyIntent.installId !== canonicalIntent?.installId ||
          (linkIntent != null && copyIntent.targetId !== linkIntent.targetId) ||
          !/^[a-f0-9]{32}$/.test(copyIntent.targetId) ||
          copyIntent.digest !== canonicalIntent?.digest)) ||
      (completion && completion.path !== paths.targets[name])
    ) {
      throw ambiguousRecovery(
        `Fresh-install ${name} target evidence is not operation-bound.`,
        journalPath,
      );
    }
    targets[name] = {
      mode: copyIntent ? 'copy' : 'symlink',
      intent,
      completion,
      linkIntent,
      copyIntent,
    };
  }

  const manifestIntent = singleJournalRecord(
    journal.intents,
    'write-manifest',
    undefined,
    journalPath,
  );
  const manifestCompletion = singleJournalRecord(
    journal.completed,
    'write-manifest',
    undefined,
    journalPath,
  );
  if (
    manifestCompletion &&
    (!manifestIntent ||
      manifestCompletion.path !== paths.manifest ||
      typeof manifestCompletion.entryIdentity !== 'string')
  ) {
    throw ambiguousRecovery('Fresh-install manifest completion is invalid.', journalPath);
  }
  if (
    (manifestIntent || manifestCompletion) &&
    (!canonicalCompletion ||
      Object.values(targets).some((target) => !target?.completion))
  ) {
    throw ambiguousRecovery(
      'Fresh-install manifest evidence precedes asset publication.',
      journalPath,
    );
  }
  if (
    manifestIntent &&
    (manifestIntent.path !== paths.manifest ||
      manifestIntent.expected !== 'missing' ||
      typeof manifestIntent.version !== 'string' ||
      manifestIntent.version.length === 0)
  ) {
    throw ambiguousRecovery('Fresh-install manifest evidence is not operation-bound.', journalPath);
  }

  return {
    root: { intent: rootIntent, completion: rootCompletion },
    canonical: { intent: canonicalIntent, completion: canonicalCompletion },
    targets,
    manifest: { intent: manifestIntent, completion: manifestCompletion },
  };
}

function freshManifestMatchesEvidence(manifest, evidence, paths) {
  if (
    !manifest ||
    !evidence.canonical.intent ||
    !evidence.manifest.intent ||
    manifest.version !== evidence.manifest.intent.version ||
    manifest.installId !== evidence.canonical.intent.installId ||
    manifest.canonical.digest !== evidence.canonical.intent.digest ||
    manifest.canonical.root !== paths.canonicalRoot ||
    manifest.canonical.skillPath !== paths.canonicalSkill
  ) {
    return false;
  }
  for (const name of ['codex', 'claude']) {
    const targetEvidence = evidence.targets[name];
    const record = manifest.targets[name];
    if (
      !targetEvidence?.completion ||
      record.mode !== targetEvidence.mode ||
      record.path !== paths.targets[name] ||
      record.source !== paths.canonicalSkill ||
      record.targetId !== targetEvidence.intent.targetId
    ) {
      return false;
    }
    if (
      targetEvidence.mode === 'symlink'
        ? record.entryIdentity !== targetEvidence.completion.entryIdentity ||
          (targetEvidence.completion.linkText !== undefined &&
            record.linkText !== targetEvidence.completion.linkText) ||
          record.digest !== null
        : record.entryIdentity !== null ||
          record.digest !== targetEvidence.intent.digest
    ) {
      return false;
    }
  }
  return true;
}

async function recoverInterruptedInstall(paths, runtime, control) {
  const details = control.error.details;
  const descriptor = details?.descriptor;
  const journal = details?.journal;
  if (
    control.status !== 'recoverable' ||
    descriptor?.operation !== 'install' ||
    journal?.operation !== 'install' ||
    journal.operationId !== descriptor.operationId
  ) {
    throw ambiguousRecovery(
      'Interrupted lifecycle operation lacks safe fresh-install recovery evidence.',
      details?.path ?? paths.lock,
    );
  }
  const evidence = validateFreshInstallJournal(paths, descriptor, journal);
  const stagingPath = path.join(paths.installRoot, `.staging-${journal.operationId}`);
  const stagingState = await entryFingerprint(stagingPath);
  const installRootState = await entryFingerprint(paths.installRoot);
  const canonicalState = await entryFingerprint(paths.canonicalRoot);
  const manifestState = await entryFingerprint(paths.manifest);
  const targetStates = {};
  const targetPlans = {};

  if (journal.committed === true) {
    const manifest = await readManifest(paths.manifest, {
      packageName: runtime.packageName,
      paths,
    });
    if (
      !evidence.manifest.completion ||
      !freshManifestMatchesEvidence(manifest, evidence, paths)
    ) {
      throw ambiguousRecovery(
        'Committed fresh install does not match its manifest evidence.',
        descriptor.journalPath,
        paths.manifest,
      );
    }
    const canonical = await inspectCanonical(paths, manifest);
    if (canonical.status !== 'owned-valid') {
      throw ambiguousRecovery(
        'Committed fresh-install canonical payload is not valid.',
        descriptor.journalPath,
        paths.canonicalRoot,
      );
    }
    for (const name of ['codex', 'claude']) {
      const target = await inspectTarget(paths, name, manifest.targets[name], manifest);
      if (target.status !== 'owned-valid') {
        throw ambiguousRecovery(
          `Committed fresh-install ${name} target is not valid.`,
          descriptor.journalPath,
          paths.targets[name],
        );
      }
    }
    if (stagingState.type !== 'missing') {
      throw ambiguousRecovery(
        'Committed fresh install retains unexpected canonical staging.',
        descriptor.journalPath,
        stagingPath,
      );
    }
    await removeRecoveredOperation(control);
    return;
  }

  if (evidence.root.completion) {
    if (
      installRootState.type !== 'directory' ||
      installRootState.identity !== evidence.root.completion.entryIdentity
    ) {
      throw ambiguousRecovery(
        'Interrupted fresh-install root identity changed.',
        descriptor.journalPath,
        paths.installRoot,
      );
    }
    const allowedRootEntries = new Set();
    if (canonicalState.type !== 'missing') allowedRootEntries.add('current');
    if (manifestState.type !== 'missing') allowedRootEntries.add('install.json');
    if (stagingState.type !== 'missing') allowedRootEntries.add(path.basename(stagingPath));
    const rootEntries = await readdir(paths.installRoot);
    if (rootEntries.some((name) => !allowedRootEntries.has(name))) {
      throw ambiguousRecovery(
        'Interrupted fresh-install root contains unknown entries.',
        descriptor.journalPath,
        paths.installRoot,
      );
    }
  } else if (installRootState.type !== 'missing') {
    throw ambiguousRecovery(
      'Fresh-install root exists without completion evidence.',
      descriptor.journalPath,
      paths.installRoot,
    );
  }

  if (evidence.canonical.completion) {
    const canonical = await validateCanonicalDirectory(
      paths.canonicalRoot,
      evidence.canonical.intent.installId,
      evidence.canonical.intent.digest,
    );
    if (
      !canonical.valid ||
      canonical.fingerprint.identity !== evidence.canonical.completion.entryIdentity
    ) {
      throw ambiguousRecovery(
        'Interrupted fresh-install canonical payload changed.',
        descriptor.journalPath,
        paths.canonicalRoot,
      );
    }
  } else if (canonicalState.type !== 'missing') {
    throw ambiguousRecovery(
      'Fresh-install canonical payload exists without completion evidence.',
      descriptor.journalPath,
      paths.canonicalRoot,
    );
  }

  if (stagingState.type !== 'missing') {
    if (!evidence.canonical.intent || stagingState.type !== 'directory') {
      throw ambiguousRecovery(
        'Fresh-install staging lacks operation-bound evidence.',
        descriptor.journalPath,
        stagingPath,
      );
    }
    const staging = await validateCanonicalDirectory(
      stagingPath,
      evidence.canonical.intent.installId,
      evidence.canonical.intent.digest,
    );
    if (!staging.valid) {
      throw ambiguousRecovery(
        'Fresh-install staging ownership cannot be validated.',
        descriptor.journalPath,
        stagingPath,
      );
    }
  }

  for (const name of ['codex', 'claude']) {
    const targetEvidence = evidence.targets[name];
    const targetState = await entryFingerprint(paths.targets[name]);
    targetStates[name] = targetState;
    const staging = path.join(
      path.dirname(paths.targets[name]),
      `.agent-init-staging-${journal.operationId}-${name}`,
    );
    const stagingFingerprint = await entryFingerprint(staging);
    if (targetEvidence?.completion) {
      if (targetState.identity !== targetEvidence.completion.entryIdentity) {
        throw ambiguousRecovery(
          `Interrupted fresh-install ${name} target changed.`,
          descriptor.journalPath,
          paths.targets[name],
        );
      }
      if (targetEvidence.mode === 'symlink') {
        const completionLinkText = targetEvidence.completion.linkText;
        if (
          targetState.type !== 'symlink' ||
          (completionLinkText !== undefined &&
            targetState.linkText !== completionLinkText) ||
          !(await linkResolvesToCanonical(
            paths,
            paths.targets[name],
            targetState.linkText,
          ))
        ) {
          throw ambiguousRecovery(
            `Interrupted fresh-install ${name} target changed.`,
            descriptor.journalPath,
            paths.targets[name],
          );
        }
      }
      if (targetEvidence.mode === 'copy') {
        const copy = await validateManagedCopyDirectory(
          paths.targets[name],
          { installId: targetEvidence.intent.installId },
          {
            targetId: targetEvidence.intent.targetId,
            digest: targetEvidence.intent.digest,
          },
        );
        if (!copy.valid) {
          throw ambiguousRecovery(
            `Interrupted fresh-install ${name} managed copy changed.`,
            descriptor.journalPath,
            paths.targets[name],
          );
        }
      }
    } else if (targetState.type !== 'missing') {
      throw ambiguousRecovery(
        `Fresh-install ${name} target exists without completion evidence.`,
        descriptor.journalPath,
        paths.targets[name],
      );
    }
    if (stagingFingerprint.type !== 'missing') {
      if (
        targetEvidence?.mode !== 'copy' ||
        stagingFingerprint.type !== 'directory'
      ) {
        throw ambiguousRecovery(
          `Fresh-install ${name} staging lacks operation-bound evidence.`,
          descriptor.journalPath,
          staging,
        );
      }
      const stagedCopy = await validateManagedCopyDirectory(
        staging,
        { installId: targetEvidence.intent.installId },
        {
          targetId: targetEvidence.intent.targetId,
          digest: targetEvidence.intent.digest,
        },
      );
      if (!stagedCopy.valid) {
        throw ambiguousRecovery(
          `Fresh-install ${name} staging ownership cannot be validated.`,
          descriptor.journalPath,
          staging,
        );
      }
    }
    targetPlans[name] = { evidence: targetEvidence, staging, stagingFingerprint };
  }

  if (evidence.manifest.completion) {
    if (
      manifestState.type !== 'file' ||
      manifestState.identity !== evidence.manifest.completion.entryIdentity
    ) {
      throw ambiguousRecovery(
        'Interrupted fresh-install manifest identity changed.',
        descriptor.journalPath,
        paths.manifest,
      );
    }
    const manifest = await readManifest(paths.manifest, {
      packageName: runtime.packageName,
      paths,
    });
    if (!freshManifestMatchesEvidence(manifest, evidence, paths)) {
      throw ambiguousRecovery(
        'Interrupted fresh-install manifest contents changed.',
        descriptor.journalPath,
        paths.manifest,
      );
    }
  } else if (manifestState.type !== 'missing') {
    throw ambiguousRecovery(
      'Fresh-install manifest exists without completion evidence.',
      descriptor.journalPath,
      paths.manifest,
    );
  }

  if (evidence.manifest.completion) {
    if (
      !(await removeRegularIfIdentity(
        paths.manifest,
        evidence.manifest.completion.entryIdentity,
      ))
    ) {
      throw ambiguousRecovery(
        'Interrupted fresh-install manifest changed before cleanup.',
        descriptor.journalPath,
        paths.manifest,
      );
    }
  }
  for (const name of ['claude', 'codex']) {
    const plan = targetPlans[name];
    if (plan.evidence?.completion) {
      if (plan.evidence.mode === 'symlink') {
        if (
          !(await removeIfSameSymlink(
            paths.targets[name],
            plan.evidence.completion.entryIdentity,
          ))
        ) {
          throw ambiguousRecovery(
            `Interrupted fresh-install ${name} symlink changed before cleanup.`,
            descriptor.journalPath,
            paths.targets[name],
          );
        }
      } else {
        const quarantine = path.join(
          path.dirname(paths.targets[name]),
          `.agent-init-rollback-${journal.operationId}-${name}`,
        );
        if ((await entryFingerprint(quarantine)).type !== 'missing') {
          throw ambiguousRecovery(
            `Interrupted fresh-install ${name} quarantine already exists.`,
            descriptor.journalPath,
            quarantine,
          );
        }
        const removed = await detachAndDeleteOwnedDirectory({
          livePath: paths.targets[name],
          quarantinePath: quarantine,
          expectedIdentity: plan.evidence.completion.entryIdentity,
          verifyDetached: async (detachedPath) => {
            const copy = await validateManagedCopyDirectory(
              detachedPath,
              { installId: plan.evidence.intent.installId },
              {
                targetId: plan.evidence.intent.targetId,
                digest: plan.evidence.intent.digest,
              },
            );
            return copy.valid;
          },
        });
        if (!removed) {
          throw ambiguousRecovery(
            `Interrupted fresh-install ${name} managed copy changed before cleanup.`,
            descriptor.journalPath,
            paths.targets[name],
          );
        }
      }
    }
    if (plan.stagingFingerprint.type !== 'missing') {
      const quarantine = path.join(
        path.dirname(plan.staging),
        `.agent-init-staging-cleanup-${journal.operationId}-${name}`,
      );
      if ((await entryFingerprint(quarantine)).type !== 'missing') {
        throw ambiguousRecovery(
          `Interrupted fresh-install ${name} staging quarantine already exists.`,
          descriptor.journalPath,
          quarantine,
        );
      }
      const removed = await detachAndDeleteOwnedDirectory({
        livePath: plan.staging,
        quarantinePath: quarantine,
        expectedIdentity: plan.stagingFingerprint.identity,
        verifyDetached: async (detachedPath) => {
          const copy = await validateManagedCopyDirectory(
            detachedPath,
            { installId: plan.evidence.intent.installId },
            {
              targetId: plan.evidence.intent.targetId,
              digest: plan.evidence.intent.digest,
            },
          );
          return copy.valid;
        },
      });
      if (!removed) {
        throw ambiguousRecovery(
          `Interrupted fresh-install ${name} staging changed before cleanup.`,
          descriptor.journalPath,
          plan.staging,
        );
      }
    }
  }
  if (evidence.canonical.completion) {
    const quarantine = path.join(paths.installRoot, `.rollback-${journal.operationId}`);
    if ((await entryFingerprint(quarantine)).type !== 'missing') {
      throw ambiguousRecovery(
        'Interrupted fresh-install canonical quarantine already exists.',
        descriptor.journalPath,
        quarantine,
      );
    }
    const removed = await detachAndDeleteOwnedDirectory({
      livePath: paths.canonicalRoot,
      quarantinePath: quarantine,
      expectedIdentity: evidence.canonical.completion.entryIdentity,
      verifyDetached: async (detachedPath) => {
        const canonical = await validateCanonicalDirectory(
          detachedPath,
          evidence.canonical.intent.installId,
          evidence.canonical.intent.digest,
        );
        return canonical.valid;
      },
    });
    if (!removed) {
      throw ambiguousRecovery(
        'Interrupted fresh-install canonical payload changed before cleanup.',
        descriptor.journalPath,
        paths.canonicalRoot,
      );
    }
  }
  if (stagingState.type !== 'missing') {
    const quarantine = path.join(
      paths.installRoot,
      `.staging-cleanup-${journal.operationId}`,
    );
    if ((await entryFingerprint(quarantine)).type !== 'missing') {
      throw ambiguousRecovery(
        'Interrupted fresh-install canonical staging quarantine already exists.',
        descriptor.journalPath,
        quarantine,
      );
    }
    const removed = await detachAndDeleteOwnedDirectory({
      livePath: stagingPath,
      quarantinePath: quarantine,
      expectedIdentity: stagingState.identity,
      verifyDetached: async (detachedPath) => {
        const canonical = await validateCanonicalDirectory(
          detachedPath,
          evidence.canonical.intent.installId,
          evidence.canonical.intent.digest,
        );
        return canonical.valid;
      },
    });
    if (!removed) {
      throw ambiguousRecovery(
        'Interrupted fresh-install canonical staging changed before cleanup.',
        descriptor.journalPath,
        stagingPath,
      );
    }
  }
  if (evidence.root.completion) {
    const currentRoot = await entryFingerprint(paths.installRoot);
    if (
      currentRoot.type !== 'directory' ||
      currentRoot.identity !== evidence.root.completion.entryIdentity
    ) {
      throw ambiguousRecovery(
        'Interrupted fresh-install root changed before cleanup.',
        descriptor.journalPath,
        paths.installRoot,
      );
    }
    const remaining = await readdir(paths.installRoot);
    if (remaining.length !== 0) {
      throw ambiguousRecovery(
        'Interrupted fresh-install root is not empty after owned cleanup.',
        descriptor.journalPath,
        paths.installRoot,
      );
    }
    await rmdir(paths.installRoot);
  }
  await removeRecoveredOperation(control);
}

function validateInterruptedUninstallJournal(paths, runtime, descriptor, journal) {
  const journalPath = descriptor.journalPath;
  if (
    !journal.previousManifest ||
    typeof journal.installRootIdentity !== 'string' ||
    !Array.isArray(journal.intents) ||
    !Array.isArray(journal.completed)
  ) {
    throw ambiguousRecovery('Interrupted uninstall lacks its ownership snapshot.', journalPath);
  }
  const manifest = validateManifest(
    journal.previousManifest,
    { packageName: runtime.packageName, paths },
    journalPath,
  );
  const allowedIntents = new Set([
    'remove-target',
    'remove-canonical',
    'remove-manifest',
    'remove-install-root',
  ]);
  const allowedCompletions = new Set([
    'remove-target',
    'preserve-target',
    'remove-canonical',
    'remove-manifest',
    'remove-install-root',
  ]);
  if (
    journal.intents.some((record) => !record || !allowedIntents.has(record.action)) ||
    journal.completed.some(
      (record) => !record || !allowedCompletions.has(record.action),
    )
  ) {
    throw ambiguousRecovery('Interrupted uninstall contains an unexpected action.', journalPath);
  }

  const targets = {};
  for (const name of ['codex', 'claude']) {
    const intent = singleJournalRecord(
      journal.intents,
      'remove-target',
      name,
      journalPath,
    );
    const removed = singleJournalRecord(
      journal.completed,
      'remove-target',
      name,
      journalPath,
    );
    const preserved = singleJournalRecord(
      journal.completed,
      'preserve-target',
      name,
      journalPath,
    );
    const record = manifest.targets[name];
    const expectedQuarantine = path.join(
      path.dirname(record.path),
      `.agent-init-rollback-${journal.operationId}-${name}`,
    );
    if (
      (removed && !intent) ||
      (removed && preserved) ||
      (intent &&
        (intent.path !== record.path ||
          intent.quarantine !== expectedQuarantine ||
          typeof intent.expectedIdentity !== 'string' ||
          !['owned-valid', 'owned-broken'].includes(intent.expectedStatus) ||
          (record.mode === 'symlink' &&
            intent.expectedIdentity !== record.entryIdentity))) ||
      (removed && removed.path !== record.path) ||
      (preserved && preserved.path !== record.path)
    ) {
      throw ambiguousRecovery(
        `Interrupted uninstall ${name} evidence is not operation-bound.`,
        journalPath,
      );
    }
    targets[name] = { intent, removed, preserved, record, quarantine: expectedQuarantine };
  }

  const canonicalIntent = singleJournalRecord(
    journal.intents,
    'remove-canonical',
    undefined,
    journalPath,
  );
  const canonicalCompletion = singleJournalRecord(
    journal.completed,
    'remove-canonical',
    undefined,
    journalPath,
  );
  const targetDecisionsComplete = Object.values(targets).every(
    (target) => target.removed || target.preserved,
  );
  if (
    (canonicalCompletion && !canonicalIntent) ||
    ((canonicalIntent || canonicalCompletion) && !targetDecisionsComplete) ||
    (canonicalIntent &&
      (canonicalIntent.path !== paths.canonicalRoot ||
        canonicalIntent.quarantine !==
          path.join(paths.installRoot, `.rollback-${journal.operationId}`) ||
        typeof canonicalIntent.expectedIdentity !== 'string' ||
        canonicalIntent.digest !== manifest.canonical.digest ||
        canonicalIntent.installId !== manifest.installId)) ||
    (canonicalCompletion && canonicalCompletion.path !== paths.canonicalRoot)
  ) {
    throw ambiguousRecovery(
      'Interrupted uninstall canonical evidence is not operation-bound.',
      journalPath,
    );
  }

  const manifestIntent = singleJournalRecord(
    journal.intents,
    'remove-manifest',
    undefined,
    journalPath,
  );
  const manifestCompletion = singleJournalRecord(
    journal.completed,
    'remove-manifest',
    undefined,
    journalPath,
  );
  if (
    (manifestCompletion && !manifestIntent) ||
    ((manifestIntent || manifestCompletion) && !canonicalCompletion) ||
    (manifestIntent &&
      (manifestIntent.path !== paths.manifest ||
        typeof manifestIntent.expectedIdentity !== 'string')) ||
    (manifestCompletion && manifestCompletion.path !== paths.manifest)
  ) {
    throw ambiguousRecovery(
      'Interrupted uninstall manifest evidence is not operation-bound.',
      journalPath,
    );
  }

  const rootIntent = singleJournalRecord(
    journal.intents,
    'remove-install-root',
    undefined,
    journalPath,
  );
  const rootCompletion = singleJournalRecord(
    journal.completed,
    'remove-install-root',
    undefined,
    journalPath,
  );
  if (
    (rootCompletion && !rootIntent) ||
    ((rootIntent || rootCompletion) && !manifestCompletion) ||
    (rootIntent &&
      (rootIntent.path !== paths.installRoot ||
        rootIntent.expected !== 'empty-directory')) ||
    (rootCompletion && rootCompletion.path !== paths.installRoot) ||
    (journal.committed === true && !rootCompletion)
  ) {
    throw ambiguousRecovery(
      'Interrupted uninstall root evidence is not operation-bound.',
      journalPath,
    );
  }

  return {
    manifest,
    targets,
    canonical: {
      intent: canonicalIntent,
      completion: canonicalCompletion,
      quarantine: path.join(paths.installRoot, `.rollback-${journal.operationId}`),
    },
    manifestRemoval: { intent: manifestIntent, completion: manifestCompletion },
    root: { intent: rootIntent, completion: rootCompletion },
  };
}

async function validateUninstallTargetEntry(
  entryPath,
  livePath,
  paths,
  manifest,
  record,
  expectedIdentity,
) {
  const fingerprint = await entryFingerprint(entryPath);
  if (fingerprint.identity !== expectedIdentity) return false;
  if (record.mode === 'symlink') {
    return (
      fingerprint.type === 'symlink' &&
      (record.linkText == null || fingerprint.linkText === record.linkText) &&
      (await linkResolvesToCanonical(paths, entryPath, fingerprint.linkText))
    );
  }
  const copy = await validateManagedCopyDirectory(entryPath, manifest, record);
  return copy.valid && copy.fingerprint.identity === expectedIdentity;
}

async function deleteValidatedUninstallTarget(
  entryPath,
  livePath,
  paths,
  manifest,
  record,
  expectedIdentity,
) {
  if (
    !(await validateUninstallTargetEntry(
      entryPath,
      livePath,
      paths,
      manifest,
      record,
      expectedIdentity,
    ))
  ) {
    return false;
  }
  if (record.mode === 'symlink') await unlink(entryPath);
  else await rm(entryPath, { recursive: true });
  return true;
}

async function recoverInterruptedUninstall(paths, runtime, control) {
  const details = control.error.details;
  const descriptor = details?.descriptor;
  const journal = details?.journal;
  if (
    control.status !== 'recoverable' ||
    descriptor?.operation !== 'uninstall' ||
    journal?.operation !== 'uninstall' ||
    journal.operationId !== descriptor.operationId
  ) {
    throw ambiguousRecovery(
      'Interrupted lifecycle operation lacks safe uninstall recovery evidence.',
      details?.path ?? paths.lock,
    );
  }
  const evidence = validateInterruptedUninstallJournal(
    paths,
    runtime,
    descriptor,
    journal,
  );
  const rootState = await entryFingerprint(paths.installRoot);
  if (
    rootState.type !== 'missing' &&
    (rootState.type !== 'directory' ||
      rootState.identity !== journal.installRootIdentity)
  ) {
    throw ambiguousRecovery(
      'Interrupted uninstall root identity changed.',
      descriptor.journalPath,
      paths.installRoot,
    );
  }
  if (
    rootState.type === 'missing' &&
    !evidence.root.intent &&
    !evidence.root.completion
  ) {
    throw ambiguousRecovery(
      'Interrupted uninstall root disappeared before its removal intent.',
      descriptor.journalPath,
      paths.installRoot,
    );
  }

  const targetStates = {};
  for (const name of ['codex', 'claude']) {
    const target = evidence.targets[name];
    const live = await entryFingerprint(target.record.path);
    const quarantine = await entryFingerprint(target.quarantine);
    if (quarantine.type !== 'missing') {
      if (
        !target.intent ||
        quarantine.identity !== target.intent.expectedIdentity ||
        !(await validateUninstallTargetEntry(
          target.quarantine,
          target.record.path,
          paths,
          evidence.manifest,
          target.record,
          target.intent.expectedIdentity,
        )) ||
        live.identity === target.intent.expectedIdentity
      ) {
        throw ambiguousRecovery(
          `Interrupted uninstall ${name} quarantine ownership changed.`,
          descriptor.journalPath,
          target.quarantine,
        );
      }
    }
    if ((target.removed || target.preserved) && quarantine.type !== 'missing') {
      throw ambiguousRecovery(
        `Interrupted uninstall ${name} has residual quarantine after completion.`,
        descriptor.journalPath,
        target.quarantine,
      );
    }
    targetStates[name] = { live, quarantine };
  }

  const canonicalState = await entryFingerprint(paths.canonicalRoot);
  const canonicalQuarantineState = await entryFingerprint(
    evidence.canonical.quarantine,
  );
  if (canonicalQuarantineState.type !== 'missing') {
    if (
      !evidence.canonical.intent ||
      canonicalState.type !== 'missing' ||
      canonicalQuarantineState.identity !==
        evidence.canonical.intent.expectedIdentity
    ) {
      throw ambiguousRecovery(
        'Interrupted uninstall canonical quarantine state is ambiguous.',
        descriptor.journalPath,
        evidence.canonical.quarantine,
      );
    }
    const canonical = await validateCanonicalDirectory(
      evidence.canonical.quarantine,
      evidence.manifest.installId,
      evidence.manifest.canonical.digest,
    );
    if (!canonical.valid) {
      throw ambiguousRecovery(
        'Interrupted uninstall canonical quarantine ownership changed.',
        descriptor.journalPath,
        evidence.canonical.quarantine,
      );
    }
  }
  if (evidence.canonical.completion) {
    if (
      canonicalState.type !== 'missing' ||
      canonicalQuarantineState.type !== 'missing'
    ) {
      throw ambiguousRecovery(
        'Interrupted uninstall canonical payload reappeared after completion.',
        descriptor.journalPath,
        paths.canonicalRoot,
      );
    }
  } else if (canonicalQuarantineState.type === 'missing') {
    if (canonicalState.type === 'missing') {
      if (!evidence.canonical.intent) {
        throw ambiguousRecovery(
          'Interrupted uninstall canonical payload disappeared before its intent.',
          descriptor.journalPath,
          paths.canonicalRoot,
        );
      }
    } else {
      const canonical = await validateCanonicalDirectory(
        paths.canonicalRoot,
        evidence.manifest.installId,
        evidence.manifest.canonical.digest,
      );
      const expectedIdentity = evidence.canonical.intent?.expectedIdentity;
      if (
        !canonical.valid ||
        (expectedIdentity && canonical.fingerprint.identity !== expectedIdentity)
      ) {
        throw ambiguousRecovery(
          'Interrupted uninstall canonical payload ownership changed.',
          descriptor.journalPath,
          paths.canonicalRoot,
        );
      }
    }
  }

  const manifestState = await entryFingerprint(paths.manifest);
  if (evidence.manifestRemoval.completion) {
    if (manifestState.type !== 'missing') {
      throw ambiguousRecovery(
        'Interrupted uninstall manifest reappeared after completion.',
        descriptor.journalPath,
        paths.manifest,
      );
    }
  } else if (manifestState.type === 'missing') {
    if (!evidence.manifestRemoval.intent) {
      throw ambiguousRecovery(
        'Interrupted uninstall manifest disappeared before its intent.',
        descriptor.journalPath,
        paths.manifest,
      );
    }
  } else {
    const manifest = await readManifest(paths.manifest, {
      packageName: runtime.packageName,
      paths,
    });
    const expectedIdentity = evidence.manifestRemoval.intent?.expectedIdentity;
    if (
      manifestState.type !== 'file' ||
      (expectedIdentity && manifestState.identity !== expectedIdentity) ||
      serializeJson(manifest) !== serializeJson(evidence.manifest)
    ) {
      throw ambiguousRecovery(
        'Interrupted uninstall manifest ownership changed.',
        descriptor.journalPath,
        paths.manifest,
      );
    }
  }

  if (rootState.type === 'directory') {
    const allowedEntries = new Set();
    if (canonicalState.type !== 'missing') allowedEntries.add('current');
    if (canonicalQuarantineState.type !== 'missing') {
      allowedEntries.add(path.basename(evidence.canonical.quarantine));
    }
    if (manifestState.type !== 'missing') allowedEntries.add('install.json');
    const entries = await readdir(paths.installRoot);
    if (entries.some((name) => !allowedEntries.has(name))) {
      throw ambiguousRecovery(
        'Interrupted uninstall root contains unknown entries.',
        descriptor.journalPath,
        paths.installRoot,
      );
    }
  }

  const operation = await resumeRecoveredOperation(control, {
    afterJournalSnapshot: runtime.afterJournalSnapshot,
  });
  try {
    for (const name of ['codex', 'claude']) {
      const target = evidence.targets[name];
      if (target.removed || target.preserved) continue;
      const state = targetStates[name];
      if (!target.intent) {
        const result = await removeOwnedTarget({
          paths,
          name,
          manifest: evidence.manifest,
          operation,
        });
        if (result.action !== 'removed') {
          await recordCompletion(operation, {
            action: 'preserve-target',
            name,
            path: result.path,
            status: result.status,
          });
        }
        continue;
      }
      if (state.quarantine.type !== 'missing') {
        if (
          !(await deleteValidatedUninstallTarget(
            target.quarantine,
            target.record.path,
            paths,
            evidence.manifest,
            target.record,
            target.intent.expectedIdentity,
          ))
        ) {
          throw ambiguousRecovery(
            `Interrupted uninstall ${name} quarantine changed before cleanup.`,
            descriptor.journalPath,
            target.quarantine,
          );
        }
        await recordCompletion(operation, {
          action: 'remove-target',
          name,
          path: target.record.path,
        });
        continue;
      }
      if (state.live.type === 'missing') {
        await recordCompletion(operation, {
          action: 'remove-target',
          name,
          path: target.record.path,
        });
        continue;
      }
      if (
        state.live.identity !== target.intent.expectedIdentity ||
        !(await validateUninstallTargetEntry(
          target.record.path,
          target.record.path,
          paths,
          evidence.manifest,
          target.record,
          target.intent.expectedIdentity,
        ))
      ) {
        await recordCompletion(operation, {
          action: 'preserve-target',
          name,
          path: target.record.path,
          status: 'owned-drifted',
        });
        continue;
      }
      if ((await entryFingerprint(target.quarantine)).type !== 'missing') {
        throw ambiguousRecovery(
          `Interrupted uninstall ${name} quarantine appeared before detach.`,
          descriptor.journalPath,
          target.quarantine,
        );
      }
      await rename(target.record.path, target.quarantine);
      if (
        !(await deleteValidatedUninstallTarget(
          target.quarantine,
          target.record.path,
          paths,
          evidence.manifest,
          target.record,
          target.intent.expectedIdentity,
        ))
      ) {
        throw ambiguousRecovery(
          `Interrupted uninstall ${name} target changed after detach.`,
          descriptor.journalPath,
          target.quarantine,
        );
      }
      await recordCompletion(operation, {
        action: 'remove-target',
        name,
        path: target.record.path,
      });
    }

    if (!evidence.canonical.completion) {
      if (!evidence.canonical.intent) {
        const current = await inspectCanonical(paths, evidence.manifest);
        const result = await removeCanonical(
          paths,
          evidence.manifest,
          current,
          operation,
        );
        if (result.action !== 'removed') {
          throw ambiguousRecovery(
            'Interrupted uninstall canonical payload could not be removed safely.',
            descriptor.journalPath,
            paths.canonicalRoot,
          );
        }
      } else if (canonicalQuarantineState.type !== 'missing') {
        const current = await validateCanonicalDirectory(
          evidence.canonical.quarantine,
          evidence.manifest.installId,
          evidence.manifest.canonical.digest,
        );
        if (
          !current.valid ||
          current.fingerprint.identity !==
            evidence.canonical.intent.expectedIdentity
        ) {
          throw ambiguousRecovery(
            'Interrupted uninstall canonical quarantine changed before cleanup.',
            descriptor.journalPath,
            evidence.canonical.quarantine,
          );
        }
        await rm(evidence.canonical.quarantine, { recursive: true });
        await recordCompletion(operation, {
          action: 'remove-canonical',
          path: paths.canonicalRoot,
        });
      } else if (canonicalState.type === 'missing') {
        await recordCompletion(operation, {
          action: 'remove-canonical',
          path: paths.canonicalRoot,
        });
      } else {
        if (
          (await entryFingerprint(evidence.canonical.quarantine)).type !==
          'missing'
        ) {
          throw ambiguousRecovery(
            'Interrupted uninstall canonical quarantine appeared before detach.',
            descriptor.journalPath,
            evidence.canonical.quarantine,
          );
        }
        await rename(paths.canonicalRoot, evidence.canonical.quarantine);
        const detached = await validateCanonicalDirectory(
          evidence.canonical.quarantine,
          evidence.manifest.installId,
          evidence.manifest.canonical.digest,
        );
        if (
          !detached.valid ||
          detached.fingerprint.identity !==
            evidence.canonical.intent.expectedIdentity
        ) {
          throw ambiguousRecovery(
            'Interrupted uninstall canonical payload changed after detach.',
            descriptor.journalPath,
            evidence.canonical.quarantine,
          );
        }
        await rm(evidence.canonical.quarantine, { recursive: true });
        await recordCompletion(operation, {
          action: 'remove-canonical',
          path: paths.canonicalRoot,
        });
      }
    }

    if (!evidence.manifestRemoval.completion) {
      const currentManifest = await entryFingerprint(paths.manifest);
      if (!evidence.manifestRemoval.intent) {
        if (currentManifest.type !== 'file') {
          throw ambiguousRecovery(
            'Interrupted uninstall manifest is not available for removal.',
            descriptor.journalPath,
            paths.manifest,
          );
        }
        await recordIntent(operation, {
          action: 'remove-manifest',
          path: paths.manifest,
          expectedIdentity: currentManifest.identity,
        });
      }
      const expectedIdentity =
        evidence.manifestRemoval.intent?.expectedIdentity ??
        currentManifest.identity;
      const revalidated = await entryFingerprint(paths.manifest);
      if (revalidated.type === 'missing') {
        await recordCompletion(operation, {
          action: 'remove-manifest',
          path: paths.manifest,
        });
      } else if (
        revalidated.type === 'file' &&
        revalidated.identity === expectedIdentity
      ) {
        await unlink(paths.manifest);
        await recordCompletion(operation, {
          action: 'remove-manifest',
          path: paths.manifest,
        });
      } else {
        throw ambiguousRecovery(
          'Interrupted uninstall manifest changed before removal.',
          descriptor.journalPath,
          paths.manifest,
        );
      }
    }

    if (!evidence.root.completion) {
      if (!evidence.root.intent) {
        await recordIntent(operation, {
          action: 'remove-install-root',
          path: paths.installRoot,
          expected: 'empty-directory',
        });
      }
      const currentRoot = await entryFingerprint(paths.installRoot);
      if (currentRoot.type === 'missing') {
        await recordCompletion(operation, {
          action: 'remove-install-root',
          path: paths.installRoot,
        });
      } else if (
        currentRoot.type === 'directory' &&
        currentRoot.identity === journal.installRootIdentity &&
        (await readdir(paths.installRoot)).length === 0
      ) {
        await rmdir(paths.installRoot);
        await recordCompletion(operation, {
          action: 'remove-install-root',
          path: paths.installRoot,
        });
      } else {
        throw ambiguousRecovery(
          'Interrupted uninstall root changed or is not empty.',
          descriptor.journalPath,
          paths.installRoot,
        );
      }
    }

    if (operation.journal.committed !== true) {
      await updateOperation(operation, { phase: 'committed', committed: true });
    }
    await releaseOperation(operation);
  } catch (error) {
    markOperationInactive(operation);
    throw error;
  }
}

function requireManagedCopyUpdateIntent(journal, name, record, journalPath) {
  const intent = findLastIntent(journal, 'swap-target-update', name);
  const expectedStaging = path.join(
    path.dirname(record.path),
    `.agent-init-staging-${journal.operationId}-${name}`,
  );
  const expectedRollback = path.join(
    path.dirname(record.path),
    `.agent-init-rollback-${journal.operationId}-${name}`,
  );
  if (
    !intent ||
    intent.path !== record.path ||
    intent.staging !== expectedStaging ||
    intent.rollback !== expectedRollback ||
    intent.oldDigest !== record.digest ||
    intent.newDigest !== journal.newDigest
  ) {
    throw new InstallationError(
      'AMBIGUOUS_OPERATION',
      `Interrupted update target paths or digests are not operation-bound: ${record.path}`,
      {
        path: journalPath,
        remediation: 'Preserve all assets and inspect the journal manually.',
      },
    );
  }
  return intent;
}

async function recoverInterruptedUpdate(paths, runtime, control) {
  const details = control.error.details;
  const descriptor = details?.descriptor;
  const journal = details?.journal;
  if (
    control.status !== 'recoverable' ||
    descriptor?.operation !== 'update' ||
    journal?.operation !== 'update' ||
    !journal.previousManifest ||
    typeof journal.oldDigest !== 'string' ||
    typeof journal.newDigest !== 'string'
  ) {
    throw new InstallationError(
      'AMBIGUOUS_OPERATION',
      `Interrupted lifecycle operation lacks safe update recovery evidence: ${details?.path ?? paths.lock}`,
      {
        path: details?.path ?? paths.lock,
        remediation: 'Preserve the control files and managed assets for manual review.',
      },
    );
  }
  const previousManifest = validateManifest(
    journal.previousManifest,
    { packageName: runtime.packageName, paths },
    descriptor.journalPath,
  );
  const canonicalIntent = findLastIntent(journal, 'swap-canonical-update');
  if (
    !canonicalIntent ||
    canonicalIntent.path !== paths.canonicalRoot ||
    canonicalIntent.rollback !== path.join(paths.installRoot, `.rollback-${journal.operationId}`) ||
    canonicalIntent.staging !== path.join(paths.installRoot, `.staging-${journal.operationId}`) ||
    canonicalIntent.oldDigest !== previousManifest.canonical.digest ||
    canonicalIntent.newDigest !== journal.newDigest
  ) {
    throw new InstallationError(
      'AMBIGUOUS_OPERATION',
      `Interrupted update canonical paths or digests are not operation-bound: ${descriptor.journalPath}`,
      {
        path: descriptor.journalPath,
        remediation: 'Preserve the control files and managed assets for manual review.',
      },
    );
  }

  const manifestOnDisk = await readManifest(paths.manifest, {
    packageName: runtime.packageName,
    paths,
  });
  if (!manifestOnDisk || manifestOnDisk.installId !== previousManifest.installId) {
    throw new InstallationError(
      'AMBIGUOUS_OPERATION',
      `Interrupted update manifest ownership changed: ${paths.manifest}`,
      { path: paths.manifest, remediation: 'Preserve all assets and inspect ownership manually.' },
    );
  }
  if (journal.committed === true) {
    if (
      manifestOnDisk.version !== journal.proposedVersion ||
      manifestOnDisk.canonical.digest !== journal.newDigest
    ) {
      throw new InstallationError(
        'AMBIGUOUS_OPERATION',
        `Committed update manifest does not match the journal: ${paths.manifest}`,
        { path: paths.manifest, remediation: 'Preserve all assets and inspect the commit evidence manually.' },
      );
    }
    const currentCanonical = await inspectCanonical(paths, manifestOnDisk);
    if (currentCanonical.status !== 'owned-valid') {
      throw new InstallationError(
        'AMBIGUOUS_OPERATION',
        `Committed update canonical payload is not valid: ${paths.canonicalRoot}`,
        { path: paths.canonicalRoot, remediation: 'Preserve all assets and inspect them manually.' },
      );
    }
    for (const name of ['codex', 'claude']) {
      const target = await inspectTarget(
        paths,
        name,
        manifestOnDisk.targets[name],
        manifestOnDisk,
      );
      if (target.status !== 'owned-valid') {
        throw new InstallationError(
          'AMBIGUOUS_OPERATION',
          `Committed update target is not valid: ${target.path}`,
          { path: target.path, remediation: 'Preserve all assets and inspect them manually.' },
        );
      }
      const oldRecord = previousManifest.targets[name];
      if (oldRecord.mode !== 'copy') continue;
      const intent = requireManagedCopyUpdateIntent(
        journal,
        name,
        oldRecord,
        descriptor.journalPath,
      );
      const rollbackState = await entryFingerprint(intent.rollback);
      if (rollbackState.type !== 'missing') {
        const oldCopy = await validateManagedCopyDirectory(
          intent.rollback,
          previousManifest,
          oldRecord,
        );
        if (!oldCopy.valid) {
          throw new InstallationError(
            'AMBIGUOUS_OPERATION',
            `Committed managed-copy rollback cannot be validated: ${intent.rollback}`,
            { path: intent.rollback, remediation: 'Preserve the rollback entry for manual review.' },
          );
        }
        await rm(intent.rollback, { recursive: true });
      }
      const stagingState = await entryFingerprint(intent.staging);
      if (stagingState.type !== 'missing') {
        const stagedCopy = await validateManagedCopyDirectory(
          intent.staging,
          previousManifest,
          oldRecord,
          journal.newDigest,
        );
        if (!stagedCopy.valid) {
          throw new InstallationError(
            'AMBIGUOUS_OPERATION',
            `Committed managed-copy staging cannot be validated: ${intent.staging}`,
            { path: intent.staging, remediation: 'Preserve the staging entry for manual review.' },
          );
        }
        await rm(intent.staging, { recursive: true });
      }
    }
    const manifestRollback = path.join(
      paths.installRoot,
      `.install.json.rollback-${journal.operationId}`,
    );
    const manifestRollbackState = await entryFingerprint(manifestRollback);
    if (manifestRollbackState.type !== 'missing') {
      if (manifestRollbackState.type !== 'file') {
        throw new InstallationError(
          'AMBIGUOUS_OPERATION',
          `Committed manifest rollback has an unexpected type: ${manifestRollback}`,
          { path: manifestRollback, remediation: 'Preserve the rollback entry for manual review.' },
        );
      }
      let rollbackManifest;
      try {
        rollbackManifest = validateManifest(
          JSON.parse(await readRegularFileNoFollow(manifestRollback, 'utf8')),
          { packageName: runtime.packageName, paths },
          manifestRollback,
        );
      } catch (error) {
        throw new InstallationError(
          'AMBIGUOUS_OPERATION',
          `Committed manifest rollback cannot be validated: ${manifestRollback}`,
          {
            path: manifestRollback,
            cause: error,
            remediation: 'Preserve the rollback entry for manual review.',
          },
        );
      }
      if (serializeJson(rollbackManifest) !== serializeJson(previousManifest)) {
        throw new InstallationError(
          'AMBIGUOUS_OPERATION',
          `Committed manifest rollback does not match the previous manifest: ${manifestRollback}`,
          { path: manifestRollback, remediation: 'Preserve the rollback entry for manual review.' },
        );
      }
      if (
        !(await removeRegularIfIdentity(
          manifestRollback,
          manifestRollbackState.identity,
        ))
      ) {
        throw new InstallationError(
          'AMBIGUOUS_OPERATION',
          `Committed manifest rollback changed before cleanup: ${manifestRollback}`,
          { path: manifestRollback, remediation: 'Preserve the rollback entry for manual review.' },
        );
      }
    }
    const canonicalRollbackState = await entryFingerprint(canonicalIntent.rollback);
    if (canonicalRollbackState.type !== 'missing') {
      const oldCanonical = await validateCanonicalDirectory(
        canonicalIntent.rollback,
        previousManifest.installId,
        previousManifest.canonical.digest,
      );
      if (!oldCanonical.valid) {
        throw new InstallationError(
          'AMBIGUOUS_OPERATION',
          `Committed canonical rollback cannot be validated: ${canonicalIntent.rollback}`,
          { path: canonicalIntent.rollback, remediation: 'Preserve the rollback entry for manual review.' },
        );
      }
      await rm(canonicalIntent.rollback, { recursive: true });
    }
    const canonicalStagingState = await entryFingerprint(canonicalIntent.staging);
    if (canonicalStagingState.type !== 'missing') {
      const stagedCanonical = await validateCanonicalDirectory(
        canonicalIntent.staging,
        previousManifest.installId,
        journal.newDigest,
      );
      if (!stagedCanonical.valid) {
        throw new InstallationError(
          'AMBIGUOUS_OPERATION',
          `Committed canonical staging cannot be validated: ${canonicalIntent.staging}`,
          { path: canonicalIntent.staging, remediation: 'Preserve the staging entry for manual review.' },
        );
      }
      await rm(canonicalIntent.staging, { recursive: true });
    }
    await removeRecoveredOperation(control);
    return;
  }
  if (
    manifestOnDisk.version !== previousManifest.version ||
    manifestOnDisk.canonical.digest !== previousManifest.canonical.digest
  ) {
    throw new InstallationError(
      'AMBIGUOUS_OPERATION',
      `Interrupted update crossed its manifest commit point ambiguously: ${paths.manifest}`,
      { path: paths.manifest, remediation: 'Preserve all assets and inspect the update journal manually.' },
    );
  }

  for (const name of ['codex', 'claude']) {
    const record = previousManifest.targets[name];
    if (record.mode !== 'copy') continue;
    const intent = requireManagedCopyUpdateIntent(
      journal,
      name,
      record,
      descriptor.journalPath,
    );
    const swap = {
      live: record.path,
      staging: intent.staging,
      rollback: intent.rollback,
      detached: (await entryFingerprint(intent.rollback)).type === 'directory',
      promoted: false,
    };
    if (swap.detached) {
      const liveNew = await validateManagedCopyDirectory(
        swap.live,
        previousManifest,
        record,
        journal.newDigest,
      );
      swap.promoted = liveNew.valid;
      const unresolved = await restoreDirectorySwap(
        swap,
        (root) => validateManagedCopyDirectory(root, previousManifest, record),
        (root) =>
          validateManagedCopyDirectory(
            root,
            previousManifest,
            record,
            journal.newDigest,
          ),
      );
      if (unresolved.length > 0) {
        throw new InstallationError(
          'AMBIGUOUS_OPERATION',
          `Interrupted managed-copy update cannot be safely recovered: ${record.path}`,
          { path: record.path, unresolved, remediation: 'Preserve all assets for manual review.' },
        );
      }
    } else {
      const oldLive = await validateManagedCopyDirectory(
        swap.live,
        previousManifest,
        record,
      );
      if (!oldLive.valid) {
        throw new InstallationError(
          'AMBIGUOUS_OPERATION',
          `Interrupted managed-copy state is not an unchanged old target: ${record.path}`,
          { path: record.path, remediation: 'Preserve all assets for manual review.' },
        );
      }
    }
    await rm(intent.staging, { recursive: true, force: true }).catch(() => {});
  }

  const canonicalSwap = {
    live: canonicalIntent.path,
    staging: canonicalIntent.staging,
    rollback: canonicalIntent.rollback,
    detached: (await entryFingerprint(canonicalIntent.rollback)).type === 'directory',
    promoted: false,
  };
  if (canonicalSwap.detached) {
    const liveNew = await validateCanonicalDirectory(
      canonicalSwap.live,
      previousManifest.installId,
      journal.newDigest,
    );
    canonicalSwap.promoted = liveNew.valid;
    const unresolved = await restoreDirectorySwap(
      canonicalSwap,
      (root) =>
        validateCanonicalDirectory(
          root,
          previousManifest.installId,
          previousManifest.canonical.digest,
        ),
      (root) =>
        validateCanonicalDirectory(
          root,
          previousManifest.installId,
          journal.newDigest,
        ),
    );
    if (unresolved.length > 0) {
      throw new InstallationError(
        'AMBIGUOUS_OPERATION',
        `Interrupted canonical update cannot be safely recovered: ${paths.canonicalRoot}`,
        {
          path: paths.canonicalRoot,
          unresolved,
          remediation: 'Preserve all assets and inspect the journal manually.',
        },
      );
    }
  } else {
    const oldLive = await validateCanonicalDirectory(
      canonicalSwap.live,
      previousManifest.installId,
      previousManifest.canonical.digest,
    );
    if (!oldLive.valid) {
      throw new InstallationError(
        'AMBIGUOUS_OPERATION',
        `Interrupted canonical state is not an unchanged old payload: ${paths.canonicalRoot}`,
        { path: paths.canonicalRoot, remediation: 'Preserve all assets for manual review.' },
      );
    }
  }
  await rm(canonicalIntent.staging, { recursive: true, force: true }).catch(() => {});

  const verifiedCanonical = await inspectCanonical(paths, previousManifest);
  if (verifiedCanonical.status !== 'owned-valid') {
    throw new InstallationError(
      'AMBIGUOUS_OPERATION',
      `Recovered canonical payload did not validate: ${paths.canonicalRoot}`,
      { path: paths.canonicalRoot, remediation: 'Preserve operation evidence for manual review.' },
    );
  }
  for (const name of ['codex', 'claude']) {
    const target = await inspectTarget(
      paths,
      name,
      previousManifest.targets[name],
      previousManifest,
    );
    if (target.status !== 'owned-valid') {
      throw new InstallationError(
        'AMBIGUOUS_OPERATION',
        `Recovered target did not validate: ${target.path}`,
        { path: target.path, remediation: 'Preserve operation evidence for manual review.' },
      );
    }
  }
  await removeRecoveredOperation(control);
}

async function recoverBeforeMutation(paths, runtime, control = undefined) {
  const inspected = control ?? (await inspectOperationControl(paths));
  if (inspected.status === 'idle') return false;
  if (inspected.status === 'busy') throw inspected.error;
  if (inspected.status === 'ambiguous') throw inspected.error;
  const operation = inspected.error.details?.descriptor?.operation;
  if (operation === 'install') {
    await recoverInterruptedInstall(paths, runtime, inspected);
  } else if (operation === 'update') {
    await recoverInterruptedUpdate(paths, runtime, inspected);
  } else if (operation === 'uninstall') {
    await recoverInterruptedUninstall(paths, runtime, inspected);
  } else {
    throw ambiguousRecovery(
      `Interrupted ${String(operation)} recovery is not implemented safely.`,
      inspected.error.details?.path ?? paths.lock,
    );
  }
  return true;
}

async function executeInternal(request, runtime) {
  if (!request || !['install', 'update', 'doctor', 'uninstall'].includes(request.operation)) {
    throw new InstallationError(
      'USAGE_ERROR',
      `Unsupported lifecycle operation: ${String(request?.operation)}`,
      { remediation: 'Use install, update, doctor, or uninstall.' },
    );
  }
  const paths = await resolveInstallationPaths(runtime.homeDir);
  const payload = await validatePackagePayload(runtime);
  const control = await inspectOperationControl(paths);
  if (request.operation !== 'doctor') {
    if (control.status !== 'idle') {
      await recoverBeforeMutation(paths, runtime, control);
    }
    const residuePaths = await inspectLifecycleResidue(paths);
    if (residuePaths.length > 0) {
      throw new InstallationError(
        'AMBIGUOUS_OPERATION',
        `Lifecycle residue must be reviewed before mutation: ${residuePaths[0]}`,
        {
          path: residuePaths[0],
          unresolved: residuePaths,
          remediation:
            'Run doctor, preserve the reported operation-shaped entries, and inspect ownership evidence manually.',
        },
      );
    }
  }
  let initial;
  try {
    initial = await inspectInitialState(paths, runtime);
  } catch (error) {
    if (request.operation !== 'doctor') throw error;
    const check = doctorCheck(
      'installation-inspection',
      'error',
      error.code ?? 'UNEXPECTED_ERROR',
      error.details?.path ?? paths.installRoot,
      error.message,
      error.details?.remediation ?? 'Inspect the reported path before retrying.',
    );
    return {
      ok: false,
      outcome: 'unhealthy',
      operation: 'doctor',
      version: runtime.packageVersion,
      checks: [...lifecycleControlDoctorChecks(paths, control), check],
      changed: [],
    };
  }

  if (request.operation === 'doctor') {
    return runDoctor(paths, runtime, payload, initial, control);
  }
  if (request.operation === 'update') {
    if (!initial.manifest) {
      throw new InstallationError(
        'PARTIAL_INSTALLATION',
        `No managed installation is available to update: ${paths.installRoot}`,
        { path: paths.installRoot, remediation: 'Run install first.' },
      );
    }
    const canonical = await inspectCanonical(paths, initial.manifest);
    const versionOrder = compareVersions(runtime.packageVersion, initial.manifest.version);
    if (versionOrder < 0) {
      throw new InstallationError(
        'DOWNGRADE_REFUSED',
        `Running version ${runtime.packageVersion} is older than installed version ${initial.manifest.version}.`,
        {
          path: paths.manifest,
          remediation: 'Use npx @apparux/agent-init@latest update or another package newer than the installed version.',
        },
      );
    }
    if (
      initial.manifest.version === runtime.packageVersion &&
      initial.manifest.canonical.digest !== payload.digest
    ) {
      throw new InstallationError(
        'INTEGRITY_CONFLICT',
        `Running package reuses version ${runtime.packageVersion} with different payload bytes.`,
        {
          path: payload.sourceSkill,
          remediation: 'Publish changed payload under a new semantic version and retry update.',
        },
      );
    }
    if (
      initial.manifest.version === runtime.packageVersion &&
      initial.manifest.canonical.digest === payload.digest &&
      canonical.status === 'owned-valid' &&
      Object.values(initial.targets).every((target) => target.status === 'owned-valid')
    ) {
      return {
        ok: true,
        outcome: 'already-up-to-date',
        operation: 'update',
        version: runtime.packageVersion,
        installedVersion: initial.manifest.version,
        paths,
        changed: [],
        preserved: [],
        unresolved: [],
      };
    }
    if (versionOrder > 0) {
      if (
        canonical.status !== 'owned-valid' ||
        Object.values(initial.targets).some((target) => target.status !== 'owned-valid')
      ) {
        throw new InstallationError(
          'OWNERSHIP_MISMATCH',
          `Update will not overwrite missing, foreign, ambiguous, or drifted assets: ${paths.installRoot}`,
          {
            path: paths.installRoot,
            remediation: 'Run doctor and resolve ownership problems before upgrading.',
          },
        );
      }
      const operation = await acquireOperation(
        paths,
        request.operation,
        randomHex(runtime),
        isoNow(runtime),
        { afterJournalSnapshot: runtime.afterJournalSnapshot },
      );
      try {
        const result = await upgradeOwned(
          paths,
          runtime,
          payload,
          operation,
          initial.manifest,
        );
        await releaseOperation(operation);
        return result;
      } catch (error) {
        if (
          error?.code !== 'ROLLBACK_FAILED' &&
          error?.code !== 'RECOVERABLE_OPERATION'
        ) {
          await releaseOperation(operation).catch(() => {});
        } else {
          markOperationInactive(operation);
        }
        throw error;
      }
    }
    throw new InstallationError(
      'PARTIAL_INSTALLATION',
      `Same-version installation is not healthy: ${paths.installRoot}`,
      { path: paths.installRoot, remediation: 'Run doctor and repair only proven missing assets before retrying update.' },
    );
  }
  if (request.operation === 'uninstall') {
    if (!initial.manifest) {
      if (initial.installRoot.type === 'missing') {
        return {
          ok: true,
          outcome: 'already-uninstalled',
          operation: 'uninstall',
          version: runtime.packageVersion,
          paths,
          removed: [],
          preserved: Object.values(initial.targets)
            .filter((target) => target.status !== 'missing')
            .map((target) => target.path),
          unresolved: [],
          changed: [],
        };
      }
      throw new InstallationError(
        'PARTIAL_INSTALLATION',
        `Installation root exists without a valid manifest: ${paths.installRoot}`,
        { path: paths.installRoot, remediation: 'Preserve and inspect the root manually.' },
      );
    }
    const canonical = await inspectCanonical(paths, initial.manifest);
    const rootEntries = (await readdir(paths.installRoot)).sort();
    if (
      canonical.status !== 'owned-valid' ||
      rootEntries.some((name) => !['current', 'install.json'].includes(name))
    ) {
      throw new InstallationError(
        'OWNERSHIP_MISMATCH',
        `Installation root cannot be safely uninstalled: ${paths.installRoot}`,
        {
          path: paths.installRoot,
          remediation: 'Run doctor and preserve any drifted or unknown content for manual review.',
        },
      );
    }
    const operation = await acquireOperation(
      paths,
      request.operation,
      randomHex(runtime),
      isoNow(runtime),
      { afterJournalSnapshot: runtime.afterJournalSnapshot },
    );
    try {
      const result = await uninstallOwned(
        paths,
        runtime,
        payload,
        operation,
        initial.manifest,
      );
      await releaseOperation(operation);
      return result;
    } catch (error) {
      await updateOperation(operation, {
        phase: 'failed',
        committed: false,
        failureCode: error?.code ?? 'UNEXPECTED_ERROR',
      }).catch(() => {});
      if (operation.journal.intents.length === 0) {
        await releaseOperation(operation).catch(() => {});
        throw error;
      }
      markOperationInactive(operation);
      throw await describeUninstallFailure(
        paths,
        operation,
        initial.manifest,
        error,
      );
    }
  }
  if (request.operation !== 'install') {
    throw new InstallationError(
      'NOT_IMPLEMENTED',
      `Lifecycle operation is not implemented yet: ${request.operation}`,
      { remediation: 'Use install, doctor, or uninstall while this implementation slice is incomplete.' },
    );
  }

  throwOnInstallConflict(initial, paths);
  let repairManifest = null;
  if (initial.manifest) {
    if (initial.manifest.version !== runtime.packageVersion) {
      throw new InstallationError(
        'VERSION_MISMATCH',
        `Installed version ${initial.manifest.version} differs from running version ${runtime.packageVersion}.`,
        {
          path: paths.installRoot,
          remediation: 'Run update with the intended package version.',
        },
      );
    }
    if (initial.manifest.canonical.digest !== payload.digest) {
      throw new InstallationError(
        'INTEGRITY_CONFLICT',
        `Running package payload differs from the installed same-version payload: ${paths.installRoot}`,
        {
          path: paths.installRoot,
          remediation: 'Use a uniquely versioned intact package; do not overwrite a same-version installation.',
        },
      );
    }
    const canonical = await inspectCanonical(paths, initial.manifest);
    if (
      canonical.status === 'owned-valid' &&
      Object.values(initial.targets).every((target) => target.status === 'owned-valid')
    ) {
      return {
        ok: true,
        outcome: 'already-installed',
        operation: 'install',
        version: runtime.packageVersion,
        paths,
        manifest: initial.manifest,
        targets: initial.targets,
        changed: [],
        preserved: [],
        unresolved: [],
      };
    }
    const repairable =
      canonical.status === 'owned-valid' &&
      Object.values(initial.targets).some(
        (target) => target.status === 'owned-broken' && target.fingerprint.type === 'missing',
      ) &&
      Object.values(initial.targets).every(
        (target) =>
          target.status === 'owned-valid' ||
          (target.status === 'owned-broken' && target.fingerprint.type === 'missing'),
      );
    if (!repairable) {
      throw new InstallationError(
        'PARTIAL_INSTALLATION',
        `Existing installation requires ownership-safe repair that cannot be inferred safely: ${paths.installRoot}`,
        {
          path: paths.installRoot,
          remediation: 'Run doctor and resolve drift or ambiguous ownership manually.',
        },
      );
    }
    repairManifest = initial.manifest;
  }

  const operationId = randomHex(runtime);
  const operation = await acquireOperation(
    paths,
    request.operation,
    operationId,
    isoNow(runtime),
    { afterJournalSnapshot: runtime.afterJournalSnapshot },
  );
  let result;
  try {
    const lockedState = await inspectInitialState(paths, runtime);
    throwOnInstallConflict(lockedState, paths);
    if (repairManifest) {
      result = await repairMissingTargets(
        payload,
        paths,
        runtime,
        operation,
        repairManifest,
      );
    } else {
      if (lockedState.manifest || lockedState.installRoot.type !== 'missing') {
        throw new InstallationError(
          'INSTALL_CONFLICT',
          `Installation state changed after locking: ${paths.installRoot}`,
          { path: paths.installRoot, remediation: 'Inspect the concurrent change and retry.' },
        );
      }
      result = await installFresh(payload, paths, runtime, operation);
    }
  } catch (error) {
    if (error?.code !== 'ROLLBACK_FAILED') {
      await updateOperation(operation, {
        phase: 'rolled-back',
        committed: false,
        failureCode: error?.code ?? 'UNEXPECTED_ERROR',
      }).catch(() => {});
      await releaseOperation(operation).catch(() => {});
    }
    throw error;
  }
  await releaseOperation(operation);
  return result;
}

export async function executeLifecycle(request, runtime) {
  try {
    return await executeInternal(request, runtime);
  } catch (error) {
    const failure =
      error instanceof InstallationError
        ? error
        : new InstallationError(
            error.code === 'EACCES' || error.code === 'EPERM'
              ? 'PERMISSION_DENIED'
              : 'UNEXPECTED_ERROR',
            error.message || 'Lifecycle operation failed unexpectedly.',
            {
              cause: error,
              remediation: 'Run doctor and inspect the reported path before retrying.',
            },
          );
    return {
      ok: false,
      outcome: 'failed',
      operation: request?.operation,
      error: {
        code: failure.code,
        message: failure.message,
        path: failure.details?.path ?? null,
        remediation: failure.details?.remediation ?? 'Inspect the installation before retrying.',
        changed: failure.details?.changed ?? [],
        preserved: failure.details?.preserved ?? [],
        unresolved: failure.details?.unresolved ?? [],
      },
    };
  }
}
