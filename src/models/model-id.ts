// Single model-string parser for "provider/model" ids. Pure and total:
// never throws, returns `undefined` for undefined/garbage input.
//
// This is the ONE implementation — previously duplicated in
// src/fallback/index.ts, src/fallback/canonicalize.ts and
// src/idle/continue.ts. Imports nothing from `fallback/` (no cycles).

export interface ModelRef {
  providerID: string;
  modelID: string;
}

// Trim, split on the FIRST "/". No slash, a leading slash or a trailing
// slash → undefined. "a/b/c" → { providerID: "a", modelID: "b/c" }.
export function parseModelString(
  value: string | undefined,
): ModelRef | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return undefined;
  return {
    providerID: trimmed.slice(0, slash),
    modelID: trimmed.slice(slash + 1),
  };
}

// Inverse of parseModelString (round-trip property:
// parseModelString(formatModelString(ref)) equals ref for valid refs).
export function formatModelString(ref: ModelRef): string {
  return `${ref.providerID}/${ref.modelID}`;
}
