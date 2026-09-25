// Leveled logging.
//
// opencode surfaces a plugin's stdout/stderr in the TUI: stdout shows up in the
// raw terminal before the TUI renders (the "dark mono background" flash on
// startup) and stderr is rendered as an error above the TUI. So console output
// is the wrong channel for routine plugin logs.
//
// Route by severity instead:
//
//   debug/info/warn -> client.app.log (opencode's server log file, invisible in
//                      the TUI). Falls back to console when no client is wired
//                      yet (tests, very early init).
//   error           -> console.error (stays visible in the TUI, as intended).
//
// `ASTROCODE_LOG_LEVEL` gates emission: "debug" shows everything, "warn"/"error"
// quiet things down. Unknown values fall back to "info".
//
// `toast` is the deliberate user-facing channel: use it only for events worth a
// TUI notification (e.g. a successful mid-task fallback switch), never for
// routine chatter.

export type LogLevel = "debug" | "info" | "warn" | "error";

export type ToastVariant = "info" | "success" | "warning" | "error";

export interface ToastInput {
  variant?: ToastVariant;
  title?: string;
  message: string;
  duration?: number;
}

// Minimal structural view of the opencode client the logger needs. Kept narrow
// so tests can pass a plain stub without depending on the full SDK type.
export interface LogClient {
  app: {
    log(options: {
      body: {
        service: string;
        level: LogLevel;
        message: string;
        extra?: Record<string, unknown>;
      };
    }): unknown;
  };
  tui?: {
    showToast(options: {
      body: {
        variant: ToastVariant;
        title?: string;
        message: string;
        duration?: number;
      };
    }): unknown;
  };
}

const LOG_PREFIX = "[astrocode]";
const SERVICE = "astrocode";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let client: LogClient | undefined;

// Wire the opencode client once at plugin init so info/warn/debug land in the
// server log instead of the TUI. Passing undefined restores console fallback.
export function configureLogger(next: LogClient | undefined): void {
  client = next;
}

// Read per call (not cached) so tests and long-lived sessions can change the
// level at runtime without re-importing the module.
function threshold(): number {
  const raw = (process.env.ASTROCODE_LOG_LEVEL ?? "").trim().toLowerCase();
  return LEVEL_RANK[raw as LogLevel] ?? LEVEL_RANK.info;
}

function formatArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
  if (arg === undefined) return "undefined";
  if (arg === null) return "null";
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function formatArgs(args: unknown[]): string {
  return args.map(formatArg).join(" ");
}

// Fire-and-forget: logging must never throw or block the host session.
function swallow(result: unknown): void {
  void Promise.resolve(result).catch((err) => {
    try {
      console.error("[astrocode:log]", err);
    } catch {
      /* never throw */
    }
  });
}

function emit(level: LogLevel, args: unknown[]): void {
  if (LEVEL_RANK[level] < threshold()) return;

  // Errors stay on stderr so opencode renders them in the TUI.
  if (level === "error") {
    console.error(LOG_PREFIX, ...args);
    return;
  }

  if (client?.app?.log) {
    swallow(
      client.app.log({
        body: { service: SERVICE, level, message: formatArgs(args) },
      }),
    );
    return;
  }

  // No client wired yet (tests, very early init): keep the old console behavior.
  const sink = level === "warn" ? console.warn : console.log;
  sink(LOG_PREFIX, ...args);
}

export const log = {
  debug: (...args: unknown[]): void => emit("debug", args),
  info: (...args: unknown[]): void => emit("info", args),
  warn: (...args: unknown[]): void => emit("warn", args),
  error: (...args: unknown[]): void => emit("error", args),

  // Deliberate user-facing notification. No-op without a TUI client.
  toast: (input: ToastInput): void => {
    if (!client?.tui?.showToast) return;
    swallow(
      client.tui.showToast({
        body: {
          variant: input.variant ?? "info",
          title: input.title,
          message: input.message,
          duration: input.duration,
        },
      }),
    );
  },
};