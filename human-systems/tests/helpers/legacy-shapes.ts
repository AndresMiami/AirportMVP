/**
 * Fold a current (schema v5) record back into the schema-v4 storage shape
 * so migration fixtures built from the sample stay faithful: the universal
 * `incomeSources` field and `incomeSourceIds` event links.
 */
type Raw = Record<string, unknown>;

export function foldCollectionsToV4(raw: Raw): Raw {
  const { collections, ...rest } = raw;
  const envelope = collections && typeof collections === "object" ? (collections as Raw).incomeSources : undefined;
  const items = envelope && typeof envelope === "object" ? ((envelope as Raw).items as Raw[]) ?? [] : [];
  const events = Array.isArray(rest.events)
    ? (rest.events as Raw[]).map((e) => {
        const links = (e.links ?? {}) as Raw;
        const { collectionItemRefs, ...other } = links;
        const refs = Array.isArray(collectionItemRefs) ? (collectionItemRefs as Raw[]) : [];
        return { ...e, links: { ...other, incomeSourceIds: refs.filter((r) => r.collection === "incomeSources").map((r) => r.id) } };
      })
    : rest.events;
  return { ...rest, schemaVersion: 4, incomeSources: items, events };
}
