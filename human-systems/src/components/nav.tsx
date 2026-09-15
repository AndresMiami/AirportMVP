"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useModel } from "@/components/model-provider";

const LINKS: { href: string; label: string; group?: string }[] = [
  { href: "/", label: "Dashboard" },
  { href: "/profile", label: "System profile" },
  { href: "/income", label: "Income sources" },
  { href: "/variables", label: "Structural variables" },
  { href: "/feedback-map", label: "Feedback map" },
  { href: "/constraints", label: "Constraints" },
  { href: "/observations", label: "Observations" },
  { href: "/hypotheses", label: "Hypotheses" },
  { href: "/events", label: "Events" },
  { href: "/attractor", label: "Current attractor" },
  { href: "/desired", label: "Desired state" },
  { href: "/gap", label: "Structural gap" },
  { href: "/leverage", label: "Leverage points" },
  { href: "/scenarios", label: "Scenario simulator" },
  { href: "/ai", label: "AI analysis" },
  { href: "/evidence", label: "Evidence / assumptions" },
];

/** Small persistent reminder, on every page, that the values shown are
 *  from a past date. Cleared with the × control or from the dashboard. */
export function AsOfPill() {
  const { asOf, setAsOf } = useModel();
  if (!asOf) return null;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-warn bg-warn-soft text-warn px-2 py-0.5 text-xs whitespace-nowrap"
      role="status"
    >
      Values as of {asOf.slice(0, 10)}
      <button
        type="button"
        className="ml-0.5 rounded-full px-1 leading-none hover:bg-background"
        aria-label="Back to today"
        title="Back to today"
        onClick={() => setAsOf(null)}
      >
        ×
      </button>
    </span>
  );
}

export function Nav() {
  const pathname = usePathname();
  return (
    <nav className="border-b md:border-b-0 md:border-r border-border bg-surface md:w-60 md:min-h-screen shrink-0">
      <div className="px-4 py-4 border-b border-border">
        <div className="font-semibold">Human Systems Lens</div>
        <div className="text-xs text-muted mt-0.5">Structural scenario analysis, not prediction</div>
        <div className="mt-2 empty:hidden">
          <AsOfPill />
        </div>
      </div>
      <ul className="flex md:flex-col overflow-x-auto md:overflow-visible text-sm">
        {LINKS.map((l) => {
          const active = pathname === l.href;
          return (
            <li key={l.href}>
              <Link
                href={l.href}
                className={`block px-4 py-2 whitespace-nowrap border-l-2 ${
                  active
                    ? "border-accent bg-accent-soft text-accent font-medium"
                    : "border-transparent hover:bg-background"
                }`}
              >
                {l.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
