const { realpathSync } = require('fs');

const cwd = process.cwd();
try {
  const real = realpathSync(cwd);
  if (real !== cwd) {
    console.error(
      '\x1b[31m\x1b[1m' +
      '\n╔══════════════════════════════════════════════════════════════════╗\n' +
      '║  FATAL: Symlink/junction path mismatch detected                ║\n' +
      '╚══════════════════════════════════════════════════════════════════╝\x1b[0m\n' +
      '\x1b[33m' +
      `  cwd:      ${cwd}\n` +
      `  realpath:  ${real}\n\n` +
      '  Next.js uses path.join() with the resolved realpath, which on Windows\n' +
      '  concatenates drive letters instead of treating them as absolute paths.\n' +
      '  This produces broken paths like:\n' +
      `    ${cwd}\\${real}\\.next\\...\n\n` +
      '\x1b[0m' +
      '  Related bugs:\n' +
      '    https://github.com/vercel/next.js/issues/67541\n' +
      '    https://github.com/vercel/next.js/issues/39670\n\n' +
      '\x1b[32m' +
      '  Fix: run from the real path instead:\n' +
      `    cd "${real}"\n` +
      '\x1b[0m'
    );
    process.exit(1);
  }
} catch {
  // ignore — realpathSync can fail on unusual mounts
}
