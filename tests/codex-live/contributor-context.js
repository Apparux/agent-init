import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

import { digestProposal } from '../agent-init/evaluation-harness.js';
import { assertCodexDirectory } from './owned-runtime.js';

function failure(message) {
  return Object.assign(new Error(`CONTRIBUTOR_CONTEXT: ${message}`), { code: 'CONTRIBUTOR_CONTEXT' });
}

function presenceOnly(target) {
  return target.split('/').some((part) => part.toLowerCase().startsWith('.env'));
}

function contextDocument(target) {
  const parts = target.split('/');
  if (presenceOnly(target) || parts.includes('skills')
    || parts.includes('fixture.json') || path.posix.basename(target) === 'SKILL.md') return false;
  return /^(AGENTS\.md|CLAUDE\.md|README(?:\.[^/]+)?|package\.json|pom\.xml)$/.test(target)
    || /^docs\/.*\.(md|txt)$/.test(target) || /(?:^|\/)AGENTS\.md$/.test(target);
}

async function readDocument(root, entry) {
  if (entry.path.includes('\\') || entry.path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw failure('document path must be a safe relative physical path');
  }
  const absolute = path.join(root, entry.path);
  const stat = await lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024
    || await realpath(absolute) !== absolute) throw failure('document is not a bounded unlinked file');
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== stat.dev || before.ino !== stat.ino || before.nlink !== 1) {
      throw failure('document identity changed before reading');
    }
    const bytes = Buffer.allocUnsafe(64 * 1024 + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    const final = await lstat(absolute);
    const digest = `sha256:${createHash('sha256').update(bytes.subarray(0, length)).digest('hex')}`;
    if (length > 64 * 1024 || length !== stat.size || after.size !== stat.size
      || after.mode !== stat.mode || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs
      || final.dev !== stat.dev || final.ino !== stat.ino || await realpath(absolute) !== absolute
      || digest !== entry.digest) throw failure('document changed during bounded context capture');
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length)); }
    catch { throw failure('document is not valid UTF-8'); }
    return { path: entry.path, content, digest };
  } finally {
    await handle.close();
  }
}

// Physical inputs and available Skill metadata, not a preload or proof of native consumption.
export async function createContributorContext(contributors, generatedSkills) {
  const contexts = [];
  for (const contributor of contributors) {
    const identity = await assertCodexDirectory(contributor.repositoryRoot);
    const documents = [];
    for (const entry of contributor.inventory) {
      if (entry.type === 'file' && contextDocument(entry.path)) {
        documents.push(await readDocument(contributor.repositoryRoot, entry));
      }
    }
    const final = await assertCodexDirectory(contributor.repositoryRoot);
    if (final.dev !== identity.dev || final.ino !== identity.ino) throw failure('contributor root identity changed');
    const inventory = contributor.inventory.map((entry) => {
      if (!presenceOnly(entry.path)) return structuredClone(entry);
      return { path: entry.path, type: entry.type, mode: entry.mode };
    });
    contexts.push({ fixtureId: contributor.fixtureId, repositoryRoot: contributor.repositoryRoot, inventory, documents });
  }
  const manifest = { schemaVersion: 1, contributors: contexts, generatedSkills: structuredClone(generatedSkills) };
  const value = JSON.stringify(manifest);
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 128 * 1024) {
    throw failure('complete serialized context exceeds its 128 KiB wire-value budget');
  }
  return { value, digest: digestProposal(manifest), nativeConsumptionProven: false };
}
