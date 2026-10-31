import { useEffect, useState } from 'react';

export type Theme = 'dark' | 'light';
const KEY = 'nav.theme';

export function getTheme(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

export function setTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0B0D10' : '#F6F7F9');
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* storage unavailable */
  }
  window.dispatchEvent(new CustomEvent('nav:theme', { detail: theme }));
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === 'dark' ? 'light' : 'dark';
  setTheme(next);
  return next;
}

export function useTheme(): [Theme, () => void] {
  const [theme, set] = useState<Theme>(() => getTheme());
  useEffect(() => {
    const on = () => set(getTheme());
    window.addEventListener('nav:theme', on);
    return () => window.removeEventListener('nav:theme', on);
  }, []);
  return [theme, () => set(toggleTheme())];
}
