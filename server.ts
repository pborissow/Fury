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

  server.listen(port, hostname, () => {
    console.log(`> Ready on http://localhost:${port} (${dev ? 'development' : 'production'})`);
  });
});
