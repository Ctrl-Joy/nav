import { useEffect } from 'react';

/** Default title, matching index.html. Other pages read "<what it is> | NAV". */
const DEFAULT_TITLE = 'Self-Hosted PaaS for Git Deploys and Postgres | NAV';

export function useTitle(title: string | null | undefined): void {
  useEffect(() => {
    document.title = title ? `${title} | NAV` : DEFAULT_TITLE;
  }, [title]);
}
