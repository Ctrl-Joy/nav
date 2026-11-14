import { useEffect } from 'react';

export function useTitle(title: string | null | undefined): void {
  useEffect(() => {
    document.title = title ? `${title} · NAV` : 'NAV · Ship from Git, run anywhere';
  }, [title]);
}
