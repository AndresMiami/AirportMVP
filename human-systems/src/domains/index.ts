/**
 * Application-level bootstrap: registers every built-in domain with the
 * engine's registry. Call once before evaluating any system. Engine modules
 * never import this file; the UI provider, services and fixtures do.
 */
import { domainRegistry } from "@/model/domain";
import { HOUSEHOLD_DOMAIN } from "./household/definition";

let registered = false;

export function registerBuiltInDomains(): void {
  if (registered) return;
  domainRegistry.register(HOUSEHOLD_DOMAIN);
  registered = true;
}

/** Test support: forget the bootstrap so a test can re-register. */
export function resetBuiltInDomains(): void {
  registered = false;
}
