"use client";
/**
 * Primary navigation (Step 6A): four places. Home, History, Map, Library.
 * Everything else lives under Library; no route was removed.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useModel } from "@/components/model-provider";

const LINKS: { href: string; label: string; matches: (path: string) => boolean }[] = [
  { href: "/", label: "Home", matches: (p) => p === "/" },
  { href: "/history", label: "History", matches: (p) => p.startsWith("/history") || p.startsWith("/explore") },
  { href: "/map", label: "Map", matches: (p) => p.startsWith("/map") || p.startsWith("/feedback-map") },
  { href: "/library", label: "Library", matches: (p) => p !== "/" && !p.startsWith("/history") && !p.startsWith("/explore") && !p.startsWith("/map") && !p.startsWith("/feedback-map") },
];

/** Small persistent reminder, on every page, that the values shown are
 *  from a past date. Cleared with the × control or from Home. */
export function AsOfPill() {
  const { asOf, setAsOf } = useModel();
  if (!asOf) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-warn bg-warn-soft text-warn px-2 py-0.5 text-xs whitespace-nowrap" role="status">
      Values as of {asOf.slice(0, 10)}
      <button type="button" className="ml-0.5 rounded-full px-1 leading-none hover:bg-background" aria-label="Back to today" title="Back to today" onClick={() => setAsOf(null)}>
        ×
      </button>
    </span>
  );
}

export function Nav() {
  const pathname = usePathname() ?? "/";
  return (
    <nav className="sticky top-0 z-10 border-b border-border bg-surface/95 backdrop-blur" aria-label="Primary">
      <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-2">
        <Link href="/" className="shrink-0 whitespace-nowrap text-sm font-semibold tracking-tight">
          <span className="sm:hidden">Lens</span>
          <span className="hidden sm:inline">Human Systems Lens</span>
        </Link>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <AsOfPill />
          <ul className="flex gap-1 text-sm">
            {LINKS.map((l) => {
              const active = l.matches(pathname);
              return (
                <li key={l.href}>
                  <Link href={l.href} className={`block rounded-full px-3 py-1 ${active ? "bg-accent-soft text-accent font-medium" : "hover:bg-background"}`} aria-current={active ? "page" : undefined}>
                    {l.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </nav>
  );
}
