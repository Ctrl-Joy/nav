// Starter templates for the Templates gallery. Each is a Git repository with a `nav.yaml` at its root, deployed
// through the same review screen as the "Deploy to NAV" button. By default they point at the example repositories
// served locally by `node scripts/git-serve.ts`; set VITE_NAV_TEMPLATES_BASE (e.g. a GitHub org URL) to use your own.

export interface Template {
  id: string;
  name: string;
  description: string;
  repoUrl: string;
  /** Short label of the stack, shown as tags. */
  tags: string[];
  /** Brand-ish color of the logo tile, and its text (one or two letters). */
  logo: { text: string; color: string };
}

const BASE = ((import.meta.env.VITE_NAV_TEMPLATES_BASE as string | undefined) ?? 'http://localhost:9420').replace(/\/+$/, '');
const repo = (name: string) => `${BASE}/${name}.git`;

export const TEMPLATES: Template[] = [
  {
    id: 'node-web',
    name: 'Node web service',
    description: 'A dependency-free Node.js HTTP server with a health check, ready to extend into an API or app.',
    repoUrl: repo('node-web'),
    tags: ['Node.js', 'Web service'],
    logo: { text: 'JS', color: '#3c873a' },
  },
  {
    id: 'python-flask',
    name: 'Python Flask',
    description: 'A Flask app served by gunicorn, installed from requirements.txt.',
    repoUrl: repo('python-flask'),
    tags: ['Python', 'Flask', 'Web service'],
    logo: { text: 'Py', color: '#3572a5' },
  },
  {
    id: 'go-api',
    name: 'Go API',
    description: 'A small JSON API on the Go standard library, compiled into a single binary.',
    repoUrl: repo('go-api'),
    tags: ['Go', 'Web service'],
    logo: { text: 'Go', color: '#00acd7' },
  },
  {
    id: 'static-site',
    name: 'Static site',
    description: 'A site built into dist/ and served from the edge with hashed-asset caching.',
    repoUrl: repo('static-site'),
    tags: ['Static site'],
    logo: { text: 'S', color: '#e34c26' },
  },
  {
    id: 'full-stack',
    name: 'Postgres + web + worker',
    description: 'A blueprint stack: a web service and a worker sharing a Postgres database, an env group and a cron job.',
    repoUrl: repo('examples'),
    tags: ['Blueprint', 'Postgres', 'Worker', 'Cron'],
    logo: { text: 'PG', color: '#336791' },
  },
];

/** `github.com/acme/app` / `localhost:9420/node-web` — a repository URL without scheme and `.git`. */
export function repoLabel(url: string): string {
  return url.replace(/^[a-z+]+:\/\//i, '').replace(/\.git$/, '').replace(/\/+$/, '');
}

/** The dashboard path that reviews and deploys a repository's blueprint ("Deploy to NAV"). */
export function deployPath(repoUrl: string, branch?: string): string {
  const q = new URLSearchParams({ repo: repoUrl });
  if (branch) q.set('branch', branch);
  return `/deploy?${q.toString()}`;
}
