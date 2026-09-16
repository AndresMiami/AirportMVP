/**
 * The proposal LEDGER: pending, applied, rejected and stale proposals, per
 * model, in a store SEPARATE from the canonical model. It is also the
 * interim provenance record (who proposed, who approved, when) until
 * entities carry a provenance field. localStorage cannot span this key
 * and the model key in one transaction; the service's two-phase protocol
 * and startup recovery make the pair recoverable instead.
 */
import type { KeyValueStorage } from "@/repositories/local-storage-repository";
import type { MutationProposal } from "./types";

export const PROPOSALS_KEY = "human-systems.proposals.v1";

export interface ProposalRepository {
  list(modelId: string): Promise<MutationProposal[]>;
  get(id: string): Promise<MutationProposal | null>;
  put(proposal: MutationProposal): Promise<void>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryProposalRepository implements ProposalRepository {
  private items = new Map<string, MutationProposal>();
  async list(modelId: string) {
    return [...this.items.values()].filter((p) => p.modelId === modelId).map((p) => structuredClone(p));
  }
  async get(id: string) {
    const p = this.items.get(id);
    return p ? structuredClone(p) : null;
  }
  async put(p: MutationProposal) {
    this.items.set(p.id, structuredClone(p));
  }
  async remove(id: string) {
    this.items.delete(id);
  }
  async clear() {
    this.items.clear();
  }
}

export class LocalStorageProposalRepository implements ProposalRepository {
  constructor(
    private readonly storage: KeyValueStorage,
    private readonly key: string = PROPOSALS_KEY,
  ) {}
  private read(): Record<string, MutationProposal> {
    const raw = this.storage.getItem(this.key);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, MutationProposal>) : {};
    } catch {
      // an unreadable ledger is reported by the service on recovery, never silently emptied on write:
      throw new Error("The proposal ledger is unreadable; nothing is written until it is inspected.");
    }
  }
  private write(all: Record<string, MutationProposal>): void {
    this.storage.setItem(this.key, JSON.stringify(all));
  }
  async list(modelId: string) {
    return Object.values(this.read()).filter((p) => p.modelId === modelId);
  }
  async get(id: string) {
    return this.read()[id] ?? null;
  }
  async put(p: MutationProposal) {
    const all = this.read();
    all[p.id] = p;
    this.write(all);
  }
  async remove(id: string) {
    const all = this.read();
    delete all[id];
    this.write(all);
  }
  async clear() {
    this.storage.removeItem(this.key);
  }
}
