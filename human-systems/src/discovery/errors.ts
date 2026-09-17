/** A deterministic programming/definition error in the discovery layer
 *  (wrong variable kind, malformed interval). Never a data condition:
 *  data conditions are reported as evidence facts, not thrown. */
export class DiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscoveryError";
  }
}
