import { spawn } from 'node:child_process';

let proc = null;

export function isCaffeinated() {
  return Boolean(proc && proc.exitCode === null && !proc.killed);
}

/**
 * Hold the display awake with `caffeinate -d`.
 *
 * Spawned with `-w <our pid>` so it exits when this server does — otherwise a
 * hard kill of the app would leave the Mac permanently awake with no visible
 * cause and nothing left to switch it off.
 */
export function setCaffeinate(on) {
  if (on) {
    if (isCaffeinated()) return true;
    proc = spawn('/usr/bin/caffeinate', ['-d', '-w', String(process.pid)], {
      stdio: 'ignore',
      detached: false,
    });
    proc.on('exit', () => {
      proc = null;
    });
    proc.on('error', () => {
      proc = null;
    });
    return isCaffeinated();
  }

  if (proc) {
    try {
      proc.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    proc = null;
  }
  return false;
}
