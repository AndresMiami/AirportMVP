"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

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

export function Nav() {
  const pathname = usePathname();
  return (
    <nav className="border-b md:border-b-0 md:border-r border-border bg-surface md:w-60 md:min-h-screen shrink-0">
      <div className="px-4 py-4 border-b border-border">
        <div className="font-semibold">Human Systems Lens</div>
        <div className="text-xs text-muted mt-0.5">Structural scenario analysis, not prediction</div>
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
