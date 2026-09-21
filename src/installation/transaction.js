import { link, lstat, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';

import { entryFingerprint, readRegularFileNoFollow } from './filesystem.js';
import {
  publishJsonNoReplace,
  syncDirectory,
} from './manifest.js';
import { InstallationError } from './paths.js';

const OPERATION_ID_PATTERN = /^[a-f0-9]{32}$/;
const SNAPSHOT_WIDTH = 6;
const activeOperationIds = new Set();

async function sameEntry(left, right) {
  try {
    const [leftStat, rightStat] = await Promise.all([lstat(left), lstat(right)]);
    return (
      leftStat.isFile() &&
      rightStat.isFile() &&
      !leftStat.isSymbolicLink() &&
      !rightStat.isSymbolicLink() &&
      leftStat.dev === rightStat.dev &&
      leftStat.ino === rightStat.ino
    );
  } catch {
    return false;
  }
}

async function unlinkRegularIfIdentity(entryPath, identity) {
  const fingerprint = await entryFingerprint(entryPath);
  if (fingerprint.type !== 'file' || fingerprint.identity !== identity) return false;
  await unlink(entryPath);
  return true;
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function operationPaths(homeDirectory, operationId) {
  const base = `.agent-init.operation-${operationId}`;
  const journalPrefix = path.join(homeDirectory, `${base}.journal-`);
  return {
    descriptorPath: path.join(homeDirectory, `${base}.owner.json`),
    journalPrefix,
    journalPath: `${journalPrefix}${String(0).padStart(SNAPSHOT_WIDTH, '0')}.json`,
  };
}

function journalSnapshotPath(journalPrefix, sequence) {
  return `${journalPrefix}${String(sequence).padStart(SNAPSHOT_WIDTH, '0')}.json`;
}

async function listJournalSnapshots(descriptor) {
  const homeDirectory = path.dirname(descriptor.descriptorPath);
  const prefixName = path.basename(descriptor.journalPrefix);
  const names = await readdir(homeDirectory);
  const candidates = names.filter((name) => name.startsWith(prefixName));
  const pattern = new RegExp(
    `^\\.agent-init\\.operation-${descriptor.operationId}\\.journal-(\\d{${SNAPSHOT_WIDTH}})\\.json$`,
  );
  const indexed = candidates.map((name) => {
    const match = pattern.exec(name);
    if (!match) {
      throw new InstallationError(
        'AMBIGUOUS_OPERATION',
        `Lifecycle journal filename is not operation-bound: ${path.join(homeDirectory, name)}`,
        {
          path: path.join(homeDirectory, name),
          remediation: 'Preserve the control files and inspect them manually.',
        },
      );
    }
    return { sequence: Number(match[1]), path: path.join(homeDirectory, name) };
  });
  indexed.sort((left, right) => left.sequence - right.sequence);
  if (indexed.length === 0 || indexed[0].sequence !== 0) {
    throw new InstallationError(
      'AMBIGUOUS_OPERATION',
      `Lifecycle journal has no initial snapshot: ${descriptor.journalPrefix}`,
      {
        path: descriptor.journalPrefix,
        remediation: 'Preserve the control files and inspect them manually.',
      },
    );
  }

  const snapshots = [];
  let previousIdentity = null;
  for (let index = 0; index < indexed.length; index += 1) {
    const candidate = indexed[index];
    if (candidate.sequence !== index) {
      throw new InstallationError(
        'AMBIGUOUS_OPERATION',
        `Lifecycle journal snapshot sequence has a gap: ${candidate.path}`,
        {
          path: candidate.path,
          remediation: 'Preserve the control files and inspect them manually.',
        },
      );
    }
    let journal;
    try {
      journal = JSON.parse(await readRegularFileNoFollow(candidate.path, 'utf8'));
    } catch (error) {
      throw new InstallationError(
        'AMBIGUOUS_OPERATION',
        `Lifecycle journal snapshot is invalid: ${candidate.path}`,
        {
          path: candidate.path,
          cause: error,
          remediation: 'Preserve the control files and inspect them manually.',
        },
      );
    }
    const fingerprint = await entryFingerprint(candidate.path);
    if (
      journal?.schemaVersion !== 1 ||
      journal.operationId !== descriptor.operationId ||
      journal.operation !== descriptor.operation ||
      journal.snapshotSequence !== candidate.sequence ||
      journal.previousJournalIdentity !== previousIdentity ||
      journal.crashDurability !== descriptor.crashDurability ||
      fingerprint.type !== 'file'
    ) {
      throw new InstallationError(
        'AMBIGUOUS_OPERATION',
        `Lifecycle journal snapshot identity chain is invalid: ${candidate.path}`,
        {
          path: candidate.path,
          remediation: 'Preserve the control files and inspect them manually.',
        },
      );
    }
    snapshots.push({
      path: candidate.path,
      identity: fingerprint.identity,
      journal,
      sequence: candidate.sequence,
    });
    previousIdentity = fingerprint.identity;
  }
  return snapshots;
}

async function classifyExistingLock(lockPath) {
  let descriptor;
  try {
    descriptor = JSON.parse(await readRegularFileNoFollow(lockPath, 'utf8'));
  } catch (error) {
    throw new InstallationError(
      'AMBIGUOUS_OPERATION',
      `Lifecycle lock is not a valid regular owner descriptor: ${lockPath}`,
      {
        path: lockPath,
        cause: error,
        remediation: 'Do not remove the lock until its ownership has been reviewed manually.',
      },
    );
  }
  const homeDirectory = path.dirname(lockPath);
  const expected =
    typeof descriptor?.operationId === 'string'
      ? operationPaths(homeDirectory, descriptor.operationId)
      : null;
  if (
    descriptor?.schemaVersion !== 1 ||
    typeof descriptor.operationId !== 'string' ||
    !OPERATION_ID_PATTERN.test(descriptor.operationId) ||
    !['install', 'update', 'uninstall'].includes(descriptor.operation) ||
    !Number.isSafeInteger(descriptor.pid) ||
    descriptor.pid <= 0 ||
    !['directory-fsync', 'weaker-directory-fsync'].includes(
      descriptor.crashDurability,
    ) ||
    descriptor.descriptorPath !== expected?.descriptorPath ||
    descriptor.journalPrefix !== expected?.journalPrefix ||
    descriptor.journalPath !== expected?.journalPath ||
    !(await sameEntry(lockPath, expected?.descriptorPath))
  ) {
    throw new InstallationError(
      'AMBIGUOUS_OPERATION',
      `Lifecycle lock ownership cannot be proven: ${lockPath}`,
      {
        path: lockPath,
        remediation: 'Preserve the control files and inspect them manually before retrying.',
      },
    );
  }
  const descriptorFingerprint = await entryFingerprint(expected.descriptorPath);
  const lockFingerprint = await entryFingerprint(lockPath);
  const snapshots = await listJournalSnapshots(descriptor);
  const latest = snapshots.at(-1);
  const details = {
    path: latest.path,
    operation: descriptor.operation,
    descriptor,
    descriptorIdentity: descriptorFingerprint.identity,
    journal: latest.journal,
    journalIdentity: latest.identity,
    journalSnapshots: snapshots,
    lockIdentity: lockFingerprint.identity,
    remediation:
      'Retry a mutating command to recover, or run doctor for a read-only report.',
  };
  if (
    processIsAlive(descriptor.pid) &&
    (descriptor.pid !== process.pid || activeOperationIds.has(descriptor.operationId))
  ) {
    throw new InstallationError(
      'BUSY_OPERATION',
      `Another lifecycle operation is active for this home: ${lockPath}`,
      {
        ...details,
        path: lockPath,
        remediation: 'Wait for the active operation to finish, then retry.',
      },
    );
  }
  throw new InstallationError(
    'RECOVERABLE_OPERATION',
    `An interrupted lifecycle operation requires recovery: ${latest.path}`,
    details,
  );
}

export async function acquireOperation(
  paths,
  operation,
  operationId,
  now,
  hooks = {},
) {
  const { descriptorPath, journalPrefix, journalPath } = operationPaths(
    paths.logicalHome,
    operationId,
  );
  const durability = await syncDirectory(paths.logicalHome);
  const descriptor = {
    schemaVersion: 1,
    operationId,
    operation,
    pid: process.pid,
    startedAt: now,
    descriptorPath,
    journalPrefix,
    journalPath,
    crashDurability: durability.directoryFsync
      ? 'directory-fsync'
      : 'weaker-directory-fsync',
  };
  const initialJournal = {
    schemaVersion: 1,
    operationId,
    operation,
    phase: 'prepared',
    committed: false,
    intents: [],
    completed: [],
    assets: [],
    crashDurability: descriptor.crashDurability,
    snapshotSequence: 0,
    previousJournalIdentity: null,
  };
  let descriptorRecord;
  let journalRecord;
  try {
    descriptorRecord = await publishJsonNoReplace(
      descriptorPath,
      descriptor,
      `${operationId}-owner`,
    );
    journalRecord = await publishJsonNoReplace(
      journalPath,
      initialJournal,
      `${operationId}-journal-000000`,
    );
    try {
      await link(descriptorPath, paths.lock);
      await syncDirectory(paths.logicalHome);
    } catch (error) {
      if (error.code === 'EEXIST') await classifyExistingLock(paths.lock);
      throw error;
    }
  } catch (error) {
    if (journalRecord) {
      await unlinkRegularIfIdentity(journalPath, journalRecord.identity).catch(() => {});
    }
    if (descriptorRecord) {
      await unlinkRegularIfIdentity(descriptorPath, descriptorRecord.identity).catch(() => {});
    }
    if (error instanceof InstallationError) throw error;
    throw new InstallationError(
      error.code === 'EACCES' || error.code === 'EPERM'
        ? 'PERMISSION_DENIED'
        : 'AMBIGUOUS_OPERATION',
      `Lifecycle lock could not be acquired: ${paths.lock}`,
      {
        path: paths.lock,
        cause: error,
        remediation:
          'Check HOME permissions and ensure no lifecycle operation is active.',
      },
    );
  }

  const lockFingerprint = await entryFingerprint(paths.lock);
  activeOperationIds.add(operationId);
  return {
    operationId,
    operation,
    descriptorPath,
    descriptorIdentity: descriptorRecord.identity,
    journalPrefix,
    journalPath,
    journalIdentity: journalRecord.identity,
    journalSequence: 0,
    journalSnapshots: [
      { path: journalPath, identity: journalRecord.identity, sequence: 0 },
    ],
    lockPath: paths.lock,
    lockIdentity: lockFingerprint.identity,
    journal: initialJournal,
    createdParents: [],
    afterJournalSnapshot: hooks.afterJournalSnapshot,
  };
}

export async function updateOperation(operation, patch) {
  const sequence = operation.journalSequence + 1;
  const nextJournal = {
    ...operation.journal,
    ...patch,
    snapshotSequence: sequence,
    previousJournalIdentity: operation.journalIdentity,
  };
  const nextPath = journalSnapshotPath(operation.journalPrefix, sequence);
  const published = await publishJsonNoReplace(
    nextPath,
    nextJournal,
    `${operation.operationId}-journal-${String(sequence).padStart(SNAPSHOT_WIDTH, '0')}`,
  );
  operation.journal = nextJournal;
  operation.journalPath = nextPath;
  operation.journalIdentity = published.identity;
  operation.journalSequence = sequence;
  operation.journalSnapshots.push({
    path: nextPath,
    identity: published.identity,
    sequence,
  });
  if (typeof operation.afterJournalSnapshot === 'function') {
    await operation.afterJournalSnapshot(nextJournal);
  }
}

export async function recordIntent(operation, intent) {
  await updateOperation(operation, {
    phase: intent.action,
    intents: [...operation.journal.intents, intent],
  });
}

export async function recordCompletion(operation, completion) {
  await updateOperation(operation, {
    completed: [...operation.journal.completed, completion],
  });
}

async function validateOperationControl(operation) {
  if (
    !(await sameEntry(operation.lockPath, operation.descriptorPath)) ||
    (await entryFingerprint(operation.lockPath)).identity !== operation.lockIdentity ||
    (await entryFingerprint(operation.descriptorPath)).identity !==
      operation.descriptorIdentity
  ) {
    return false;
  }
  let descriptor;
  try {
    descriptor = JSON.parse(
      await readRegularFileNoFollow(operation.descriptorPath, 'utf8'),
    );
  } catch {
    return false;
  }
  const snapshots = await listJournalSnapshots(descriptor);
  if (snapshots.length !== operation.journalSnapshots.length) return false;
  return snapshots.every(
    (snapshot, index) =>
      snapshot.path === operation.journalSnapshots[index].path &&
      snapshot.identity === operation.journalSnapshots[index].identity &&
      snapshot.sequence === operation.journalSnapshots[index].sequence,
  );
}

export async function resumeRecoveredOperation(control, hooks = {}) {
  const details = control?.error?.details;
  const descriptor = details?.descriptor;
  const latest = details?.journalSnapshots?.at(-1);
  if (
    control?.status !== 'recoverable' ||
    !descriptor ||
    !latest ||
    latest.journal !== details.journal
  ) {
    throw new InstallationError(
      'AMBIGUOUS_OPERATION',
      `Lifecycle operation cannot be resumed safely: ${control?.lockPath ?? 'unknown lock'}`,
      {
        path: control?.lockPath,
        remediation: 'Preserve the control files and inspect them manually.',
      },
    );
  }
  const operation = {
    operationId: descriptor.operationId,
    operation: descriptor.operation,
    descriptorPath: descriptor.descriptorPath,
    descriptorIdentity: details.descriptorIdentity,
    journalPrefix: descriptor.journalPrefix,
    journalPath: latest.path,
    journalIdentity: latest.identity,
    journalSequence: latest.sequence,
    journalSnapshots: details.journalSnapshots.map((snapshot) => ({
      path: snapshot.path,
      identity: snapshot.identity,
      sequence: snapshot.sequence,
    })),
    lockPath: control.lockPath,
    lockIdentity: details.lockIdentity,
    journal: latest.journal,
    createdParents: [],
    afterJournalSnapshot: hooks.afterJournalSnapshot,
  };
  if (!(await validateOperationControl(operation))) {
    throw new InstallationError(
      'AMBIGUOUS_OPERATION',
      `Lifecycle control identities changed before resume: ${control.lockPath}`,
      {
        path: control.lockPath,
        remediation: 'Preserve the control files and inspect ownership manually.',
      },
    );
  }
  activeOperationIds.add(operation.operationId);
  return operation;
}

export function markOperationInactive(operation) {
  if (operation?.operationId) activeOperationIds.delete(operation.operationId);
}

export async function releaseOperation(operation) {
  if (!(await validateOperationControl(operation))) {
    throw new InstallationError(
      'AMBIGUOUS_OPERATION',
      `Lifecycle control identities changed before cleanup: ${operation.lockPath}`,
      {
        path: operation.lockPath,
        remediation: 'Preserve the control files and inspect ownership manually.',
      },
    );
  }
  await unlink(operation.lockPath);
  await syncDirectory(path.dirname(operation.lockPath));
  for (const snapshot of [...operation.journalSnapshots].reverse()) {
    if (!(await unlinkRegularIfIdentity(snapshot.path, snapshot.identity))) {
      throw new InstallationError(
        'AMBIGUOUS_OPERATION',
        `Lifecycle journal snapshot changed before cleanup: ${snapshot.path}`,
        { path: snapshot.path, remediation: 'Preserve the control files for review.' },
      );
    }
  }
  if (
    !(await unlinkRegularIfIdentity(
      operation.descriptorPath,
      operation.descriptorIdentity,
    ))
  ) {
    throw new InstallationError(
      'AMBIGUOUS_OPERATION',
      `Lifecycle descriptor changed before cleanup: ${operation.descriptorPath}`,
      { path: operation.descriptorPath, remediation: 'Preserve the control files for review.' },
    );
  }
  await syncDirectory(path.dirname(operation.lockPath));
  activeOperationIds.delete(operation.operationId);
}

export async function removeRecoveredOperation(control) {
  const details = control.error.details;
  const descriptor = details.descriptor;
  const expected = operationPaths(
    path.dirname(control.lockPath),
    descriptor?.operationId,
  );
  if (
    !descriptor ||
    descriptor.descriptorPath !== expected.descriptorPath ||
    descriptor.journalPrefix !== expected.journalPrefix ||
    descriptor.journalPath !== expected.journalPath ||
    !(await sameEntry(descriptor.descriptorPath, control.lockPath)) ||
    (await entryFingerprint(control.lockPath)).identity !== details.lockIdentity ||
    (await entryFingerprint(descriptor.descriptorPath)).identity !==
      details.descriptorIdentity
  ) {
    throw new InstallationError(
      'AMBIGUOUS_OPERATION',
      `Recovered lifecycle control identity changed: ${control.lockPath}`,
      {
        path: control.lockPath,
        remediation: 'Preserve the control files and inspect them manually.',
      },
    );
  }
  const currentSnapshots = await listJournalSnapshots(descriptor);
  if (
    currentSnapshots.length !== details.journalSnapshots.length ||
    !currentSnapshots.every(
      (snapshot, index) =>
        snapshot.path === details.journalSnapshots[index].path &&
        snapshot.identity === details.journalSnapshots[index].identity,
    )
  ) {
    throw new InstallationError(
      'AMBIGUOUS_OPERATION',
      `Recovered lifecycle journal snapshots changed: ${descriptor.journalPrefix}`,
      { path: descriptor.journalPrefix, remediation: 'Preserve control files for review.' },
    );
  }

  await unlink(control.lockPath);
  await syncDirectory(path.dirname(control.lockPath));
  for (const snapshot of [...details.journalSnapshots].reverse()) {
    if (!(await unlinkRegularIfIdentity(snapshot.path, snapshot.identity))) {
      throw new InstallationError(
        'AMBIGUOUS_OPERATION',
        `Recovered lifecycle journal changed: ${snapshot.path}`,
        { path: snapshot.path, remediation: 'Preserve control files for review.' },
      );
    }
  }
  if (
    !(await unlinkRegularIfIdentity(
      descriptor.descriptorPath,
      details.descriptorIdentity,
    ))
  ) {
    throw new InstallationError(
      'AMBIGUOUS_OPERATION',
      `Recovered lifecycle descriptor changed: ${descriptor.descriptorPath}`,
      { path: descriptor.descriptorPath, remediation: 'Preserve control files for review.' },
    );
  }
  await syncDirectory(path.dirname(control.lockPath));
}

async function listOrphanControlPaths(paths) {
  const names = await readdir(paths.logicalHome);
  const ownerPattern = /^\.agent-init\.operation-[a-f0-9]{32}\.owner\.json$/;
  const journalPattern =
    /^\.agent-init\.operation-[a-f0-9]{32}\.journal-\d{6}\.json$/;
  const tempPattern =
    /^\.(?:\.agent-init\.operation-[a-f0-9]{32}\.(?:owner|journal-\d{6})\.json)\.[a-z0-9-]+\.tmp$/;
  return names
    .filter(
      (name) =>
        ownerPattern.test(name) || journalPattern.test(name) || tempPattern.test(name),
    )
    .map((name) => path.join(paths.logicalHome, name))
    .sort();
}

export async function inspectOperationControl(paths) {
  try {
    await lstat(paths.lock);
  } catch (error) {
    if (error.code === 'ENOENT') {
      const orphanPaths = await listOrphanControlPaths(paths);
      if (orphanPaths.length > 0) {
        const operationError = new InstallationError(
          'AMBIGUOUS_OPERATION',
          `Lifecycle control files exist without the fixed lock: ${orphanPaths[0]}`,
          {
            path: orphanPaths[0],
            orphanPaths,
            remediation:
              'Preserve the orphan control files and inspect them manually; they are never removed automatically.',
          },
        );
        return {
          status: 'orphaned',
          lockPath: paths.lock,
          orphanPaths,
          error: operationError,
        };
      }
      return { status: 'idle', orphanPaths: [] };
    }
    throw error;
  }
  try {
    await classifyExistingLock(paths.lock);
  } catch (error) {
    if (error instanceof InstallationError) {
      return {
        status:
          error.code === 'BUSY_OPERATION'
            ? 'busy'
            : error.code === 'RECOVERABLE_OPERATION'
              ? 'recoverable'
              : 'ambiguous',
        lockPath: paths.lock,
        error,
      };
    }
    throw error;
  }
  return { status: 'ambiguous', lockPath: paths.lock };
}
