export function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeLocal(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

export const LAST_WORKSPACE_KEY = 'nav.lastWorkspace';

/** Status to show for a service: a live free instance that spun down for inactivity reads "sleeping". */
export function serviceStatus(s: { status: string; sleeping?: boolean; suspended?: boolean }): string {
  return s.sleeping && !s.suspended && s.status === 'live' ? 'sleeping' : s.status;
}

export const FREE_SLEEP_NOTE = 'Spins down after 15 minutes without traffic; the next request wakes it, which takes a few seconds.';

export function downloadText(filename: string, text: string, type = 'text/plain'): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
