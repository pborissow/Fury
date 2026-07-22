import { createServer } from 'node:http';
import { parse } from 'node:url';
import next from 'next';

const dev = process.env.NODE_ENV !== 'production';
const hostname = '0.0.0.0';
const port = parseInt(process.env.PORT || '3879', 10);

const app = next({ dev, hostname, port });

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
    injectConnectionIp(req);
    const parsedUrl = parse(req.url || '/', true);
    handle(req, res, parsedUrl);
  });

  // Forward WebSocket upgrades (needed for HMR in dev mode)
  server.on('upgrade', (req, socket, head) => {
    injectConnectionIp(req);
    upgrade(req, socket, head);
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
    } catch (err) {
      console.error('[server] Shutdown cleanup failed:', err);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
});
