// Environment / date context injection.
//
// Ported from oh-my-openagent's `createEnvContext()` / `applyEnvironmentContext`,
// which appended a `<omo-env>` block (timezone + locale) to builtin agent
// prompts (notably the librarian) so date/locale-relative requests are grounded.
//
// astrocode appends it to every persona's system prompt via the
// `experimental.chat.system.transform` hook. Idempotent: the block is only added
// once per system array (detected by the open marker).

export const ENV_CONTEXT_MARKER = "<omo-env>";

export function buildEnvContext(): string {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const locale = Intl.DateTimeFormat().resolvedOptions().locale;
  return [
    "",
    ENV_CONTEXT_MARKER,
    `  Timezone: ${timeZone}`,
    `  Locale: ${locale}`,
    `  Today: ${new Date().toISOString().slice(0, 10)}`,
    "</omo-env>",
  ].join("\n");
}

export function hasEnvContext(system: string[]): boolean {
  return system.some((entry) => entry.includes(ENV_CONTEXT_MARKER));
}
