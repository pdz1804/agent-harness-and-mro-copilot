import { useEffect, useState, type ReactNode } from "react";

export interface TocItem {
  id: string;
  label: string;
}

/** Scroll the in-page anchor inside the single <main> scroll container. */
function jumpTo(id: string) {
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
}

function useActiveSection(ids: string[]): string {
  const [active, setActive] = useState(ids[0] ?? "");
  useEffect(() => {
    const root = document.getElementById("app-main");
    const els = ids.map((id) => document.getElementById(id)).filter((e): e is HTMLElement => !!e);
    if (!root || els.length === 0 || typeof IntersectionObserver === "undefined") return;
    const visible = new Map<string, number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.set(e.target.id, e.boundingClientRect.top);
          else visible.delete(e.target.id);
        }
        if (visible.size > 0) {
          const [first] = [...visible.entries()].sort((a, b) => a[1] - b[1])[0];
          setActive(first);
        }
      },
      { root, rootMargin: "-24px 0px -60% 0px", threshold: 0 },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [ids.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps
  return active;
}

interface DocLayoutProps {
  toc: TocItem[];
  children: ReactNode;
}

/** Readable document layout: article on the left, sticky "On this page"
 * table of contents on the right (a horizontal chip strip under 1100px). */
export function DocLayout({ toc, children }: DocLayoutProps) {
  const active = useActiveSection(toc.map((t) => t.id));
  return (
    <div className="doc">
      <nav className="doc-toc" aria-label="On this page">
        <div className="doc-toc-title">On this page</div>
        <ol>
          {toc.map((t) => (
            <li key={t.id}>
              <a
                href={`#${t.id}`}
                aria-current={active === t.id ? "true" : undefined}
                onClick={(e) => {
                  // The app uses hash routing: never let the anchor rewrite the route.
                  e.preventDefault();
                  jumpTo(t.id);
                }}
              >
                {t.label}
              </a>
            </li>
          ))}
        </ol>
      </nav>
      <article className="doc-article">{children}</article>
    </div>
  );
}

export function DocSection({
  id,
  title,
  num,
  children,
}: {
  id: string;
  title: string;
  num?: number;
  children: ReactNode;
}) {
  return (
    <section className="doc-section" id={id}>
      <h2>
        {num !== undefined && <span className="doc-num">{num}.</span>}
        {title}
      </h2>
      {children}
    </section>
  );
}
