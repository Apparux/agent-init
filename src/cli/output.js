import path from 'node:path';

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
  return name === 'claude' ? 'Claude Code' : 'Codex';
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
      for (const name of ['codex', 'claude']) {
        const record = result.manifest.targets[name];
        lines.push(
          targetLabel(name),
          `  ✓ ${displayPath(record.path, runtime.homeDir)} (${record.mode})`,
          '',
        );
      }
    }
    lines.push('Ready.', '', 'Claude Code:', '  /project-setup', '', 'Codex:', '  $project-setup');
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
      lines.push(`${check.status === 'ok' ? '  ✓' : '  !'} ${check.message}`);
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
