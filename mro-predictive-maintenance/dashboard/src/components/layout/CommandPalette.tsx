import { useEffect, useMemo, useRef, useState } from "react";
import { AREAS, hrefFor } from "../../lib/routes";
import { ArrowRightIcon, EnterIcon, SearchIcon } from "../ui/icons";

interface Entry {
  id: string;
  label: string;
  area: string;
  description: string;
}

const ENTRIES: Entry[] = AREAS.flatMap((a) =>
  a.pages.map((p) => ({ id: p.id, label: p.title, area: a.label, description: p.description })),
);

/** Ctrl/Cmd+K page switcher. Navigation only: it never triggers an action,
 * so it cannot start a scan, approve anything or create a work order. */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ENTRIES;
    return ENTRIES.filter((e) => `${e.label} ${e.area} ${e.description}`.toLowerCase().includes(q));
  }, [query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setIndex(0);
    const previous = document.activeElement as HTMLElement | null;
    requestAnimationFrame(() => inputRef.current?.focus());
    return () => previous?.focus?.();
  }, [open]);

  useEffect(() => setIndex(0), [query]);

  if (!open) return null;

  const go = (e: Entry | undefined) => {
    if (!e) return;
    window.location.hash = hrefFor(e.id).replace(/^#/, "");
    onClose();
  };

  return (
    <div className="palette-scrim" onClick={onClose}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Jump to a page" onClick={(e) => e.stopPropagation()}>
        <div className="palette-search">
          <SearchIcon />
          <input
            ref={inputRef}
            className="palette-input"
            placeholder="Jump to a page…"
            aria-label="Search pages"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={results[index] ? `pal-${results[index].id.replace("/", "-")}` : undefined}
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setIndex((i) => Math.min(results.length - 1, i + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setIndex((i) => Math.max(0, i - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                go(results[index]);
              } else if (e.key === "Tab") {
                // The input is the dialog's only control: keep focus inside it.
                e.preventDefault();
              } else if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
          />
          <kbd className="kbd">Esc</kbd>
        </div>
        <ul className="palette-list" id="palette-list" role="listbox" aria-label="Pages">
          {results.length === 0 && <li className="palette-empty">No page matches “{query}”.</li>}
          {results.map((e, i) => (
            <li
              key={e.id}
              id={`pal-${e.id.replace("/", "-")}`}
              role="option"
              aria-selected={i === index}
              className="palette-item"
              onMouseMove={() => setIndex(i)}
              onClick={() => go(e)}
            >
              <span className="palette-area">{e.area}</span>
              <span className="palette-main">
                <span className="palette-label">{e.label}</span>
                <span className="palette-desc">{e.description}</span>
              </span>
              {i === index ? <EnterIcon className="palette-go" /> : <ArrowRightIcon className="palette-go is-quiet" />}
            </li>
          ))}
        </ul>
        <div className="palette-foot">
          <span>
            <kbd className="kbd">↑</kbd>
            <kbd className="kbd">↓</kbd> move
          </span>
          <span>
            <kbd className="kbd">Enter</kbd> open
          </span>
          <span>
            <kbd className="kbd">Esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}
