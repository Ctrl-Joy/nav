import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Logo } from '@/components/Logo';
import { cn } from '@/lib/cn';
import { useTitle } from '@/lib/useTitle';
import { DOC_GROUPS, DOC_SECTIONS, type DocBlock } from './docsContent';

const FIRST_SECTION = DOC_SECTIONS[0]?.slug ?? '';

/** Renders text with `inline code` spans. */
function Inline({ text }: { text: string }) {
  return (
    <>
      {text.split('`').map((part, i) =>
        i % 2 === 1 ? (
          <code key={i} className="rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[0.85em] text-fg">
            {part}
          </code>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

function BlockView({ block }: { block: DocBlock }) {
  switch (block.type) {
    case 'p':
      return (
        <p className="text-[15px] leading-7 text-fg-muted">
          <Inline text={block.text} />
        </p>
      );
    case 'h3':
      return <h3 className="pt-2 text-[17px] font-medium tracking-tight text-fg">{block.text}</h3>;
    case 'list':
      return (
        <ul className="list-disc space-y-2 pl-5 text-[15px] leading-7 text-fg-muted marker:text-fg-subtle">
          {block.items.map((item, i) => (
            <li key={i}>
              <Inline text={item} />
            </li>
          ))}
        </ul>
      );
    case 'code':
      return (
        <pre className="rounded-xl border border-border bg-surface p-4 font-mono text-[12.5px] leading-6 text-fg overflow-x-auto">
          <code>{block.code}</code>
        </pre>
      );
  }
}

function SideNav({ query, active }: { query: string; active: string }) {
  const q = query.trim().toLowerCase();
  const matches = (title: string, slug: string) => !q || title.toLowerCase().includes(q) || slug.includes(q);
  const anyMatch = DOC_SECTIONS.some((s) => matches(s.title, s.slug));

  return (
    <nav aria-label="Documentation sections" className="space-y-5">
      {DOC_GROUPS.map((group) => {
        const items = DOC_SECTIONS.filter((s) => s.group === group && matches(s.title, s.slug));
        if (items.length === 0) return null;
        return (
          <div key={group}>
            <p className="mb-2 px-2.5 text-[11px] font-medium uppercase tracking-[0.12em] text-fg-subtle">{group}</p>
            <ul className="space-y-0.5">
              {items.map((s) => {
                const isActive = s.slug === active;
                return (
                  <li key={s.slug}>
                    <a
                      href={`#${s.slug}`}
                      aria-current={isActive ? 'location' : undefined}
                      className={cn(
                        'block rounded-lg px-2.5 py-1.5 text-[14px] transition-colors',
                        isActive
                          ? 'bg-surface-2 font-medium text-accent'
                          : 'text-fg-muted hover:bg-surface-2 hover:text-fg',
                      )}
                    >
                      {s.title}
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
      {!anyMatch && <p className="px-2.5 text-[14px] text-fg-subtle">No sections match.</p>}
    </nav>
  );
}

export function DocsPage() {
  useTitle('Docs');
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(FIRST_SECTION);

  // Highlight the section currently in the upper part of the viewport.
  useEffect(() => {
    const els = DOC_SECTIONS.map((s) => document.getElementById(s.slug)).filter(
      (el): el is HTMLElement => el !== null,
    );
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: '-15% 0px -70% 0px' },
    );
    els.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  // Deep links such as /docs#deploys: scroll once the sections exist.
  // (Delayed past the router's scroll reset; also follows in-page hash changes.)
  useEffect(() => {
    const go = () => {
      const id = decodeURIComponent(window.location.hash.slice(1));
      if (id) document.getElementById(id)?.scrollIntoView({ block: 'start' });
    };
    const timer = window.setTimeout(go, 150);
    window.addEventListener('hashchange', go);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('hashchange', go);
    };
  }, []);

  return (
    <div data-theme="dark" className="min-h-dvh bg-bg text-fg">
      <header className="sticky top-0 z-20 border-b border-border bg-bg/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1280px] items-center gap-4 px-4 min-[900px]:px-6">
          <Link to="/" aria-label="NAV home" className="shrink-0">
            <Logo />
          </Link>
          <span className="hidden text-[14px] text-fg-subtle sm:inline">Docs</span>
          <div className="ml-auto flex items-center gap-3">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search docs"
              aria-label="Search documentation sections"
              className="h-9 w-40 rounded-xl border border-border bg-surface px-3 text-[14px] text-fg outline-none placeholder:text-fg-subtle focus:border-accent sm:w-64"
            />
            <Link
              to="/app"
              className="shrink-0 rounded-xl border border-border bg-surface px-3.5 py-1.5 text-[14px] font-medium text-fg hover:bg-surface-2"
            >
              Dashboard
            </Link>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1280px] gap-x-12 px-4 min-[900px]:grid-cols-[220px_minmax(0,1fr)] min-[900px]:px-6">
        <aside className="sticky top-14 hidden h-[calc(100dvh-3.5rem)] overflow-y-auto py-8 min-[900px]:block">
          <SideNav query={query} active={active} />
        </aside>

        <div className="min-w-0">
          <details className="group mt-4 rounded-xl border border-border bg-surface min-[900px]:hidden">
            <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-[15px] font-medium text-fg">
              Contents
              <span aria-hidden className="text-fg-subtle transition-transform group-open:rotate-180">
                v
              </span>
            </summary>
            <div className="border-t border-border p-4">
              <SideNav query={query} active={active} />
            </div>
          </details>

          <main className="mx-auto max-w-[760px] pb-24 pt-10">
            <h1 className="text-[34px] font-medium tracking-tight text-fg">NAV documentation</h1>
            <p className="mt-3 text-[15px] leading-7 text-fg-muted">
              NAV is a self-hostable platform-as-a-service. These pages cover how to deploy services, how the platform
              works and how to operate it.
            </p>

            {DOC_SECTIONS.map((section) => (
              <section
                key={section.slug}
                id={section.slug}
                className="scroll-mt-20 border-t border-border py-12 first:border-t-0"
              >
                <h2 className="text-[26px] font-medium tracking-tight text-fg">{section.title}</h2>
                <div className="mt-5 space-y-4">
                  {section.blocks.map((block, i) => (
                    <BlockView key={i} block={block} />
                  ))}
                </div>
              </section>
            ))}
          </main>
        </div>
      </div>
    </div>
  );
}
