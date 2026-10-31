import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { Github } from '@/components/GithubIcon';
import { GITHUB_LOGIN_URL, useConfig, useLogin, useMe, useSignup } from '@/api/auth';
import { errorMessage } from '@/api/client';
import { Logo } from '@/components/Logo';
import { Button, Field, Input } from '@/components/ui';
import { FullPageSpinner } from '@/layouts/RootLayout';
import { useTitle } from '@/lib/useTitle';

/** Only allow same-origin, in-app redirect targets. */
function safeNext(next: string | null): string | null {
  if (!next || !next.startsWith('/') || next.startsWith('//')) return null;
  return next;
}

function AuthShell({ title, subtitle, children, footer }: { title: string; subtitle: ReactNode; children: ReactNode; footer: ReactNode }) {
  return (
    <div data-theme="dark" className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-bg px-4 py-10 text-fg">
      {/* Silver horizon glow, echoing the landing hero */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[60vh] bg-[radial-gradient(45%_50%_at_25%_0%,rgb(255_226_178/0.12),transparent_70%),radial-gradient(45%_50%_at_75%_0%,rgb(150_196_244/0.14),transparent_70%)]" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[40vh] bg-[radial-gradient(60%_60%_at_50%_100%,rgb(60_90_150/0.18),transparent_70%)]" />
      <div className="relative w-full max-w-sm">
        <Link to="/" className="mb-8 flex justify-center rounded-md">
          <Logo markClassName="size-7" />
        </Link>
        <div className="nv-panel rounded-[20px] p-6">
          <h1 className="text-[22px] font-normal tracking-[-0.02em]">{title}</h1>
          <p className="mt-1 text-[13px] text-fg-muted">{subtitle}</p>
          <div className="mt-6">{children}</div>
        </div>
        <p className="mt-6 text-center text-[13px] text-fg-muted">{footer}</p>
      </div>
    </div>
  );
}

function GithubButton() {
  const config = useConfig();
  if (!config.data?.githubEnabled) return null;
  return (
    <>
      <a
        href={GITHUB_LOGIN_URL}
        className="nv-btn nv-hair flex h-10 w-full items-center justify-center gap-2 text-[13px]"
      >
        <Github className="size-4" /> Continue with GitHub
      </a>
      <div className="my-5 flex items-center gap-3 text-[11px] tracking-wider text-fg-subtle uppercase">
        <span className="h-px flex-1 bg-border" /> or <span className="h-px flex-1 bg-border" />
      </div>
    </>
  );
}

export function LoginPage() {
  useTitle('Log in');
  const me = useMe();
  const login = useLogin();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  if (me.isPending) return <FullPageSpinner />;
  if (me.data) return <Navigate to={next ?? '/app'} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await login.mutateAsync({ email: email.trim(), password });
      navigate(next ?? '/app', { replace: true });
    } catch {
      /* rendered below */
    }
  };

  return (
    <AuthShell
      title="Welcome back"
      subtitle="Log in to your NAV workspace."
      footer={
        <>
          New to NAV?{' '}
          <Link to={`/signup${next ? `?next=${encodeURIComponent(next)}` : ''}`} className="font-medium text-accent hover:underline">
            Create an account
          </Link>
        </>
      }
    >
      <GithubButton />
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field label="Email">
          {(id) => <Input id={id} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" autoFocus />}
        </Field>
        <Field label="Password">
          {(id) => <Input id={id} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />}
        </Field>
        {login.isError && (
          <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger">
            {errorMessage(login.error)}
          </p>
        )}
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={login.isPending} disabled={!email || !password}>
          Log in
        </Button>
      </form>
    </AuthShell>
  );
}

export function SignupPage() {
  useTitle('Sign up');
  const me = useMe();
  const signup = useSignup();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [touched, setTouched] = useState(false);

  if (me.isPending) return <FullPageSpinner />;
  if (me.data && !signup.isSuccess) return <Navigate to={next ?? '/app'} replace />;

  const pwError = touched && password.length > 0 && password.length < 8 ? 'Use at least 8 characters.' : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (password.length < 8) return;
    try {
      const res = await signup.mutateAsync({ name: name.trim(), email: email.trim(), password });
      const ws = res.workspaces[0];
      navigate(next ?? (ws ? `/w/${ws.id}/get-started` : '/app'), { replace: true });
    } catch {
      /* rendered below */
    }
  };

  return (
    <AuthShell
      title="Create your NAV account"
      subtitle="Deploy your first service in minutes. No credit card."
      footer={
        <>
          Already have an account?{' '}
          <Link to={`/login${next ? `?next=${encodeURIComponent(next)}` : ''}`} className="font-medium text-accent hover:underline">
            Log in
          </Link>
        </>
      }
    >
      <GithubButton />
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field label="Name">{(id) => <Input id={id} autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada Lovelace" autoFocus />}</Field>
        <Field label="Email">
          {(id) => <Input id={id} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />}
        </Field>
        <Field label="Password" hint="At least 8 characters." error={pwError}>
          {(id) => (
            <Input
              id={id}
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={password}
              aria-invalid={!!pwError}
              onBlur={() => setTouched(true)}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </Field>
        {signup.isError && (
          <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger">
            {errorMessage(signup.error)}
          </p>
        )}
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={signup.isPending} disabled={!name || !email || !password}>
          Create account
        </Button>
      </form>
    </AuthShell>
  );
}
