import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

import { digestProposal } from '../agent-init/evaluation-harness.js';
import { assertCodexDirectory } from './owned-runtime.js';

// Controller-only provenance. These descriptors never supply fact values or narration to an actor.
export async function bindCodexEvidence(fixture, repositoryRoot) {
  const root = await realpath(repositoryRoot);
  const identity = await assertCodexDirectory(repositoryRoot);
  const sources = [];
  for (const entry of fixture.evidence) {
    if (typeof entry.sourcePath !== 'string' || entry.sourcePath.includes('\\')
      || path.posix.isAbsolute(entry.sourcePath) || entry.sourcePath.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw Object.assign(new Error('Unsafe declared evidence path'), { code: 'SOURCE_BINDING' });
    }
    const parts = entry.sourcePath.split('/');
    const sensitive = parts.some((part) => part.toLowerCase().startsWith('.env'));
    // Reject sensitive byte locators before actor launch. Legacy lowercase
    // basenames stay compatible; other sensitive paths must declare presence.
    if (sensitive && entry.sourceLocation !== 'presence' && !parts.at(-1).startsWith('.env')) {
      throw Object.assign(new Error(`Sensitive evidence requires a presence locator: ${entry.sourcePath}`), { code: 'SOURCE_BINDING' });
    }
    let absolute = root;
    let stat;
    for (const [index, part] of parts.entries()) {
      absolute = path.join(absolute, part);
      try { stat = await lstat(absolute); }
      catch (cause) {
        if (cause.code !== 'ENOENT') throw cause;
        stat = null;
        break;
      }
      if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) {
        throw Object.assign(new Error('Evidence source must not follow a linked or non-directory ancestor'), { code: 'SOURCE_BINDING' });
      }
    }
    const type = !stat ? 'missing' : stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : null;
    if (!type) throw Object.assign(new Error('Unsupported evidence source entry'), { code: 'SOURCE_BINDING' });
    const descriptor = { id: entry.id, type, ...(stat ? { dev: stat.dev, ino: stat.ino, mode: stat.mode & 0o7777 } : {}) };
    if (type === 'file' && entry.sourceLocation !== 'presence' && !sensitive) {
      if (stat.nlink !== 1 || stat.size > 1024 * 1024) throw Object.assign(new Error('Evidence source is not a bounded unlinked file'), { code: 'SOURCE_BINDING' });
      const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.nlink !== 1 || opened.size > 1024 * 1024) {
          throw Object.assign(new Error('Evidence identity changed before binding'), { code: 'SOURCE_BINDING' });
        }
        const bytes = Buffer.allocUnsafe(1024 * 1024 + 1);
        let length = 0;
        while (length < bytes.length) {
          const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
          if (!bytesRead) break;
          length += bytesRead;
        }
        const after = await handle.stat();
        const final = await lstat(absolute);
        if (length > 1024 * 1024 || length !== stat.size || after.size !== stat.size
          || after.mode !== stat.mode || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs
          || final.dev !== stat.dev || final.ino !== stat.ino || await realpath(absolute) !== absolute) {
          throw Object.assign(new Error('Evidence changed during bounded controller binding'), { code: 'SOURCE_BINDING' });
        }
        descriptor.fingerprint = `sha256:${createHash('sha256').update(bytes.subarray(0, length)).digest('hex')}`;
      } finally {
        await handle.close();
      }
    }
    sources.push(descriptor);
  }
  const final = await assertCodexDirectory(root);
  if (final.dev !== identity.dev || final.ino !== identity.ino) {
    throw Object.assign(new Error('Original source root changed during controller binding'), { code: 'SOURCE_BINDING' });
  }
  return { repositoryRoot: root, fixtureDigest: digestProposal(fixture), identity: { dev: identity.dev, ino: identity.ino }, sources };
}
