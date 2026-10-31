import { useEffect } from 'react';

export function useTitle(title: string | null | undefined): void {
  useEffect(() => {
    document.title = title ? `${title} · NAV` : 'NAV — ship from Git, run anywhere';
  }, [title]);
}
