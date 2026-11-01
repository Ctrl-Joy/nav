import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { Eye, EyeOff } from 'lucide-react';
import {
  providerUrl, useConfig, useForgotPassword, useLogin, useLoginMfa, useMe, useResetPassword, useResetToken, useSignup, useSsoLookup,
} from '@/api/auth';
import { errorMessage, isApiError } from '@/api/client';
import { isMfaChallenge, type AuthProvider } from '@/api/types';
import { useToast } from '@/components/ui';
import { Logo } from '@/components/Logo';
import { FullPageSpinner } from '@/layouts/RootLayout';
import { useTitle } from '@/lib/useTitle';
import { PROVIDER_NAMES, ProviderIcon, oauthErrorMessage } from './providers';
import './auth.css';

/** Only allow same-origin, in-app redirect targets. */
export function safeNext(next: string | null): string | null {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return null;
  return next;
}

function AuthLayout({ title, sub, children }: { title: string; sub?: ReactNode; children: ReactNode }) {
  return (
    <div className="au" data-theme="dark">
      <header className="au-top">
        <Link to="/" className="au-brand" aria-label="NAV home"><Logo /></Link>
      </header>
      <main className="au-main">
        <h1 className="au-title">{title}</h1>
        {sub && <p className="au-sub">{sub}</p>}
        {children}
      </main>
    </div>
  );
}

const SIGN_IN_PROVIDERS: AuthProvider[] = ['github', 'gitlab', 'bitbucket', 'google'];

function Providers({ next, onDisabled }: { next: string | null; onDisabled: (msg: string) => void }) {
  const config = useConfig();
  const enabled = config.data?.auth?.providers ?? { github: !!config.data?.githubEnabled };
  return (
    <>
      <div className="au-providers">
        {SIGN_IN_PROVIDERS.map((p) =>
          enabled[p] ? (
            <a key={p} className="au-provider" href={providerUrl(p, { next })}><ProviderIcon provider={p} />{PROVIDER_NAMES[p]}</a>
          ) : (
            <button
              key={p}
              type="button"
              className="au-provider"
              aria-disabled="true"
              title={`${PROVIDER_NAMES[p]} sign-in isn't set up on this server`}
              onClick={() => onDisabled(oauthErrorMessage('provider_disabled', p)!)}
            >
              <ProviderIcon provider={p} />{PROVIDER_NAMES[p]}
            </button>
          ),
        )}
      </div>
      <div className="au-or">or</div>
    </>
  );
}

function TextField(props: {
  id: string; label: string; type?: string; value: string; onChange: (v: string) => void; placeholder?: string;
  autoComplete?: string; autoFocus?: boolean; invalid?: boolean; hint?: string;
}) {
  const [show, setShow] = useState(false);
  const isPw = props.type === 'password';
  return (
    <div className="au-field">
      <label htmlFor={props.id}>{props.label}</label>
      <div className={`au-input${isPw ? ' has-eye' : ''}`}>
        <input
          id={props.id}
          name={props.id}
          type={isPw && show ? 'text' : (props.type ?? 'text')}
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          placeholder={props.placeholder}
          autoComplete={props.autoComplete}
          autoFocus={props.autoFocus}
          aria-invalid={props.invalid || undefined}
          aria-describedby={props.hint ? `${props.id}-hint` : undefined}
          required
        />
        {isPw && (
          <button type="button" className="au-eye" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show}>
            {show ? <EyeOff /> : <Eye />}
          </button>
        )}
      </div>
      {props.hint && <p id={`${props.id}-hint`} className="au-hint">{props.hint}</p>}
    </div>
  );
}

function Submit({ busy, children }: { busy: boolean; children: ReactNode }) {
  return (
    <button type="submit" className="au-submit" disabled={busy}>
      {busy && <span className="au-spin" aria-hidden="true" />}
      {children}
    </button>
  );
}

function Alert({ kind, children }: { kind: 'err' | 'ok' | 'info'; children: ReactNode }) {
  return <div className={`au-alert ${kind}`} role={kind === 'err' ? 'alert' : 'status'}>{children}</div>;
}

export function LoginPage() {
  useTitle('Sign in');
  const me = useMe();
  const login = useLogin();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [notice, setNotice] = useState<string | null>(oauthErrorMessage(params.get('error'), params.get('provider')));

  if (me.isLoading) return <FullPageSpinner />;
  if (me.data) return <Navigate to={next ?? '/app'} replace />;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setNotice(null);
    login.mutate(
      { email, password },
      {
        onSuccess: (data) =>
          isMfaChallenge(data)
            ? navigate(`/login/mfa${next ? `?next=${encodeURIComponent(next)}` : ''}`, { replace: true })
            : navigate(next ?? '/app', { replace: true }),
      },
    );
  };
  const failed = login.error ? (isApiError(login.error) && login.error.status === 401 ? 'Incorrect email or password.' : errorMessage(login.error)) : null;

  return (
    <AuthLayout title="Sign In to NAV">
      <Providers next={next} onDisabled={setNotice} />
      <form className="au-form" onSubmit={onSubmit} noValidate={false}>
        <TextField id="email" label="Email" type="email" value={email} onChange={setEmail} placeholder="your@email.com" autoComplete="email" autoFocus invalid={!!failed} />
        <TextField id="password" label="Password" type="password" value={password} onChange={setPassword} placeholder="correct horse battery staple" autoComplete="current-password" invalid={!!failed} />
        {(failed || notice) && <Alert kind="err">{failed ?? notice}</Alert>}
        <Submit busy={login.isPending}>Sign in</Submit>
      </form>
      <div className="au-links">
        <Link to={`/sso${next ? `?next=${encodeURIComponent(next)}` : ''}`}>Sign in with SSO</Link>
        <span>Need an account? <Link to={`/signup${next ? `?next=${encodeURIComponent(next)}` : ''}`}>Sign up</Link></span>
        <span>Forgot your password? <Link to="/forgot-password">Reset it</Link></span>
      </div>
    </AuthLayout>
  );
}

export function SignupPage() {
  useTitle('Sign up');
  const me = useMe();
  const signup = useSignup();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [notice, setNotice] = useState<string | null>(oauthErrorMessage(params.get('error'), params.get('provider')));

  if (me.isLoading) return <FullPageSpinner />;
  if (me.data) return <Navigate to={next ?? '/app'} replace />;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setNotice(null);
    signup.mutate({ email, password }, { onSuccess: () => navigate(next ?? '/app', { replace: true }) });
  };
  const failed = signup.error ? (isApiError(signup.error) && signup.error.code === 'email_taken' ? 'An account with that email already exists. Sign in instead.' : errorMessage(signup.error)) : null;

  return (
    <AuthLayout title="Sign Up for NAV">
      <Providers next={next} onDisabled={setNotice} />
      <form className="au-form" onSubmit={onSubmit}>
        <TextField id="email" label="Email" type="email" value={email} onChange={setEmail} placeholder="your@email.com" autoComplete="email" autoFocus invalid={!!failed} />
        <TextField id="password" label="Password" type="password" value={password} onChange={setPassword} placeholder="correct horse battery staple" autoComplete="new-password" hint="At least 8 characters." invalid={!!failed} />
        {(failed || notice) && <Alert kind="err">{failed ?? notice}</Alert>}
        <Submit busy={signup.isPending}>Create account</Submit>
      </form>
      <div className="au-links">
        <span>Already have an account? <Link to={`/login${next ? `?next=${encodeURIComponent(next)}` : ''}`}>Sign in</Link></span>
      </div>
    </AuthLayout>
  );
}

export function SsoPage() {
  useTitle('Single sign-on');
  const sso = useSsoLookup();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const [email, setEmail] = useState('');
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    sso.mutate(email, {
      onSuccess: ({ redirect }) => {
        const url = new URL(redirect, window.location.origin);
        if (next) url.searchParams.set('next', next);
        // Same-origin API path that 302s to the identity provider.
        if (url.origin === window.location.origin && url.pathname.startsWith('/api/v1/auth/oauth/sso/')) window.location.assign(url.toString());
      },
    });
  };
  return (
    <AuthLayout title="Sign in with SSO" sub="Enter your work email and we'll send you to your organization's identity provider.">
      <form className="au-form" style={{ marginTop: 30 }} onSubmit={onSubmit}>
        <TextField id="email" label="Work email" type="email" value={email} onChange={setEmail} placeholder="you@company.com" autoComplete="email" autoFocus invalid={!!sso.error} />
        {sso.error && <Alert kind="err">{isApiError(sso.error) && sso.error.code === 'sso_not_configured' ? `Single sign-on isn't set up for ${email.split('@')[1] ?? 'that domain'}. Sign in with your email and password instead.` : errorMessage(sso.error)}</Alert>}
        <Submit busy={sso.isPending || sso.isSuccess}>Continue</Submit>
      </form>
      <div className="au-links">
        <Link to="/login">Back to sign in</Link>
      </div>
    </AuthLayout>
  );
}

export function ForgotPasswordPage() {
  useTitle('Reset your password');
  const forgot = useForgotPassword();
  const [email, setEmail] = useState('');
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    forgot.mutate(email);
  };
  return (
    <AuthLayout title="Reset your password" sub="Enter the email you use for NAV and we'll send you a link to choose a new password.">
      {forgot.isSuccess ? (
        <>
          <Alert kind="ok">If an account exists for <strong>{email}</strong>, a reset link is on its way. The link works once and expires in an hour.</Alert>
          <p className="au-fine">Self-hosting NAV without email? The link is written to the control plane's log, on a line starting with <code>[auth] password reset requested</code>.</p>
        </>
      ) : (
        <form className="au-form" style={{ marginTop: 30 }} onSubmit={onSubmit}>
          <TextField id="email" label="Email" type="email" value={email} onChange={setEmail} placeholder="your@email.com" autoComplete="email" autoFocus />
          {forgot.error && <Alert kind="err">{errorMessage(forgot.error)}</Alert>}
          <Submit busy={forgot.isPending}>Send reset link</Submit>
        </form>
      )}
      <div className="au-links">
        <span>Remembered it? <Link to="/login">Sign in</Link></span>
      </div>
    </AuthLayout>
  );
}

export function ResetPasswordPage() {
  useTitle('Choose a new password');
  const [params] = useSearchParams();
  const token = params.get('token');
  const check = useResetToken(token);
  const reset = useResetPassword();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [mismatch, setMismatch] = useState(false);

  // Keep the token out of the address bar (and history/referrers) once it has been read.
  useEffect(() => {
    if (token) window.history.replaceState(null, '', '/reset-password');
  }, [token]);

  if (!token || check.isError) {
    return (
      <AuthLayout title="This link has expired">
        <Alert kind="err">This password reset link is invalid, has already been used, or has expired.</Alert>
        <div className="au-links"><Link to="/forgot-password">Request a new link</Link></div>
      </AuthLayout>
    );
  }
  if (check.isLoading) return <FullPageSpinner />;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) { setMismatch(true); return; }
    setMismatch(false);
    reset.mutate({ token, password }, { onSuccess: (data) => navigate(isMfaChallenge(data) ? '/login/mfa' : '/app', { replace: true }) });
  };
  return (
    <AuthLayout title="Choose a new password" sub={<>For {check.data?.email}. You'll be signed out everywhere else.</>}>
      <form className="au-form" style={{ marginTop: 30 }} onSubmit={onSubmit}>
        <TextField id="password" label="New password" type="password" value={password} onChange={setPassword} autoComplete="new-password" autoFocus hint="At least 8 characters." />
        <TextField id="confirm" label="Confirm new password" type="password" value={confirm} onChange={setConfirm} autoComplete="new-password" invalid={mismatch} />
        {mismatch && <Alert kind="err">The passwords don't match.</Alert>}
        {reset.error && <Alert kind="err">{errorMessage(reset.error)}</Alert>}
        <Submit busy={reset.isPending}>Set password and sign in</Submit>
      </form>
    </AuthLayout>
  );
}

/** Second sign-in step for accounts with two-factor authentication (password, reset and OAuth sign-ins land here). */
export function LoginMfaPage() {
  useTitle('Two-factor authentication');
  const me = useMe();
  const verify = useLoginMfa();
  const toast = useToast();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const [code, setCode] = useState('');
  const [target, setTarget] = useState<string | null>(null);

  if (me.isLoading) return <FullPageSpinner />;
  if (me.data) return <Navigate to={target ?? next ?? '/app'} replace />;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    verify.mutate(code.trim(), {
      onSuccess: (res) => {
        // Set before the refreshed user arrives, which renders the redirect above.
        setTarget(next ?? safeNext(res.next) ?? '/app');
        if (res.usedRecoveryCode) {
          const left = res.recoveryCodesLeft ?? 0;
          toast.info('Recovery code used', `${left} recovery ${left === 1 ? 'code' : 'codes'} left. Generate new ones in Account settings.`);
        }
      },
    });
  };
  const expired = isApiError(verify.error) && verify.error.code === 'mfa_expired';
  const failed = verify.error
    ? expired
      ? 'Your sign-in expired. Start again.'
      : isApiError(verify.error) && verify.error.code === 'invalid_code'
        ? "That code isn't valid. Check your authenticator app and try again."
        : errorMessage(verify.error)
    : null;

  return (
    <AuthLayout title="Two-factor authentication" sub="Enter the 6-digit code from your authenticator app.">
      <form className="au-form" style={{ marginTop: 30 }} onSubmit={onSubmit}>
        <TextField
          id="code"
          label="Authentication code"
          value={code}
          onChange={setCode}
          placeholder="123 456"
          autoComplete="one-time-code"
          autoFocus
          invalid={!!failed}
          hint="Lost your device? Enter one of your recovery codes instead, like abcd-efgh-jkmn."
        />
        {failed && <Alert kind="err">{failed}</Alert>}
        <Submit busy={verify.isPending || verify.isSuccess}>Verify</Submit>
      </form>
      <div className="au-links">
        <Link to={`/login${next ? `?next=${encodeURIComponent(next)}` : ''}`}>{expired ? 'Sign in again' : 'Back to sign in'}</Link>
      </div>
    </AuthLayout>
  );
}
