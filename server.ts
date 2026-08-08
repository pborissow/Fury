import { createServer } from 'node:http';
import { parse } from 'node:url';
import next from 'next';
import { assertRealCwd } from './lib/checkSymlink';
import { installProcessGuards, isBenignClientAbort } from './lib/processGuards';
import { log } from './lib/logger';

// Preflight: abort with a helpful message if cwd is a symlink/junction, before
// next() builds any .next path (was the scripts/check-symlink.js predev/prestart
// hook — now core startup, so nothing in scripts/ is required to run).
assertRealCwd();

// Armed before anything else loads: an aborted client request used to reach the
// process as an uncaughtException and kill every live session with it.
// docs/ticket-server-crash-on-aborted-request.md.
installProcessGuards();

const dev = process.env.NODE_ENV !== 'production';
const hostname = '0.0.0.0';
const port = parseInt(process.env.PORT || '3879', 10);

const app = next({ dev, hostname, port });

/**
 * Handle the stream `'error'` at the source. A client that disconnects
 * mid-response (navigating away from the `/api/events` SSE stream, aborting a
 * fetch, closing a tab during TTS playback) makes Node emit `'error'` on the
 * request/response stream; with no listener it escalates to an
 * uncaughtException. Nothing is left to do for the request either way, so this
 * absorbs the abort locally and only the process guard's log survives.
 */
function absorbStreamErrors(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
) {
  const onError = (what: string) => (err: NodeJS.ErrnoException) => {
    if (isBenignClientAbort(err)) {
      log.debug('server.stream', `${what} aborted by client`, { data: { url: req.url } });
      return;
    }
    log.warn('server.stream', `${what} error`, {
      data: { url: req.url, code: err.code, message: err.message },
    });
  };
  req.on('error', onError('request'));
  res.on('error', onError('response'));
}

function injectConnectionIp(req: import('node:http').IncomingMessage) {
  // Strip client-supplied forwarding headers — they cannot be trusted
  // in standalone mode (no reverse proxy). Replace with the real
  // connection-level IP from the TCP socket.
  const remoteAddress = req.socket.remoteAddress || '';
  delete req.headers['x-forwarded-for'];
  delete req.headers['x-real-ip'];
  req.headers['x-forwarded-for'] = remoteAddress;
}

app.prepare().then(() => {
  const handle = app.getRequestHandler();
  const upgrade = app.getUpgradeHandler();

  const server = createServer((req, res) => {
    absorbStreamErrors(req, res);
    injectConnectionIp(req);
    const parsedUrl = parse(req.url || '/', true);
    handle(req, res, parsedUrl);
  });

  // Forward WebSocket upgrades (needed for HMR in dev mode)
  server.on('upgrade', (req, socket, head) => {
    // A dev-mode HMR socket dropped by a closing tab emits ECONNRESET here for
    // the same reason ordinary requests do.
    socket.on('error', (err: NodeJS.ErrnoException) => {
      if (isBenignClientAbort(err)) return;
      log.warn('server.stream', 'upgrade socket error', { data: { code: err.code, message: err.message } });
    });
    injectConnectionIp(req);
    upgrade(req, socket, head);
  });

  // The process guard deliberately never exits, so a failure to bind would
  // otherwise leave a live-but-deaf process. Bind errors are genuinely fatal.
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
      console.error(`[server] Cannot listen on ${hostname}:${port} — ${err.code}`);
      process.exit(1);
    }
    log.error('server', 'http server error', { data: { code: err.code, message: err.message } });
  });

  server.listen(port, hostname, async () => {
    console.log(`> Ready on http://localhost:${port} (${dev ? 'development' : 'production'})`);

    // Rehydrate any pending Anthropic switch-back from the durable
    // fallback log. This recovers the auto-failover scheduler across
    // server restarts, deploys, and crashes — without it, a process
    // restart between the failover firing and the reset time leaves
    // the user parked on Bedrock indefinitely.
    try {
      const { rehydrateSwitchBackTimer } = await import('./lib/providerSwitch');
      await rehydrateSwitchBackTimer();
    } catch (err) {
      console.error('[server] Failed to rehydrate provider switch-back timer:', err);
    }

    // Start the pricing poller, calibrated from the last recorded check so a
    // restart continues the weekly cadence rather than resetting it.
    try {
      const { rehydratePricingPoller } = await import('./lib/pricingPoller');
      await rehydratePricingPoller();
    } catch (err) {
      console.error('[server] Failed to start pricing poller:', err);
    }

    // Start the model-catalog poller (GET /v1/models via the CLI's OAuth token),
    // calibrated from the last recorded refresh so a restart continues the weekly
    // cadence. Feeds the model picker's per-family version dropdowns.
    try {
      const { rehydrateModelCatalogPoller } = await import('./lib/modelCatalog');
      await rehydrateModelCatalogPoller();
    } catch (err) {
      console.error('[server] Failed to start model-catalog poller:', err);
    }

    // Reap SDK session processes left over from a previous server life. Unlike
    // the state above, SDK sessions can't be rehydrated: the manager is pure
    // in-memory and the SDK offers no way to re-attach to a running CLI. But the
    // processes outlive us (a dying parent doesn't take its children with it),
    // so after a crash/hard-restart they linger as zombies — reported Live by
    // the PID scanner, yet with no dots/stream/buffer because the fresh manager
    // has no record. Killing them makes the UI honest and stops the token burn.
    try {
      const { sdkSessionManager } = await import('./lib/sdkSessionManager');
      const reaped = await sdkSessionManager.reapOrphanedProcesses();
      if (reaped > 0) {
        console.log(`[server] Reaped ${reaped} orphaned SDK session process(es) from a previous run`);
      }
    } catch (err) {
      console.error('[server] Failed to reap orphaned SDK sessions:', err);
    }
  });

  // Tear down live SDK sessions on the way out so a graceful restart doesn't
  // orphan them in the first place (the boot reap above is the backstop for
  // SIGKILL/crash, which skips this).
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      const { sdkSessionManager } = await import('./lib/sdkSessionManager');
      const killed = await sdkSessionManager.killAll();
      if (killed > 0) console.log(`[server] ${signal}: killed ${killed} SDK session process(es)`);
      const { codemoggerReindexer } = await import('./lib/codemoggerReindex');
      codemoggerReindexer.stopAll();
    } catch (err) {
      console.error('[server] Shutdown cleanup failed:', err);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
});
