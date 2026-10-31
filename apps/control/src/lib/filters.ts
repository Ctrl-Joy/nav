// Build filters: decide whether a push touching `files` should deploy a service.

/** Converts a glob (`**`, `*`, `?`) into an anchored RegExp. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function matchesBuildFilter(rootDir: string, filter: { paths: string[]; ignoredPaths: string[] }, files: string[]): boolean {
  // Unknown change set (e.g. force push with no commit list): deploy.
  if (!files.length) return true;
  const included = filter.paths.length ? filter.paths.map(globToRegExp) : rootDir ? [globToRegExp(`${rootDir.replace(/\/$/, '')}/**`)] : null;
  const ignored = filter.ignoredPaths.map(globToRegExp);
  return files.some((f) => (!included || included.some((r) => r.test(f))) && !ignored.some((r) => r.test(f)));
}
