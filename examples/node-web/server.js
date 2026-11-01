const http = require('node:http');
const fs = require('node:fs');

const port = Number(process.env.PORT || 3000);
const info = fs.existsSync('build-info.json') ? JSON.parse(fs.readFileSync('build-info.json', 'utf8')) : {};
let hits = 0;

const server = http.createServer((req, res) => {
  hits++;
  if (req.url === '/healthz') return res.end('ok');
  if (req.url === '/crash') { res.end('crashing'); setTimeout(() => process.exit(3), 50); return; }
  if (req.url === '/burn') { const end = Date.now() + 2000; while (Date.now() < end); return res.end('burned'); }
  // Cacheable at the edge: the counter only moves when the edge forwards the request.
  if (req.url === '/cached') {
    res.setHeader('cache-control', 'public, max-age=60');
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ hits }));
  }
  // Persistent disk: read or write a file at NAV_DISK_PATH.
  if (req.url.startsWith('/disk')) {
    const f = `${process.env.NAV_DISK_PATH || '/data'}/note.txt`;
    const value = new URL(req.url, 'http://x').searchParams.get('write');
    if (value !== null) fs.writeFileSync(f, value);
    return res.end(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
  }
  if (req.url === '/secret') {
    const dir = process.env.NAV_SECRETS_DIR || '/etc/secrets';
    const f = `${dir}/app.conf`;
    return res.end(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : 'no secret file');
  }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({
    message: process.env.GREETING || 'Hello from NAV',
    instance: process.env.NAV_INSTANCE_ID,
    service: process.env.NAV_SERVICE_NAME,
    commit: process.env.NAV_GIT_COMMIT,
    build: info,
    hits,
    leakedMasterKey: Boolean(process.env.NAV_MASTER_KEY),
    leakedDatabaseUrl: Boolean(process.env.NAV_DATABASE_URL),
  }));
});
server.listen(port, '0.0.0.0', () => console.log(`listening on ${port}`));
process.on('SIGTERM', () => { console.log('SIGTERM received, closing'); server.close(() => process.exit(0)); });
