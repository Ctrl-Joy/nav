// Local Git smart-HTTP server for development & tests: publishes each folder in examples/ as a bare repo at
// http://localhost:9420/<name>.git (plus the whole examples tree as /examples.git) via `git http-backend`.
// Usage: node scripts/git-serve.ts [--port 9420]   — re-run to publish new commits of the example folders.
import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, cp } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';
import tar from 'tar-stream';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reposDir = path.join(root, '.nav', 'git');
const sdkDir = path.join(root, 'packages', 'workflows');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]) || 9420;
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'NAV Examples', GIT_AUTHOR_EMAIL: 'examples@nav.test', GIT_COMMITTER_NAME: 'NAV Examples', GIT_COMMITTER_EMAIL: 'examples@nav.test' };
const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, env: gitEnv, stdio: 'pipe' }).toString().trim();

/** packages/workflows as an npm package tarball (what `npm pack` would produce). */
export async function packWorkflowsSdk(file: string): Promise<void> {
  const pack = tar.pack();
  const pkg = JSON.parse(readFileSync(path.join(sdkDir, 'package.json'), 'utf8'));
  for (const f of ['package.json', ...(pkg.files as string[])]) pack.entry({ name: `package/${f}`, mode: 0o644, mtime: new Date(0) }, readFileSync(path.join(sdkDir, f)));
  pack.finalize();
  await mkdir(path.dirname(file), { recursive: true });
  await pipeline(pack, createGzip(), createWriteStream(file));
}

/**
 * The workflows SDK is not on a registry: an example whose package.json depends on `@nav/workflows` through a
 * `file:...tgz` path gets a freshly packed copy of packages/workflows there (installed as a regular package).
 */
export async function vendorWorkflowsSdk(dir: string): Promise<void> {
  const pkgFile = path.join(dir, 'package.json');
  if (!existsSync(pkgFile)) return;
  const spec = JSON.parse(readFileSync(pkgFile, 'utf8')).dependencies?.['@nav/workflows'];
  if (typeof spec !== 'string' || !spec.startsWith('file:') || !spec.endsWith('.tgz')) return;
  const dest = path.resolve(dir, spec.slice('file:'.length));
  if (!dest.startsWith(path.resolve(dir) + path.sep)) throw new Error(`${pkgFile}: @nav/workflows must point inside the example`);
  await packWorkflowsSdk(dest);
}

/** Mirrors `src` into the bare repo `name` under `dir`, committing only when content changed. */
export async function publish(name: string, src: string, message = 'Update', dir = reposDir): Promise<string> {
  const bare = path.join(dir, `${name}.git`);
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
    await vendorWorkflowsSdk(work);
    for (const e of readdirSync(work)) if (e !== '.git' && statSync(path.join(work, e)).isDirectory()) await vendorWorkflowsSdk(path.join(work, e));
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

/** Serves the bare repos in `dir` over Git smart-HTTP. */
export function createGitServer(dir = reposDir): http.Server {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname.includes('..')) { res.writeHead(400).end(); return; }
    const cgi = spawn('git', ['http-backend'], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: dir,
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
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await mkdir(reposDir, { recursive: true });
  console.log('Publishing example repositories:');
  await publishAll();
  createGitServer().listen(port, '127.0.0.1', () => console.log(`\nGit server on http://localhost:${port} (repos in ${reposDir})`));
}
