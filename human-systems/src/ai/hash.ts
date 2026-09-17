/**
 * Canonical serialization and content hash, kept free of every "@/" alias
 * so the SERVER boundary (netlify/functions/ai-task.ts) can recompute the
 * contextHash of a payload with the exact code the browser used. Moved out
 * of context.ts in Step 7A; context.ts re-exports both names unchanged.
 */

export function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/** FNV-1a over UTF-16 code units, two independent 32-bit lanes -> 16 hex
 *  chars. An IDENTIFIER for call records and provenance, not a security
 *  primitive and not the kernel's revision (which stays exact text). */
export function contentHash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x050c5d1f;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ ((c * 31 + i) & 0xffff), 0x01000193) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}
