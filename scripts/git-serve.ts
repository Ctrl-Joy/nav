// Local Git smart-HTTP server for development & tests: publishes each folder in examples/ as a bare repo at
// http://localhost:9420/<name>.git (plus the whole examples tree as /examples.git) via `git http-backend`.
// Usage: node scripts/git-serve.ts [--port 9420]   — re-run to publish new commits of the example folders.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, cp } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reposDir = path.join(root, '.nav', 'git');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]) || 9420;
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'NAV Examples', GIT_AUTHOR_EMAIL: 'examples@nav.test', GIT_COMMITTER_NAME: 'NAV Examples', GIT_COMMITTER_EMAIL: 'examples@nav.test' };
const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, env: gitEnv, stdio: 'pipe' }).toString().trim();

/** Mirrors `src` into the bare repo `name`, committing only when content changed. */
export async function publish(name: string, src: string, message = 'Update'): Promise<string> {
  const bare = path.join(reposDir, `${name}.git`);
  if (!existsSync(bare)) {
    await mkdir(bare, { recursive: true });
    git(['init', '--bare', '-q', '-b', 'main'], bare);
    git(['config', 'http.receivepack', 'true'], bare);
  }
  const work = await mkdtemp(path.join(os.tmpdir(), 'nav-git-'));
  try {
    git(['clone', '-q', bare, '.'], work);
    for (const e of readdirSync(work)) if (e !== '.git') await rm(path.join(work, e), { recursive: true, force: true });
    await cp(src, work, { recursive: true, filter: (p) => !p.includes(`${path.sep}node_modules`) });
    git(['add', '-A'], work);
    const dirty = git(['status', '--porcelain'], work);
    if (dirty) {
      git(['-c', 'init.defaultBranch=main', 'commit', '-q', '-m', message], work);
      git(['push', '-q', 'origin', 'HEAD:main'], work);
    }
    return git(['rev-parse', 'HEAD'], work);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function publishAll(): Promise<void> {
  const ex = path.join(root, 'examples');
  for (const d of readdirSync(ex)) {
    if (statSync(path.join(ex, d)).isDirectory()) console.log(`  ${d.padEnd(14)} ${(await publish(d, path.join(ex, d))).slice(0, 7)}  http://localhost:${port}/${d}.git`);
  }
  console.log(`  ${'examples'.padEnd(14)} ${(await publish('examples', ex)).slice(0, 7)}  http://localhost:${port}/examples.git`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await mkdir(reposDir, { recursive: true });
  console.log('Publishing example repositories:');
  await publishAll();
  http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname.includes('..')) { res.writeHead(400).end(); return; }
    const cgi = spawn('git', ['http-backend'], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: reposDir,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: decodeURIComponent(url.pathname),
        REQUEST_METHOD: req.method,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        HTTP_CONTENT_ENCODING: req.headers['content-encoding'] ?? '',
        GIT_PROTOCOL: (req.headers['git-protocol'] as string) ?? '',
        REMOTE_ADDR: req.socket.remoteAddress ?? '',
      },
    });
    req.pipe(cgi.stdin);
    let head = Buffer.alloc(0);
    let headersDone = false;
    cgi.stdout.on('data', (chunk: Buffer) => {
      if (headersDone) return void res.write(chunk);
      head = Buffer.concat([head, chunk]);
      const idx = head.indexOf('\r\n\r\n');
      if (idx < 0) return;
      headersDone = true;
      let status = 200;
      for (const line of head.subarray(0, idx).toString().split('\r\n')) {
        const [k, ...v] = line.split(':');
        if (k.toLowerCase() === 'status') status = Number.parseInt(v.join(':'));
        else res.setHeader(k, v.join(':').trim());
      }
      res.writeHead(status);
      res.write(head.subarray(idx + 4));
    });
    cgi.stdout.on('end', () => res.end());
    cgi.stderr.on('data', (d) => process.stderr.write(d));
  }).listen(port, '127.0.0.1', () => console.log(`\nGit server on http://localhost:${port} (repos in ${reposDir})`));
}
