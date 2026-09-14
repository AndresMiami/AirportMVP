"use client";
/**
 * React boundary around the model service. Pages read `evaluated` (the
 * output of evaluateSystem) and call the few mutation helpers; they never
 * touch storage or the calculation library directly.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { evaluateSystem, type EvaluatedSystem } from "@/model/evaluate";
import { LocalStorageModelRepository } from "@/repositories/local-storage-repository";
import { ModelService } from "@/services/model-service";
import type { IncomeSource, SystemModel, Variable } from "@/types";

interface ModelContextValue {
  status: "loading" | "ready" | "error";
  error: string | null;
  model: SystemModel | null;
  evaluated: EvaluatedSystem | null;
  seededFromSample: boolean;
  updateVariable: (patch: Partial<Variable> & { id: string }) => void;
  updateIncomeSource: (patch: Partial<IncomeSource> & { id: string }) => void;
  replaceModel: (model: SystemModel) => void;
  resetToSample: () => void;
}

const ModelContext = createContext<ModelContextValue | null>(null);

export function ModelProvider({ children }: { children: React.ReactNode }) {
  const serviceRef = useRef<ModelService | null>(null);
  const [status, setStatus] = useState<ModelContextValue["status"]>("loading");
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState<SystemModel | null>(null);
  const [seeded, setSeeded] = useState(false);

  useEffect(() => {
    // localStorage is only available in the browser, so the service is
    // created inside the effect and the first render shows "loading".
    const service = new ModelService(new LocalStorageModelRepository(window.localStorage));
    serviceRef.current = service;
    service
      .loadOrSeed()
      .then(({ model, seeded }) => {
        setModel(model);
        setSeeded(seeded);
        setStatus("ready");
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setStatus("error");
      });
  }, []);

  const persist = useCallback((next: SystemModel) => {
    setModel(next);
    serviceRef.current?.save(next).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : String(e));
    });
  }, []);

  const updateVariable = useCallback<ModelContextValue["updateVariable"]>(
    (patch) => {
      if (!model || !serviceRef.current) return;
      persist(serviceRef.current.updateVariable(model, patch));
    },
    [model, persist],
  );

  const updateIncomeSource = useCallback<ModelContextValue["updateIncomeSource"]>(
    (patch) => {
      if (!model || !serviceRef.current) return;
      persist(serviceRef.current.updateIncomeSource(model, patch));
    },
    [model, persist],
  );

  const replaceModel = useCallback<ModelContextValue["replaceModel"]>((next) => persist(next), [persist]);

  const resetToSample = useCallback(() => {
    serviceRef.current?.resetToSample().then((m) => {
      setModel(m);
      setSeeded(true);
    });
  }, []);

  const evaluated = useMemo(() => (model ? evaluateSystem(model) : null), [model]);

  const value = useMemo<ModelContextValue>(
    () => ({
      status,
      error,
      model,
      evaluated,
      seededFromSample: seeded,
      updateVariable,
      updateIncomeSource,
      replaceModel,
      resetToSample,
    }),
    [status, error, model, evaluated, seeded, updateVariable, updateIncomeSource, replaceModel, resetToSample],
  );

  return <ModelContext.Provider value={value}>{children}</ModelContext.Provider>;
}

export function useModel(): ModelContextValue {
  const ctx = useContext(ModelContext);
  if (!ctx) throw new Error("useModel must be used inside ModelProvider");
  return ctx;
}
