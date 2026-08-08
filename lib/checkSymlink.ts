import { realpathSync } from 'node:fs';

/**
 * Fail fast if the process is running from a symlink/junction whose realpath
 * differs from cwd.
 *
 * Next.js resolves paths against the realpath, which on Windows concatenates
 * drive letters instead of treating them as absolute — producing broken paths
 * like `<cwd>\<real>\.next\...`. This is a preflight guard, not setup: on a
 * normal checkout it's a no-op.
 *
 * Called at the top of server.ts (the dev/start entrypoint, `npx tsx server.ts`)
 * before `next()` builds any .next path. Previously scripts/check-symlink.js run
 * as a predev/prestart hook — moved here because it's core startup, not a dev
 * tool, so nothing in scripts/ is required to run the app.
 *
 * Refs: https://github.com/vercel/next.js/issues/67541
 *       https://github.com/vercel/next.js/issues/39670
 */
export function assertRealCwd(): void {
  const cwd = process.cwd();
  let real: string;
  try {
    real = realpathSync(cwd);
  } catch {
    return; // realpathSync can fail on unusual mounts — don't block startup
  }
  if (real === cwd) return;

  console.error(
    '\x1b[31m\x1b[1m' +
    '\n╔════════════════════════════════════════════════════════════════════╗\n' +
    '║  FATAL: Symlink/junction path mismatch detected                    ║\n' +
    '╚════════════════════════════════════════════════════════════════════╝\x1b[0m\n' +
    '\x1b[33m' +
    `  cwd:      ${cwd}\n` +
    `  realpath: ${real}\n\n` +
    '  Next.js resolves paths against the realpath, which on Windows concatenates\n' +
    '  drive letters instead of treating them as absolute — producing broken\n' +
    `  paths like ${cwd}\\${real}\\.next\\...\n\n` +
    '\x1b[0m' +
    '  Fix: run from the real path instead:\n' +
    `    cd "${real}"\n` +
    '\x1b[0m'
  );
  process.exit(1);
}

