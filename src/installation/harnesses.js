import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { InstallationError } from './paths.js';

// Ordered registry of built-in harnesses. The array order is the single
// source of truth for install order, LIFO cleanup order, and doctor/output
// ordering; manifest key order never encodes it (serializeJson sorts keys).
// `codex` stays first so existing order-dependent tests keep their meaning.
export const HARNESS_REGISTRY = Object.freeze([
  Object.freeze({
    key: 'codex',
    label: 'Codex',
    skillsDir: '.agents/skills',
    invocation: '$agent-init',
    verification: 'documented',
  }),
  Object.freeze({
    key: 'claude',
    label: 'Claude Code',
    skillsDir: '.claude/skills',
    invocation: '/agent-init',
    verification: 'documented',
  }),
  Object.freeze({
    key: 'cursor',
    label: 'Cursor',
    skillsDir: '.cursor/skills',
    invocation: 'In Agent chat, type / and select agent-init',
    verification: 'documented',
  }),
  Object.freeze({
    key: 'opencode',
    label: 'OpenCode',
    skillsDir: '.config/opencode/skills',
    invocation: 'Ask the agent to load agent-init using its native skill tool',
    verification: 'documented',
  }),
  Object.freeze({
    key: 'pi',
    label: 'Pi',
    skillsDir: '.pi/agent/skills',
    invocation: '/skill:agent-init (with skill commands enabled)',
    verification: 'documented',
  }),
  Object.freeze({
    key: 'grok',
    label: 'Grok Build',
    skillsDir: '.grok/skills',
    invocation: '/agent-init',
    verification: 'documented',
  }),
]);

const HARNESS_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const HARNESS_CONFIG_DIR = '.config/agent-init';
const HARNESS_CONFIG_FILENAME = 'harnesses.json';

function configError(detail) {
  return new InstallationError(
    'INVALID_HARNESSES_CONFIG',
    `Invalid harnesses config: ${detail}`,
    {
      path: `${HARNESS_CONFIG_DIR}/${HARNESS_CONFIG_FILENAME}`,
      remediation: `Fix ${HARNESS_CONFIG_DIR}/${HARNESS_CONFIG_FILENAME} or remove it to use the built-in harness registry only.`,
    },
  );
}

function parseSkillsDir(value, fieldOf) {
  if (typeof value !== 'string' || value.length === 0) {
    throw configError(`${fieldOf} skillsDir must be a non-empty string`);
  }
  if (path.isAbsolute(value) || value.startsWith('~')) {
    throw configError(`${fieldOf} skillsDir must be relative to HOME: ${value}`);
  }
  const normalized = path.posix.normalize(value.split(path.sep).join('/'));
  if (
    normalized === '' ||
    normalized === '.' ||
    normalized.startsWith(`../`) ||
    normalized === '..' ||
    normalized.includes('\\')
  ) {
    throw configError(`${fieldOf} skillsDir must stay inside HOME: ${value}`);
  }
  return normalized;
}

// Resolves the effective harness registry for a HOME: the built-in registry
// plus any user-provided harnesses from ~/.config/agent-init/harnesses.json. A
// custom harness whose skillsDir resolves to an already-registered directory
// becomes an alias of that directory's target instead of a separate target.
export async function loadHarnessRegistry(homeDir) {
  const entries = HARNESS_REGISTRY.map((entry) => ({ ...entry }));

  const configPath = path.join(homeDir, ...HARNESS_CONFIG_DIR.split('/'), HARNESS_CONFIG_FILENAME);
  let raw;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw new InstallationError(
        'INVALID_HARNESSES_CONFIG',
        `Harnesses config cannot be read: ${configPath}`,
        { path: configPath, cause: error, remediation: 'Fix the config file permissions or content.' },
      );
    }
    return { entries, aliases: new Map() };
  }

  let config;
  try {
    config = JSON.parse(raw);
  } catch (error) {
    throw configError(`not valid JSON (${error.message})`);
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw configError('root must be a JSON object');
  }
  if (config.schemaVersion !== 1) {
    throw configError(`unsupported schemaVersion: ${String(config.schemaVersion)}`);
  }
  if (!Array.isArray(config.harnesses)) {
    throw configError('"harnesses" must be an array');
  }

  const aliases = new Map();
  const seenIds = new Set(entries.map((entry) => entry.key));
  const seenDirs = new Set(entries.map((entry) => entry.skillsDir));

  for (const [index, rawEntry] of config.harnesses.entries()) {
    const fieldOf = `harnesses[${index}]`;
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
      throw configError(`${fieldOf} must be an object`);
    }
    const id = rawEntry.id;
    if (typeof id !== 'string' || !HARNESS_ID_PATTERN.test(id)) {
      throw configError(
        `${fieldOf} id must match ${HARNESS_ID_PATTERN.source}: ${String(id)}`,
      );
    }
    if (seenIds.has(id)) {
      throw configError(`${fieldOf} id conflicts with an existing harness: ${id}`);
    }
    const label =
      typeof rawEntry.label === 'string' && rawEntry.label.trim().length > 0
        ? rawEntry.label.trim()
        : id;
    const skillsDir = parseSkillsDir(rawEntry.skillsDir, fieldOf);
    const invocation =
      typeof rawEntry.invocation === 'string' && rawEntry.invocation.length > 0
        ? rawEntry.invocation
        : null;
    seenIds.add(id);

    if (seenDirs.has(skillsDir)) {
      aliases.set(id, { skillsDir, label, invocation });
      continue;
    }
    seenDirs.add(skillsDir);
    entries.push({
      key: id,
      label,
      skillsDir,
      invocation,
      verification: 'unverified',
    });
  }

  return { entries, aliases };
}
