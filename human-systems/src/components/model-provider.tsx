"use client";
/**
 * React boundary around the model service. Pages read `evaluated` (the
 * output of evaluateSystem) and call `apply` with a pure mutation from
 * services/mutations; the provider persists the result. Pages never touch
 * storage or the calculation library directly.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { evaluateSystem, type EvaluatedSystem } from "@/model/evaluate";
import { LocalStorageModelRepository, type ModelSummary } from "@/repositories";
import { ModelService, MutationError } from "@/services";
import type { IncomeSource, SystemModel, SystemType, Variable } from "@/types";

export type ModelMutation = (model: SystemModel) => SystemModel;

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
  /** True when the active model is the fictional sample. */
  isSample: boolean;
  /** Migration notice for the active model, if it was upgraded on load. */
  migratedFrom: number | null;
  models: ModelSummary[];
  /** Apply a pure mutation; returns false (and sets lastError) on refusal. */
  apply: (mutation: ModelMutation) => boolean;
  updateVariable: (patch: Partial<Variable> & { id: string }) => void;
  updateIncomeSource: (patch: Partial<IncomeSource> & { id: string }) => void;
  replaceModel: (model: SystemModel) => void;
  createBlank: (input: { name: string; systemType: SystemType; location?: string }) => Promise<void>;
  switchModel: (id: string) => Promise<void>;
  deleteModel: (id: string) => Promise<void>;
  resetToSample: () => Promise<void>;
}

const ModelContext = createContext<ModelContextValue | null>(null);

export function ModelProvider({ children }: { children: React.ReactNode }) {
  const serviceRef = useRef<ModelService | null>(null);
  const repoRef = useRef<LocalStorageModelRepository | null>(null);
  const [status, setStatus] = useState<ModelContextValue["status"]>("loading");
  const [error, setError] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [model, setModel] = useState<SystemModel | null>(null);
  const [seeded, setSeeded] = useState(false);
  const [migratedFrom, setMigratedFrom] = useState<number | null>(null);
  const [models, setModels] = useState<ModelSummary[]>([]);

  const refreshList = useCallback(async () => {
    if (!serviceRef.current) return;
    setModels(await serviceRef.current.listModels());
  }, []);

  useEffect(() => {
    // localStorage is only available in the browser, so the service is
    // created inside the effect and the first render shows "loading".
    const repo = new LocalStorageModelRepository(window.localStorage);
    const service = new ModelService(repo);
    repoRef.current = repo;
    serviceRef.current = service;
    service
      .loadActiveOrSeed()
      .then(async ({ model, seeded }) => {
        setModel(model);
        setSeeded(seeded);
        setMigratedFrom(repo.reports.get(model.id)?.migratedFrom ?? null);
        setModels(await service.listModels());
        setStatus("ready");
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setStatus("error");
      });
  }, []);

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

  const updateIncomeSource = useCallback<ModelContextValue["updateIncomeSource"]>(
    (patch) => {
      if (!model || !serviceRef.current) return;
      const service = serviceRef.current;
      apply((m) => service.updateIncomeSource(m, patch));
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
      await refreshList();
    },
    [refreshList],
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
    await activate(await serviceRef.current.resetSample(), true);
  }, [activate]);

  const evaluated = useMemo(() => (model ? evaluateSystem(model) : null), [model]);

  const value = useMemo<ModelContextValue>(
    () => ({
      status,
      error,
      lastError,
      clearError: () => setLastError(null),
      model,
      evaluated,
      seededFromSample: seeded,
      isSample: model?.id === "sample_household_okafor_reyes",
      migratedFrom,
      models,
      apply,
      updateVariable,
      updateIncomeSource,
      replaceModel,
      createBlank,
      switchModel,
      deleteModel,
      resetToSample,
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
      apply,
      updateVariable,
      updateIncomeSource,
      replaceModel,
      createBlank,
      switchModel,
      deleteModel,
      resetToSample,
    ],
  );

  return <ModelContext.Provider value={value}>{children}</ModelContext.Provider>;
}

export function useModel(): ModelContextValue {
  const ctx = useContext(ModelContext);
  if (!ctx) throw new Error("useModel must be used inside ModelProvider");
  return ctx;
}
