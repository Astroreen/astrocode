// Model-id canonicalization for fallback equivalence. Ported from
// oh-my-openagent's model-core (`canonicalizeRuntimeFallbackModelID`,
// `areRuntimeFallbackModelsEquivalent`). Pure and total.
//
// The point: a fallback chain may list the same underlying model under
// different suffixes ("claude-opus-4-7" vs "claude-opus-4-7-thinking") or with
// dotted version separators ("gpt-4.1" vs "gpt-4-1"). Rotating onto one of
// those is not a real fallback, so `pickFallbackModel` skips them.

// Local splitter (mirrors parseModelString in ./index) kept here on purpose to
// avoid a circular import between index.ts and canonicalize.ts.
function splitModel(
  value: string,
): { providerID: string; modelID: string } | undefined {
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return undefined;
  return {
    providerID: trimmed.slice(0, slash),
    modelID: trimmed.slice(slash + 1),
  };
}

export function canonicalizeModelID(modelID: string): string {
  const dotted = modelID.toLowerCase().split(".").join("-");

  if (
    dotted.startsWith("claude-opus-") ||
    dotted.startsWith("claude-sonnet-") ||
    dotted.startsWith("claude-haiku-")
  ) {
    return dotted
      .replace(/-thinking$/i, "")
      .replace(/-max$/i, "")
      .replace(/-high$/i, "");
  }

  return dotted;
}

export function areModelsEquivalent(
  a: string | undefined,
  b: string | undefined,
): boolean {
  if (!a || !b) return false;

  const parsedA = splitModel(a);
  const parsedB = splitModel(b);

  if (!parsedA || !parsedB) {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
  }

  return (
    parsedA.providerID.toLowerCase() === parsedB.providerID.toLowerCase() &&
    canonicalizeModelID(parsedA.modelID) === canonicalizeModelID(parsedB.modelID)
  );
}