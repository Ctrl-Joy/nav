import { KeyRound } from 'lucide-react';
import type { AuthProvider } from '@/api/types';
import { Github } from '@/components/GithubIcon';

export const PROVIDER_NAMES: Record<AuthProvider, string> = { github: 'GitHub', gitlab: 'GitLab', bitbucket: 'Bitbucket', google: 'Google', sso: 'SSO' };

/** Messages for the `?error=` codes the server's OAuth callbacks redirect back with. */
export function oauthErrorMessage(code: string | null, provider: string | null): string | null {
  if (!code) return null;
  const p = PROVIDER_NAMES[provider as AuthProvider] ?? 'that provider';
  switch (code) {
    case 'provider_disabled': return `${p} sign-in isn't set up on this NAV server yet. The server's administrator can turn it on.`;
    case 'cancelled': return `${p} sign-in was cancelled.`;
    case 'bad_state': return 'Your sign-in attempt expired. Please try again.';
    case 'unverified_email': return `Your ${p} account doesn't have a verified email address, so NAV can't use it to sign in.`;
    case 'email_in_use': return `An account with this email already exists. Sign in with your password, then connect ${p} from Account settings.`;
    case 'identity_in_use': return `That ${p} account is already connected to a different NAV account.`;
    case 'already_connected': return `Your NAV account is already connected to a different ${p} account.`;
    case 'session_expired': return 'Sign in again to connect an account.';
    case 'sso_required': return 'Your organization requires single sign-on. Use "Sign in with SSO" with your work email.';
    case 'saml_not_configured': return "Single sign-on isn't turned on for this organization.";
    case 'saml_expired': return 'Your single sign-on attempt expired or was already used. Please try again.';
    case 'saml_unsolicited': return 'Start single sign-on from the NAV sign-in page ("Sign in with SSO").';
    case 'saml_invalid': return "We couldn't verify the response from your identity provider. Ask your admin to check the SAML settings.";
    case 'saml_no_email': return "Your identity provider didn't send an email address. Ask your admin to map the email attribute.";
    case 'saml_domain': return "Your email address isn't in a domain your organization has verified.";
    case 'saml_deprovisioned': return 'Your access was removed by your organization. Contact your admin.';
    case 'saml_email_mismatch': return 'Your identity provider sent a different email address than the one on your NAV account. Ask your admin to update your account or your identity provider profile.';
    default: return `We couldn't sign you in with ${p}. Please try again.`;
  }
}

export function ProviderIcon({ provider }: { provider: AuthProvider }) {
  switch (provider) {
    case 'github':
      return <Github aria-hidden="true" />;
    case 'gitlab':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path fill="#E24329" d="M12 21.4 16.2 8.6H7.8Z" />
          <path fill="#FC6D26" d="M12 21.4 7.8 8.6H2.1ZM12 21.4l4.2-12.8h5.7Z" />
          <path fill="#FCA326" d="M2.1 8.6.8 12.6a.9.9 0 0 0 .3 1L12 21.4ZM21.9 8.6l1.3 4a.9.9 0 0 1-.3 1L12 21.4Z" />
          <path fill="#E24329" d="M2.1 8.6h5.7L5.3 1.1a.4.4 0 0 0-.8 0ZM21.9 8.6h-5.7l2.5-7.5a.4.4 0 0 1 .8 0Z" />
        </svg>
      );
    case 'bitbucket':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path fill="#2684FF" d="M2.2 2.9a.7.7 0 0 0-.7.8l3 18.2a1 1 0 0 0 1 .8h13.4a.7.7 0 0 0 .7-.6l3-18.4a.7.7 0 0 0-.7-.8Zm12.3 13.1H9.6L8.3 9.1h7.4Z" />
        </svg>
      );
    case 'google':
      return (
        <svg viewBox="0 0 48 48" aria-hidden="true">
          <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
          <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
          <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
          <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
        </svg>
      );
    case 'sso':
      return <KeyRound aria-hidden="true" />;
  }
}
