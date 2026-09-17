"use client";
/**
 * The two surfaces every real AI call shares (Step 7A): the boundary card
 * shown before the FIRST external call in this browser (what leaves, in
 * plain words from the local manifest, with a link to the exact payload),
 * and the one-line failure with its safe category behind Details. Neither
 * renders provider text, hashes, schema terms or token counts.
 */
import Link from "next/link";
import { DISCLOSURE_TAIL } from "@/features/ai/wording";

export function AiDisclosure({ sentence, lines, payloadHref, busy, onConfirm, onCancel }: { sentence: string; lines: string[]; payloadHref: string; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <section className="mt-4 rounded-xl border border-border/70 bg-surface px-5 py-4" data-testid="ai-disclosure" aria-live="polite">
      <p className="text-[15px] leading-relaxed">{sentence}</p>
      {lines.length > 0 ? (
        <ul className="mt-2 list-disc pl-5 text-[15px] leading-relaxed text-muted" data-testid="ai-shared-lines">
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      ) : null}
      <p className="mt-2 text-sm text-muted">{DISCLOSURE_TAIL}</p>
      <p className="mt-1 text-sm">
        <Link href={payloadHref} className="text-muted underline">
          Review what is shared →
        </Link>
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" className="rounded-full bg-accent px-4 py-2 text-[15px] font-medium text-white hover:opacity-90 disabled:opacity-50" disabled={busy} onClick={onConfirm} data-testid="ai-disclosure-confirm">
          Send and continue
        </button>
        <button type="button" className="text-[15px] text-muted hover:underline" disabled={busy} onClick={onCancel} data-testid="ai-disclosure-cancel">
          Not now
        </button>
      </div>
    </section>
  );
}

export function AiFailure({ line, detail }: { line: string; detail: string }) {
  return (
    <div className="mt-4 rounded-xl border border-warn/50 bg-warn-soft px-5 py-4 text-[15px] leading-relaxed" role="alert" data-testid="ai-failure">
      <p>{line}</p>
      <details className="mt-1 text-sm text-muted">
        <summary className="cursor-pointer">Details</summary>
        <p className="mt-1">{detail}</p>
      </details>
    </div>
  );
}
