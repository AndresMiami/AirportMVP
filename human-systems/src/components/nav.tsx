"use client";
/**
 * Primary navigation (Step 6A): four places. Home, History, Map, Library.
 * Everything else lives under Library; no route was removed.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useModel } from "@/components/model-provider";
import { longDate } from "@/features/home/cards";

const LINKS: { href: string; label: string; matches: (path: string) => boolean }[] = [
  { href: "/", label: "Home", matches: (p) => p === "/" },
  { href: "/history", label: "History", matches: (p) => p.startsWith("/history") || p.startsWith("/explore") },
  { href: "/map", label: "Map", matches: (p) => p.startsWith("/map") || p.startsWith("/feedback-map") },
  { href: "/library", label: "Library", matches: (p) => p !== "/" && !p.startsWith("/history") && !p.startsWith("/explore") && !p.startsWith("/map") && !p.startsWith("/feedback-map") },
];

/** The ONE as-of treatment (Step 6A.1): a slim strip under the primary
 *  navigation on every page while the values shown are from a past
 *  date. "Values as of": asOf resolves VALUES historically; structure
 *  (relationships, hypotheses, constraints) stays today's (6A.1.1). No page shows a second as-of notice; storage errors keep their
 *  own prominent notice. */
export function AsOfStrip() {
  const { asOf, setAsOf } = useModel();
  if (!asOf) return null;
  return (
    <div className="border-b border-warn/30 bg-warn-soft text-warn" role="status" data-testid="as-of-strip">
      <div className="mx-auto flex max-w-3xl items-center justify-center gap-2 px-4 py-1.5 text-sm">
        <span>
          Values as of <span className="font-medium">{longDate(asOf)}</span>
        </span>
        <span aria-hidden="true">·</span>
        <button type="button" className="underline underline-offset-2 hover:opacity-80" onClick={() => setAsOf(null)}>
          Back to today
        </button>
      </div>
    </div>
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
        <div className="flex items-center">
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
      <AsOfStrip />
    </nav>
  );
}
