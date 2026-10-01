import { useEffect, useMemo, useRef, useState } from "react";
import { hrefFor } from "../../lib/routes";
import { searchPalette, type PaletteEntry } from "../../lib/palette";
import { ArrowRightIcon, BotIcon, EnterIcon, KeyboardIcon, SearchIcon, ZapIcon } from "../ui/icons";

export type PaletteAction = NonNullable<PaletteEntry["action"]>;

/** Ctrl/Cmd+K: actions first (scan fleet, new copilot run, ask copilot),
 * "open by id" when you type an alert number, WO id or component id, then
 * every page. Actions that change data (Scan fleet) run through the same
 * toast feedback as their on-page buttons; approvals are never in here. */
export function CommandPalette({
  open,
  onClose,
  onAction,
}: {
  open: boolean;
  onClose: () => void;
  onAction: (action: PaletteAction, query: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const results = useMemo(() => searchPalette(query), [query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setIndex(0);
    const previous = document.activeElement as HTMLElement | null;
    requestAnimationFrame(() => inputRef.current?.focus());
    return () => previous?.focus?.();
  }, [open]);

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [index]);

  if (!open) return null;

  const go = (e: PaletteEntry | undefined) => {
    if (!e) return;
    onClose();
    if (e.kind === "action" && e.action) onAction(e.action, query.trim());
    else if (e.path) window.location.hash = hrefFor(e.path).replace(/^#/, "");
  };

  const icon = (e: PaletteEntry) =>
    e.action === "scan" ? (
      <ZapIcon />
    ) : e.action === "shortcuts" ? (
      <KeyboardIcon />
    ) : e.action ? (
      <BotIcon />
    ) : e.kind === "open" ? (
      <SearchIcon />
    ) : (
      <ArrowRightIcon />
    );

  let lastGroup = "";
  return (
    <div className="palette-scrim" onClick={onClose}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onClick={(e) => e.stopPropagation()}>
        <div className="palette-search">
          <SearchIcon />
          <input
            ref={inputRef}
            className="palette-input"
            placeholder="Type a command, an alert number, a WO or component id…"
            aria-label="Search commands and pages"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={results[index] ? `pal-${index}` : undefined}
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
                e.preventDefault();
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                onClose();
              }
            }}
          />
          <kbd className="kbd">Esc</kbd>
        </div>
        <ul className="palette-list" id="palette-list" role="listbox" aria-label="Commands" ref={listRef}>
          {results.length === 0 && (
            <li className="palette-empty">Nothing matches “{query}”. Try a page name, “scan”, or an alert number.</li>
          )}
          {results.map((e, i) => {
            const header = e.group !== lastGroup ? e.group : null;
            lastGroup = e.group;
            return (
              <li key={e.id} role="presentation">
                {header && <div className="palette-group">{header}</div>}
                <div
                  id={`pal-${i}`}
                  role="option"
                  aria-selected={i === index}
                  className={`palette-item${e.kind === "action" ? " is-action" : ""}`}
                  onMouseMove={() => setIndex(i)}
                  onClick={() => go(e)}
                >
                  <span className="palette-ico" aria-hidden="true">
                    {icon(e)}
                  </span>
                  <span className="palette-main">
                    <span className="palette-label">{e.label}</span>
                    <span className="palette-desc">{e.description}</span>
                  </span>
                  {i === index ? <EnterIcon className="palette-go" /> : null}
                </div>
              </li>
            );
          })}
        </ul>
        <div className="palette-foot">
          <span>
            <kbd className="kbd">↑</kbd>
            <kbd className="kbd">↓</kbd> move
          </span>
          <span>
            <kbd className="kbd">Enter</kbd> run
          </span>
          <span>
            <kbd className="kbd">?</kbd> all shortcuts
          </span>
        </div>
      </div>
    </div>
  );
}

const SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: ["Ctrl", "K"], label: "Command palette: actions, pages, open by id" },
  { keys: ["?"], label: "This shortcut sheet" },
  { keys: ["Esc"], label: "Close the sheet, dialog or palette" },
  { keys: ["←", "→"], label: "Previous / next item inside a detail sheet" },
  { keys: ["K", "J"], label: "Same as ← / → (vim style)" },
  { keys: ["Enter"], label: "Open the focused row" },
  { keys: ["Space"], label: "Toggle the focused row checkbox" },
];

export function ShortcutSheet({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "?") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      previous?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="dialog-scrim" onClick={onClose}>
      <div className="dialog is-wide" role="dialog" aria-modal="true" aria-labelledby="kbd-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="kbd-title" className="dialog-title">
          Keyboard shortcuts
        </h2>
        <dl className="kbd-list">
          {SHORTCUTS.map((s) => (
            <div key={s.label} className="kbd-row">
              <dt>
                {s.keys.map((k) => (
                  <kbd key={k} className="kbd">
                    {k}
                  </kbd>
                ))}
              </dt>
              <dd>{s.label}</dd>
            </div>
          ))}
        </dl>
        <div className="dialog-foot">
          <button ref={ref} type="button" className="btn" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
