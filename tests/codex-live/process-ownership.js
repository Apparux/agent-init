// Called only with children spawned by the Codex runner or its owned package installation.
export function ownedGroupAbsent(child) {
  if (!child.pid) return true;
  try {
    process.kill(process.platform === 'win32' ? child.pid : -child.pid, 0);
    return false;
  } catch (cause) {
    if (cause.code === 'ESRCH') return true;
    throw cause;
  }
}

export function signalOwnedGroup(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal);
  } catch (cause) {
    // Exiting between the group check and signal is successful cleanup, not an uncaught race.
    if (cause.code !== 'ESRCH') throw cause;
  }
}
