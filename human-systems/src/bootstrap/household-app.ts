/**
 * APPLICATION configuration: the product currently shipped is the
 * household experience. This is the ONE place that decides which domains
 * are registered, which domain a new system gets by default in the UI, and
 * which fictional sample seeds an empty browser. The generic service knows
 * none of it; it receives this as options.
 *
 *   engine / services  <-  this file  ->  domain packs, sample data
 */
import { SAMPLE_SYSTEM_ID, createSampleHousehold } from "@/data/sample-household";
import { registerBuiltInDomains } from "@/domains";
import { HOUSEHOLD_DOMAIN_ID, HOUSEHOLD_DOMAIN_VERSION } from "@/domains/household/keys";
import type { SeedConfig, ServiceOptions } from "@/services/model-service";

export const HOUSEHOLD_APP = {
  /** The domain the creation form pre-selects (the user may pick another). */
  defaultDomain: { id: HOUSEHOLD_DOMAIN_ID, version: HOUSEHOLD_DOMAIN_VERSION },
  seed: {
    id: SAMPLE_SYSTEM_ID,
    label: "fictional sample household",
    create: createSampleHousehold,
  } satisfies SeedConfig,
} as const;

/** Service options for the household application: registers the built-in
 *  domains and supplies the sample seed. Tests use the same entry point. */
export function householdServiceOptions(extra: Omit<ServiceOptions, "seed"> = {}): ServiceOptions {
  registerBuiltInDomains();
  return { seed: HOUSEHOLD_APP.seed, ...extra };
}
