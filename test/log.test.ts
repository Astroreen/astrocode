import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { configureLogger, log, type LogClient } from "../src/log";

// `ASTROCODE_LOG_LEVEL` is read per call, so these tests can flip it live.
const ORIGINAL_LEVEL = process.env.ASTROCODE_LOG_LEVEL;

afterEach(() => {
  configureLogger(undefined);
  if (ORIGINAL_LEVEL === undefined) delete process.env.ASTROCODE_LOG_LEVEL;
  else process.env.ASTROCODE_LOG_LEVEL = ORIGINAL_LEVEL;
});

interface LogCall {
  body: { service: string; level: string; message: string };
}

function stubClient(): { client: LogClient; calls: LogCall[]; toasts: unknown[] } {
  const calls: LogCall[] = [];
  const toasts: unknown[] = [];
  const client: LogClient = {
    app: {
      log: (options) => {
        calls.push(options as LogCall);
        return Promise.resolve({});
      },
    },
    tui: {
      showToast: (options) => {
        toasts.push(options);
        return Promise.resolve(true);
      },
    },
  };
  return { client, calls, toasts };
}

interface Sinks {
  out: ReturnType<typeof spyOn>;
  warn: ReturnType<typeof spyOn>;
  err: ReturnType<typeof spyOn>;
  restore: () => void;
}

function capture(): Sinks {
  const out = spyOn(console, "log").mockImplementation(() => {});
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const err = spyOn(console, "error").mockImplementation(() => {});
  return {
    out,
    warn,
    err,
    restore: () => {
      out.mockRestore();
      warn.mockRestore();
      err.mockRestore();
    },
  };
}

describe("log levels", () => {
  test("info goes to stdout, never stderr", () => {
    delete process.env.ASTROCODE_LOG_LEVEL;
    const sinks = capture();
    try {
      log.info("hello");
      expect(sinks.out).toHaveBeenCalledTimes(1);
      expect(sinks.err).toHaveBeenCalledTimes(0);
      expect(sinks.warn).toHaveBeenCalledTimes(0);
    } finally {
      sinks.restore();
    }
  });

  test("warn goes to console.warn, not console.error", () => {
    delete process.env.ASTROCODE_LOG_LEVEL;
    const sinks = capture();
    try {
      log.warn("careful");
      expect(sinks.warn).toHaveBeenCalledTimes(1);
      expect(sinks.err).toHaveBeenCalledTimes(0);
      expect(sinks.out).toHaveBeenCalledTimes(0);
    } finally {
      sinks.restore();
    }
  });

  test("error goes to console.error", () => {
    delete process.env.ASTROCODE_LOG_LEVEL;
    const sinks = capture();
    try {
      log.error("boom");
      expect(sinks.err).toHaveBeenCalledTimes(1);
      expect(sinks.out).toHaveBeenCalledTimes(0);
    } finally {
      sinks.restore();
    }
  });

  test("debug is suppressed by default and enabled via ASTROCODE_LOG_LEVEL", () => {
    delete process.env.ASTROCODE_LOG_LEVEL;
    const sinks = capture();
    try {
      log.debug("quiet");
      expect(sinks.out).toHaveBeenCalledTimes(0);

      process.env.ASTROCODE_LOG_LEVEL = "debug";
      log.debug("loud");
      expect(sinks.out).toHaveBeenCalledTimes(1);
    } finally {
      sinks.restore();
    }
  });

  test("ASTROCODE_LOG_LEVEL=error suppresses info and warn", () => {
    process.env.ASTROCODE_LOG_LEVEL = "error";
    const sinks = capture();
    try {
      log.info("nope");
      log.warn("nope");
      log.error("yes");
      expect(sinks.out).toHaveBeenCalledTimes(0);
      expect(sinks.warn).toHaveBeenCalledTimes(0);
      expect(sinks.err).toHaveBeenCalledTimes(1);
    } finally {
      sinks.restore();
    }
  });

  test("unknown level values fall back to info", () => {
    process.env.ASTROCODE_LOG_LEVEL = "verbose";
    const sinks = capture();
    try {
      log.info("shown");
      log.debug("hidden");
      expect(sinks.out).toHaveBeenCalledTimes(1);
    } finally {
      sinks.restore();
    }
  });
});

describe("log routing with a client", () => {
  test("info/warn/debug go to app.log, never to the console", () => {
    delete process.env.ASTROCODE_LOG_LEVEL;
    const { client, calls } = stubClient();
    configureLogger(client);
    const sinks = capture();
    try {
      log.info("hello");
      log.warn("careful");
      process.env.ASTROCODE_LOG_LEVEL = "debug";
      log.debug("quiet");
      expect(calls.map((c) => c.body.level)).toEqual(["info", "warn", "debug"]);
      expect(calls[0]?.body.service).toBe("astrocode");
      expect(calls[0]?.body.message).toBe("hello");
      expect(sinks.out).toHaveBeenCalledTimes(0);
      expect(sinks.warn).toHaveBeenCalledTimes(0);
      expect(sinks.err).toHaveBeenCalledTimes(0);
    } finally {
      sinks.restore();
    }
  });

  test("error still goes to console.error even with a client", () => {
    delete process.env.ASTROCODE_LOG_LEVEL;
    const { client, calls } = stubClient();
    configureLogger(client);
    const sinks = capture();
    try {
      log.error("boom");
      expect(sinks.err).toHaveBeenCalledTimes(1);
      expect(calls).toHaveLength(0);
    } finally {
      sinks.restore();
    }
  });

  test("threshold still gates app.log emission", () => {
    process.env.ASTROCODE_LOG_LEVEL = "error";
    const { client, calls } = stubClient();
    configureLogger(client);
    log.info("nope");
    log.warn("nope");
    expect(calls).toHaveLength(0);
  });

  test("rejected app.log surfaces via console.error with no unhandled rejection", async () => {
    delete process.env.ASTROCODE_LOG_LEVEL;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    const sinks = capture();
    try {
      const client: LogClient = {
        app: {
          log: () => Promise.reject(new Error("log sink down")),
        },
      };
      configureLogger(client);
      log.info("hello");
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toHaveLength(0);
      expect(sinks.err.mock.calls.length).toBeGreaterThan(0);
      expect(sinks.err.mock.calls[0]?.[0]).toBe("[astrocode:log]");
    } finally {
      sinks.restore();
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("toast forwards to client.tui.showToast", () => {
    const { client, toasts } = stubClient();
    configureLogger(client);
    log.toast({ variant: "warning", title: "t", message: "m" });
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toEqual({
      body: { variant: "warning", title: "t", message: "m", duration: undefined },
    });
  });

  test("toast is a no-op without a client", () => {
    configureLogger(undefined);
    expect(() => log.toast({ message: "m" })).not.toThrow();
  });
});
