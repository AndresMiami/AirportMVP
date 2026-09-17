"use client";
/**
 * React boundary around the model service. Pages read `evaluated` (the
 * output of evaluateSystem) and call `apply` with a pure mutation from
 * services/mutations; the provider persists the result. Pages never touch
 * storage or the calculation library directly.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { HOUSEHOLD_APP, householdServiceOptions } from "@/bootstrap/household-app";
import { LocalStorageProposalRepository, ProposalService, type ApproveResult, type RecoveryOutcome } from "@/kernel";
import { domainRegistry, type DomainDefinition } from "@/model/domain";
import { evaluateSystem, type EvaluatedSystem } from "@/model/evaluate";
import { LocalStorageModelRepository, type ModelSummary } from "@/repositories";
import { ModelService, MutationError, type ImportResult } from "@/services";
import type { SystemModel, SystemType, Variable } from "@/types";

export type ModelMutation = (model: SystemModel) => SystemModel;

/** Startup reconciliation of proposals stranded in "applying" for the
 *  active model. Cards that can act are shown only once this is done. */
export type ProposalRecoveryState =
  | { status: "pending"; outcomes: []; message: null }
  | { status: "done"; outcomes: RecoveryOutcome[]; message: null }
  | { status: "error"; outcomes: []; message: string };

interface ModelContextValue {
  status: "loading" | "ready" | "error";
  error: string | null;
  /** Last mutation or persistence error, for the page to display. */
  lastError: string | null;
  clearError: () => void;
  model: SystemModel | null;
  evaluated: EvaluatedSystem | null;
  /** True when the sample was seeded because nothing was stored. */
  seededFromSample: boolean;
  /** True when the active model is the application's seed (the fictional sample). */
  isSample: boolean;
  /** The seed's id and short label, from application configuration. */
  seedId: string | null;
  seedLabel: string | null;
  /** Domains registered for this application, for the creation form. */
  availableDomains: DomainDefinition[];
  /** The domain the creation form pre-selects (application configuration). */
  defaultDomain: { id: string; version: number };
  /** Migration notice for the active model, if it was upgraded on load. */
  migratedFrom: number | null;
  models: ModelSummary[];
  /** "View as of": an ISO date (YYYY-MM-DD, the end of that day) or an ISO
   *  instant. Values and targets are resolved as they applied then; the
   *  structure stays today's. null = today. Reset whenever the active
   *  system changes. */
  asOf: string | null;
  setAsOf: (date: string | null) => void;
  /** Apply a pure mutation; returns false (and sets lastError) on refusal. */
  apply: (mutation: ModelMutation) => boolean;
  updateVariable: (patch: Partial<Variable> & { id: string }) => void;
  replaceModel: (model: SystemModel) => void;
  createBlank: (input: { name: string; systemType: SystemType; domainId: string; domainVersion?: number; location?: string }) => Promise<void>;
  switchModel: (id: string) => Promise<void>;
  deleteModel: (id: string) => Promise<void>;
  resetToSample: () => Promise<void>;
  /** JSON text of the active system with its whole history. */
  exportModel: () => Promise<string>;
  /** Validate, store and activate an exported file. Nothing is stored when
   *  the result is not ok; an existing id is refused unless `replace`. */
  importModel: (text: string, replace: boolean) => Promise<ImportResult>;
  /** The proposal kernel over the SAME service and store; null until storage is ready. */
  proposals: ProposalService | null;
  proposalRecovery: ProposalRecoveryState;
  /** The ONLY approval path: ProposalService.approve -> guarded persistence
   *  -> the persisted model is ADOPTED as React state. Nothing is saved
   *  again, and on any failure React state does not change. */
  approveProposal: (id: string, note?: string) => Promise<ApproveResult>;
}

const ModelContext = createContext<ModelContextValue | null>(null);

export function ModelProvider({ children }: { children: React.ReactNode }) {
  const serviceRef = useRef<ModelService | null>(null);
  const repoRef = useRef<LocalStorageModelRepository | null>(null);
  const proposalsRef = useRef<ProposalService | null>(null);
  const [proposals, setProposals] = useState<ProposalService | null>(null);
  const [proposalRecovery, setProposalRecovery] = useState<ProposalRecoveryState>({ status: "pending", outcomes: [], message: null });
  const [status, setStatus] = useState<ModelContextValue["status"]>("loading");
  const [error, setError] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [model, setModel] = useState<SystemModel | null>(null);
  const [seeded, setSeeded] = useState(false);
  const [migratedFrom, setMigratedFrom] = useState<number | null>(null);
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [asOf, setAsOfState] = useState<string | null>(null);
  // Application configuration is static: resolved once on first render
  // (registering the built-in domains), never re-derived in an effect.
  const [appOptions] = useState(() => householdServiceOptions());
  const seed = useMemo(() => ({ id: appOptions.seed?.id ?? null, label: appOptions.seed?.label ?? null }), [appOptions]);
  // The registry is populated by householdServiceOptions() above, so the
  // list is read once per provider instance (state initializer, no deps).
  const [availableDomains] = useState<DomainDefinition[]>(() => domainRegistry.list());

  const refreshList = useCallback(async () => {
    if (!serviceRef.current) return;
    setModels(await serviceRef.current.listModels());
  }, []);

  /** Reconcile "applying" proposals for a model BEFORE its cards can act. An
   *  unreadable ledger is reported, never emptied. */
  const recoverProposals = useCallback(async (modelId: string) => {
    const svc = proposalsRef.current;
    if (!svc) return;
    setProposalRecovery({ status: "pending", outcomes: [], message: null });
    try {
      const outcomes = await svc.recover(modelId);
      setProposalRecovery({ status: "done", outcomes, message: null });
    } catch (e) {
      setProposalRecovery({ status: "error", outcomes: [], message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  useEffect(() => {
    // localStorage is only available in the browser, so the service is
    // created inside the effect and the first render shows "loading".
    const repo = new LocalStorageModelRepository(window.localStorage);
    const service = new ModelService(repo, appOptions);
    repoRef.current = repo;
    serviceRef.current = service;
    const kernel = new ProposalService(new LocalStorageProposalRepository(window.localStorage), service);
    proposalsRef.current = kernel;
    service
      .loadActiveOrSeed()
      .then(async ({ model, seeded }) => {
        setModel(model);
        setSeeded(seeded);
        setMigratedFrom(repo.reports.get(model.id)?.migratedFrom ?? null);
        setModels(await service.listModels());
        await recoverProposals(model.id);
        setProposals(kernel);
        setStatus("ready");
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setStatus("error");
      });
  }, [appOptions, recoverProposals]);

  const persist = useCallback(
    (next: SystemModel) => {
      setModel(next);
      serviceRef.current
        ?.save(next)
        .then(() => refreshList())
        .catch((e: unknown) => setLastError(e instanceof Error ? e.message : String(e)));
    },
    [refreshList],
  );

  const apply = useCallback<ModelContextValue["apply"]>(
    (mutation) => {
      if (!model) return false;
      try {
        persist(mutation(model));
        setLastError(null);
        return true;
      } catch (e) {
        setLastError(e instanceof MutationError ? e.message : e instanceof Error ? e.message : String(e));
        return false;
      }
    },
    [model, persist],
  );

  const updateVariable = useCallback<ModelContextValue["updateVariable"]>(
    (patch) => {
      if (!model || !serviceRef.current) return;
      const service = serviceRef.current;
      apply((m) => service.updateVariable(m, patch));
    },
    [model, apply],
  );


  const replaceModel = useCallback<ModelContextValue["replaceModel"]>((next) => persist(next), [persist]);

  const activate = useCallback(
    async (next: SystemModel, wasSeeded: boolean) => {
      setModel(next);
      setSeeded(wasSeeded);
      setMigratedFrom(repoRef.current?.reports.get(next.id)?.migratedFrom ?? null);
      setLastError(null);
      setAsOfState(null);
      await refreshList();
      await recoverProposals(next.id);
    },
    [refreshList, recoverProposals],
  );

  const createBlank = useCallback<ModelContextValue["createBlank"]>(
    async (input) => {
      if (!serviceRef.current) return;
      await activate(await serviceRef.current.createBlank(input), false);
    },
    [activate],
  );

  const switchModel = useCallback<ModelContextValue["switchModel"]>(
    async (id) => {
      if (!serviceRef.current) return;
      await activate(await serviceRef.current.switchActive(id), false);
    },
    [activate],
  );

  const deleteModel = useCallback<ModelContextValue["deleteModel"]>(
    async (id) => {
      if (!serviceRef.current) return;
      await serviceRef.current.deleteModel(id);
      const { model: next, seeded } = await serviceRef.current.loadActiveOrSeed();
      await activate(next, seeded);
    },
    [activate],
  );

  const resetToSample = useCallback<ModelContextValue["resetToSample"]>(async () => {
    if (!serviceRef.current) return;
    await activate(await serviceRef.current.resetSeed(), true);
  }, [activate]);

  const exportModel = useCallback<ModelContextValue["exportModel"]>(async () => {
    if (!serviceRef.current || !model) throw new Error("No active system to export.");
    return serviceRef.current.exportModel(model.id);
  }, [model]);

  const importModel = useCallback<ModelContextValue["importModel"]>(
    async (text, replace) => {
      if (!serviceRef.current) return { ok: false, error: "Storage is not ready yet." };
      const result = await serviceRef.current.importModel(text, { replace });
      if (result.ok) {
        // Same path as switchModel: the service marks it active and the
        // stored copy is what the provider holds from now on.
        const stored = await serviceRef.current.switchActive(result.model.id);
        await activate(stored, false);
        setMigratedFrom(result.migratedFrom);
      }
      return result;
    },
    [activate],
  );

  const approveProposal = useCallback<ModelContextValue["approveProposal"]>(async (id, note = "") => {
    const kernel = proposalsRef.current;
    if (!kernel) throw new Error("Storage is not ready yet.");
    const result = await kernel.approve(id, note);
    if (result.ok) {
      // ADOPT the persisted model. Deliberately not persist(): the guarded
      // save already wrote it, and a second save would be a second
      // persistence path around the kernel.
      setModel(result.model);
      setLastError(null);
      await refreshList();
    }
    return result;
  }, [refreshList]);

  const setAsOf = useCallback<ModelContextValue["setAsOf"]>((date) => {
    setAsOfState(date && date.trim() !== "" ? date.trim() : null);
  }, []);

  const evaluated = useMemo(() => (model ? evaluateSystem(model, asOf ? { asOf } : {}) : null), [model, asOf]);

  const value = useMemo<ModelContextValue>(
    () => ({
      status,
      error,
      lastError,
      clearError: () => setLastError(null),
      model,
      evaluated,
      seededFromSample: seeded,
      isSample: model !== null && seed.id !== null && model.id === seed.id,
      seedId: seed.id,
      seedLabel: seed.label,
      availableDomains,
      defaultDomain: HOUSEHOLD_APP.defaultDomain,
      migratedFrom,
      models,
      asOf,
      setAsOf,
      apply,
      updateVariable,
      replaceModel,
      createBlank,
      switchModel,
      deleteModel,
      resetToSample,
      exportModel,
      importModel,
      proposals,
      proposalRecovery,
      approveProposal,
    }),
    [
      status,
      error,
      lastError,
      model,
      evaluated,
      seeded,
      migratedFrom,
      models,
      asOf,
      setAsOf,
      apply,
      updateVariable,
      replaceModel,
      createBlank,
      switchModel,
      deleteModel,
      resetToSample,
      exportModel,
      importModel,
      seed,
      availableDomains,
      proposals,
      proposalRecovery,
      approveProposal,
    ],
  );

  return <ModelContext.Provider value={value}>{children}</ModelContext.Provider>;
}

export function useModel(): ModelContextValue {
  const ctx = useContext(ModelContext);
  if (!ctx) throw new Error("useModel must be used inside ModelProvider");
  return ctx;
}
