import { exec } from 'child_process';
import { ChildProcess } from 'child_process';

/**
 * Kill a process and all its descendants.
 *
 * On Windows: uses `taskkill /T /F /PID` to kill the entire tree.
 *
 * On macOS/Linux: the child MUST have been spawned with `detached: true`
 * so it has its own process group. We send SIGTERM to the entire group
 * via `process.kill(-pid)`, then force-kill stragglers after a short
 * grace period.
 */
export function killProcessTree(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    const pid = child.pid;
    if (!pid) {
      // Process never started or already exited
      resolve();
      return;
    }

    if (process.platform === 'win32') {
      // taskkill /T kills the entire process tree, /F forces termination
      exec(`taskkill /T /F /PID ${pid}`, (err) => {
        if (err) {
          // Process may have already exited — that's fine
          console.warn(`[killProcessTree] taskkill failed (may already be dead): ${err.message}`);
        }
        resolve();
      });
    } else {
      // macOS / Linux: the child was spawned with detached:true, so it
      // leads its own process group. Kill the entire group with -pid.
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        // ESRCH = no such process group — already dead
      }

      // Give processes a moment to exit gracefully, then force-kill
      // any stragglers in the group.
      setTimeout(() => {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* already dead */ }
        resolve();
      }, 500);
    }
  });
}
