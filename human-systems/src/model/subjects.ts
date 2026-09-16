/**
 * Subjects of a system. The stored field is `profile.members` (kept for
 * compatibility; it is not migrated) but generic code thinks in SUBJECTS:
 * the whole system, or one of the entities the domain calls by its own
 * `subjectLabel` ("Person", "Segment", "Unit"). The engine never reads a
 * subject's meaning; it only resolves ids.
 */
import type { Member, SystemModel } from "@/types";

/** The system's subjects; archived ones only when asked for. */
export function subjectsOf(model: Pick<SystemModel, "profile">, options: { includeArchived?: boolean } = {}): readonly Member[] {
  return options.includeArchived ? model.profile.members : model.profile.members.filter((m) => m.status === "active");
}

/** Label for a subject id: the system's own name for the system id, a
 *  subject's label otherwise; the id itself when nothing names it. */
export function subjectLabelFor(model: Pick<SystemModel, "id" | "profile">, subjectId: string | null): string {
  if (subjectId === null) return "unassigned";
  if (subjectId === model.id) return model.profile.name;
  return model.profile.members.find((m) => m.id === subjectId)?.label ?? subjectId;
}
