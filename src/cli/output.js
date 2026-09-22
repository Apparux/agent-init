import path from 'node:path';

import { HARNESS_REGISTRY } from '../installation/harnesses.js';

function displayPath(value, homeDir) {
  if (!value) return '(not available)';
  if (value === homeDir) return '~';
  const relative = path.relative(homeDir, value);
  if (relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`)) {
    return `~/${relative.split(path.sep).join('/')}`;
  }
  return value;
}

function targetLabel(name) {
  return HARNESS_REGISTRY.find((entry) => entry.key === name)?.label ?? name;
}

export function renderSuccess(result, runtime) {
  const lines = [`Agent Init ${runtime.packageVersion}`, ''];
  if (result.operation === 'install') {
    if (result.outcome === 'already-installed') {
      lines.push('Already installed.', '');
    } else {
      lines.push(
        result.outcome === 'repaired' ? 'Installation repaired' : 'Installation',
        `  ✓ ${displayPath(result.paths.canonicalRoot, runtime.homeDir)}`,
        '',
      );
      for (const name of Object.keys(result.manifest.targets)) {
        const record = result.manifest.targets[name];
        lines.push(
          targetLabel(name),
          `  ✓ ${displayPath(record.path, runtime.homeDir)} (${record.mode})`,
          '',
        );
      }
    }
    lines.push('Ready.', '');
    const registry = result.paths.registry;
    const aliases = [...(result.paths.aliases ?? new Map()).values()].map((alias) => ({
      ...alias,
      key: registry.find((entry) => entry.skillsDir === alias.skillsDir)?.key,
    }));
    for (const entry of [...registry, ...aliases]) {
      if (!entry.invocation || !result.manifest.targets[entry.key]) continue;
      lines.push(entry.label, `  ${entry.invocation}`, '');
    }
    lines.push('Installation checked; live harness invocation not tested.');
  } else if (result.operation === 'update') {
    lines.push(
      result.outcome === 'already-up-to-date'
        ? 'Already up to date.'
        : `Updated ${result.previousVersion} → ${result.version}.`,
    );
  } else if (result.operation === 'doctor') {
    lines.push(
      'Version',
      `  Installed: ${result.installedVersion ?? 'Not installed'}`,
      `  Running:   ${runtime.packageVersion}`,
      '',
    );
    for (const check of result.checks) {
      lines.push(
        `${check.status === 'ok' ? '  ✓' : check.status === 'warning' ? '  •' : '  !'} ${check.message}`,
      );
    }
    lines.push('', 'Status', '  ✓ Healthy');
  } else if (result.operation === 'uninstall') {
    lines.push(
      result.outcome === 'already-uninstalled' ? 'Already uninstalled.' : 'Uninstalled.',
    );
    if (result.preserved?.length) {
      lines.push('', 'Preserved');
      for (const preserved of result.preserved) {
        lines.push(`  ! ${displayPath(preserved, runtime.homeDir)}`);
      }
    }
  } else if (result.operation === 'harnesses') {
    lines.push(
      'Harnesses',
      `  Installed: ${result.installedVersion ?? 'Not installed'}`,
      '  documented = official discovery documentation, not live acceptance.',
      '  Installation state is checked on disk; alias/unregistered describe registry membership.',
      '',
    );
    for (const harness of result.harnesses) {
      const state = harness.installed
        ? `✓ ${harness.mode ?? 'installed'}`
        : harness.status === 'missing'
          ? 'not installed'
          : `! ${harness.status}`;
      lines.push(
        `${harness.label} (${harness.key})`,
        `  ${state} · ${displayPath(harness.path, runtime.homeDir)}`,
        `  verification: ${harness.verification}`,
      );
      if (harness.invocation) {
        lines.push(`  invoke: ${harness.invocation}`);
      }
      lines.push('');
    }
  }
  return `${lines.join('\n')}\n`;
}

export function renderFailure(result, runtime) {
  if (result.operation === 'doctor' && Array.isArray(result.checks)) {
    const lines = [
      `Agent Init ${runtime.packageVersion}`,
      '',
      'Doctor found problems:',
    ];
    for (const check of result.checks.filter((item) => item.status === 'error')) {
      lines.push(
        `  ${check.code}: ${check.message}`,
        `  Path: ${displayPath(check.path, runtime.homeDir)}`,
        `  Next: ${check.remediation}`,
      );
    }
    lines.push('', 'Status', '  ! Unhealthy');
    return `${lines.join('\n')}\n`;
  }

  const error = result.error;
  const displayList = (entries, empty) =>
    entries?.length
      ? entries.map((entry) => displayPath(entry, runtime.homeDir)).join(', ')
      : empty;
  return [
    `Agent Init ${runtime.packageVersion}`,
    '',
    `Error [${error.code}]: ${error.message}`,
    `Path: ${displayPath(error.path, runtime.homeDir)}`,
    'Why stopped: continuing could overwrite or delete data without sufficient ownership evidence.',
    `Changed: ${displayList(error.changed, 'none reported')}`,
    `Preserved: ${displayList(error.preserved, 'none reported')}`,
    `Unresolved: ${displayList(error.unresolved, 'none reported')}`,
    `Next: ${error.remediation}`,
    '',
  ].join('\n');
}
