"use client";
/**
 * LIBRARY (Step 6A): the advanced doorway. Every existing screen stays at
 * its route; this page only groups them under human headings and hosts
 * the system switcher. Navigation and presentation only.
 */
import Link from "next/link";
import { useModel } from "@/components/model-provider";
import { SystemSwitcher } from "@/components/system-switcher";
import { Loading } from "@/components/ui";

const GROUPS: { heading: string; blurb: string; links: { href: string; label: string; note?: string }[] }[] = [
  { heading: "Records", blurb: "What was written down, and when.", links: [{ href: "/observations", label: "Observations" }, { href: "/events", label: "Events" }, { href: "/history", label: "History", note: "what changed, what kept showing up" }] },
  { heading: "Model", blurb: "The pieces and how they seem connected.", links: [{ href: "/variables", label: "Variables" }, { href: "/map", label: "Map", note: "relationships and loops" }, { href: "/constraints", label: "Constraints" }, { href: "/profile", label: "System profile" }] },
  { heading: "Investigation", blurb: "Explanations under test and the decisions around them.", links: [{ href: "/hypotheses", label: "Hypotheses" }, { href: "/proposals", label: "Proposals", note: "changes waiting for your review" }, { href: "/explore", label: "Explore a pattern" }, { href: "/evidence", label: "Evidence and assumptions" }] },
  { heading: "Advanced analysis", blurb: "The engineering views. Useful, dense, optional.", links: [{ href: "/overview", label: "Overview", note: "the former dashboard: current versus desired" }, { href: "/desired", label: "Desired state" }, { href: "/gap", label: "Structural gap" }, { href: "/attractor", label: "Current attractor" }, { href: "/leverage", label: "Leverage points" }, { href: "/scenarios", label: "Scenario simulator" }, { href: "/ai", label: "AI diagnostics", note: "what an assistant would receive; mock output" }] },
];

export default function LibraryPage() {
  const { status, evaluated } = useModel();
  if (status === "error") return null;
  if (status === "loading" || !evaluated) return <Loading />;
  const collections = (evaluated.domain.collections ?? []).filter((c): c is typeof c & { route: string } => typeof c.route === "string" && c.route.length > 0);
  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-semibold tracking-tight">Library</h1>
      <p className="mt-2 text-sm text-muted">Everything underneath the notebook. Nothing here is required to use it.</p>
      <div className="mt-8 space-y-8">
        {GROUPS.map((g) => (
          <section key={g.heading} data-library-group={g.heading}>
            <h2 className="text-sm font-semibold">{g.heading}</h2>
            <p className="text-xs text-muted">{g.blurb}</p>
            <ul className="mt-2 divide-y divide-border rounded-2xl bg-surface shadow-sm">
              {[...g.links, ...(g.heading === "Records" ? collections.map((c) => ({ href: c.route, label: c.label, note: "a record collection of this kind of system" })) : [])].map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className="flex items-baseline justify-between gap-3 px-4 py-3 text-sm hover:bg-background">
                    <span>{l.label}</span>
                    {l.note ? <span className="text-xs text-muted">{l.note}</span> : null}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
        <section data-library-group="Your systems">
          <h2 className="text-sm font-semibold">Your systems</h2>
          <p className="text-xs text-muted">Switch, create, export or import a system.</p>
          <div className="mt-2 rounded-2xl bg-surface px-4 py-3 shadow-sm">
            <SystemSwitcher />
          </div>
        </section>
      </div>
    </div>
  );
}
