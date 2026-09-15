/**
 * Interpretation layers.
 *
 * The signature engine (compute/compare/gap/questions) is the EMPIRICAL
 * layer: it turns entered evidence into a structural state and says only
 * what the numbers say. Any other reading of a signature — a traditional
 * or cultural interpretation, a practitioner's reading — must be a
 * separate layer implementing this interface, added later as a plugin
 * without modifying the engine. Only the empirical layer ships now.
 */
import { BAND_LABEL } from "./encode";
import type { StructuralSignature } from "@/types/signature";

export interface Interpretation {
  layerId: string;
  dimensionId?: string;
  text: string;
  /** What the statement rests on. */
  basis: string;
  confidence: number | null;
}

export interface InterpretationLayer {
  id: string;
  name: string;
  kind: "empirical" | "traditional" | "practitioner";
  interpret(signature: StructuralSignature): Interpretation[];
}

export const empiricalLayer: InterpretationLayer = {
  id: "empirical",
  name: "Empirical structural reading",
  kind: "empirical",
  interpret(signature) {
    return signature.dimensions.map((d): Interpretation => {
      if (d.state === "unknown") {
        return {
          layerId: "empirical",
          dimensionId: d.dimensionId,
          text: `${d.name}: unknown. ${d.explanation}`,
          basis: `Missing: ${d.missingInformation.join(", ") || "n/a"}`,
          confidence: null,
        };
      }
      return {
        layerId: "empirical",
        dimensionId: d.dimensionId,
        text: `${d.name}: ${d.normalizedValue!.toFixed(2)} (${BAND_LABEL[d.bandState]}; ${d.binaryState} against the ${d.binaryThreshold} threshold) at ${Math.round(d.confidence * 100)}% confidence.`,
        basis: d.explanation,
        confidence: d.confidence,
      };
    });
  },
};

/** Run every layer; results stay grouped by layer so readings are never mixed. */
export function interpret(signature: StructuralSignature, layers: readonly InterpretationLayer[] = [empiricalLayer]) {
  return layers.map((layer) => ({ layer: { id: layer.id, name: layer.name, kind: layer.kind }, interpretations: layer.interpret(signature) }));
}
