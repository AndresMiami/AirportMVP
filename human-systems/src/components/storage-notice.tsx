"use client";
/**
 * Shown on every page when the stored data could not be loaded. The app
 * does not substitute a sample, repair or delete anything: the person is
 * told, and the data stays exactly as it is.
 */
import { useModel } from "@/components/model-provider";

export function StorageNotice() {
  const { status, error } = useModel();
  if (status !== "error") return null;
  return (
    <div role="alert" className="mb-4 rounded-md border border-warn bg-warn-soft px-3 py-2 text-sm" data-testid="storage-notice">
      <p className="font-semibold">Stored data could not be loaded.</p>
      <p className="mt-0.5 text-xs">{error}</p>
      <p className="mt-0.5 text-xs">Nothing was changed, replaced or deleted. Export or back up your browser storage before trying another build.</p>
    </div>
  );
}
