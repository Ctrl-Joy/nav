// Runtime detection for native (non-Docker) builds, buildpack-style.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export type NativeRuntime = 'node' | 'bun' | 'python' | 'go' | 'ruby' | 'static';

export interface Detected {
  runtime: NativeRuntime | 'docker';
  buildCommand: string | null;
  startCommand: string | null;
  notes: string[];
}

async function procfileWeb(dir: string): Promise<string | null> {
  const p = path.join(dir, 'Procfile');
  if (!existsSync(p)) return null;
  const line = (await readFile(p, 'utf8')).split(/\r?\n/).find((l) => /^web:\s*/.test(l));
  return line ? line.replace(/^web:\s*/, '').trim() : null;
}

export async function detect(dir: string, requested: string, serviceType: string): Promise<Detected> {
  const has = (f: string) => existsSync(path.join(dir, f));
  const notes: string[] = [];
  let runtime: Detected['runtime'];

  if (requested === 'docker' || (requested === 'auto' && has('Dockerfile') && !has('package.json') && !has('requirements.txt'))) runtime = 'docker';
  else if (requested !== 'auto' && requested !== 'image') runtime = requested as NativeRuntime;
  else if (has('bun.lockb') || has('bun.lock')) runtime = 'bun';
  else if (has('package.json')) runtime = 'node';
  else if (has('requirements.txt') || has('pyproject.toml') || has('Pipfile')) runtime = 'python';
  else if (has('go.mod')) runtime = 'go';
  else if (has('Gemfile')) runtime = 'ruby';
  else if (serviceType === 'static' || has('index.html')) runtime = 'static';
  else throw new Error('could not detect a runtime: add a package.json, requirements.txt, go.mod, Gemfile or Dockerfile, or set the runtime explicitly');

  let build: string | null = null;
  let start: string | null = await procfileWeb(dir);
  if (start) notes.push('using start command from Procfile');

  switch (runtime) {
    case 'node': {
      const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8').catch(() => '{}'));
      const scripts = pkg.scripts ?? {};
      const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : 'npm';
      const install = pm === 'pnpm' ? 'corepack pnpm install --frozen-lockfile' : pm === 'yarn' ? 'corepack yarn install --frozen-lockfile' : has('package-lock.json') ? 'npm ci' : 'npm install';
      build = scripts.build ? `${install} && ${pm === 'npm' ? 'npm run' : pm} build` : install;
      start ??= scripts.start ? `${pm === 'npm' ? 'npm' : pm} start` : pkg.main ? `node ${pkg.main}` : has('server.js') ? 'node server.js' : has('index.js') ? 'node index.js' : null;
      break;
    }
    case 'bun':
      build = 'bun install';
      start ??= 'bun start';
      break;
    case 'python': {
      const venvBin = process.platform === 'win32' ? '.venv\\Scripts' : '.venv/bin';
      const py = process.platform === 'win32' ? 'python' : 'python3';
      const req = has('requirements.txt') ? `${venvBin}${path.sep}pip install -r requirements.txt` : `${venvBin}${path.sep}pip install .`;
      build = `${py} -m venv .venv && ${req}`;
      start ??= has('manage.py') ? 'gunicorn wsgi:application' : has('app.py') ? 'gunicorn app:app' : has('main.py') ? 'python main.py' : null;
      break;
    }
    case 'go':
      build = `go build -o ${process.platform === 'win32' ? 'app.exe' : 'app'} .`;
      start ??= process.platform === 'win32' ? 'app.exe' : './app';
      break;
    case 'ruby':
      build = 'bundle install';
      start ??= has('config.ru') ? 'bundle exec puma -p $PORT' : null;
      break;
    case 'static':
    case 'docker':
      break;
  }
  return { runtime, buildCommand: build, startCommand: start, notes };
}

export async function publishDir(appDir: string, configured: string | null): Promise<string> {
  if (configured) {
    const p = path.resolve(appDir, configured);
    if (!p.startsWith(path.resolve(appDir))) throw new Error('publish path must be inside the repository');
    if (!existsSync(p)) throw new Error(`publish directory "${configured}" does not exist after build`);
    return p;
  }
  for (const c of ['dist', 'build', 'out', 'public', '_site']) {
    if (existsSync(path.join(appDir, c, 'index.html'))) return path.join(appDir, c);
  }
  if (existsSync(path.join(appDir, 'index.html'))) return appDir;
  throw new Error('could not find a publish directory (looked for dist, build, out, public, _site); set the publish path');
}
