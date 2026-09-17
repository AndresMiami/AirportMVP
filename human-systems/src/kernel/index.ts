/**
 * PROPOSAL / APPROVAL KERNEL — who is allowed to change what the model says.
 * Proposals are validated and previewed by the engine through the real
 * mutations, reviewed by the person, and applied only through a guarded
 * write. No React, no AI, no household.
 */
export * from "./revision";
export * from "./types";
export * from "./registry";
export * from "./diff";
export * from "./dry-run";
export * from "./fingerprint";
export * from "./proposal-repository";
export * from "./service";
export * from "./wording";
