import { test, expect, describe, beforeEach } from "bun:test";
import {
  maybeContinueIdle,
  resetIdleContinuationState,
  getIdleBackoffState,
} from "../src/idle/continue";
import { MAX_CONSECUTIVE_FAILURES } from "../src/idle/constants";

function fakeClient(initialTodos: unknown[]) {
  let todos = initialTodos;
  const sent: unknown[] = [];
  return {
    sent,
    setTodos(next: unknown[]) {
      todos = next;
    },
    client: {
      session: {
        todo: async () => ({ data: todos }),
        prompt: async (args: unknown) => {
          sent.push(args);
          return { data: {} };
        },
      },
    } as any,
  };
}

const pending = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ status: "pending", content: `task ${i}` }));

describe("idle continuation backoff", () => {
  beforeEach(() => {
    resetIdleContinuationState();
  });

  test("first idle continues; second within effective cooldown is gated", async () => {
    const { client, sent } = fakeClient(pending(2));

    const first = await maybeContinueIdle(client, "s1", { now: 0 });
    expect(first.continued).toBe(true);
    expect(sent.length).toBe(1);

    const second = await maybeContinueIdle(client, "s1", { now: 0 });
    expect(second.continued).toBe(false);
    expect(second.reason).toBe("cooldown");
    expect(sent.length).toBe(1);
  });

  test("caps at max-failures after repeated non-productive sends", async () => {
    const { client, sent } = fakeClient(pending(2));

    // First send succeeds; each subsequent call is non-productive (same count).
    let now = 0;
    const first = await maybeContinueIdle(client, "s2", { now, max: 100 });
    expect(first.continued).toBe(true);

    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
      now += 100_000;
      const result = await maybeContinueIdle(client, "s2", { now, max: 100 });
      if (i < MAX_CONSECUTIVE_FAILURES - 1) {
        expect(result.continued).toBe(true);
      } else {
        expect(result.continued).toBe(false);
        expect(result.reason).toBe("max-failures");
      }
    }
    expect(getIdleBackoffState("s2").consecutiveFailures).toBe(MAX_CONSECUTIVE_FAILURES);
    expect(sent.length).toBe(MAX_CONSECUTIVE_FAILURES);
  });

  test("a productive send resets consecutiveFailures to 0", async () => {
    const { client } = fakeClient(pending(3));

    await maybeContinueIdle(client, "s3", { now: 0 });
    await maybeContinueIdle(client, "s3", { now: 1_000_000 });
    expect(getIdleBackoffState("s3").consecutiveFailures).toBe(1);

    // Fewer incomplete todos -> productive.
    client.session.todo = async () => ({ data: pending(2) });
    const productive = await maybeContinueIdle(client, "s3", { now: 2_000_000 });
    expect(productive.continued).toBe(true);
    expect(getIdleBackoffState("s3").consecutiveFailures).toBe(0);
  });

  test("continuation resumes once injected time passes the cooldown", async () => {
    const { client } = fakeClient(pending(2));

    await maybeContinueIdle(client, "s4", { now: 0 });
    const blocked = await maybeContinueIdle(client, "s4", { now: 0 });
    expect(blocked.reason).toBe("cooldown");

    const resumed = await maybeContinueIdle(client, "s4", { now: 100_000 });
    expect(resumed.continued).toBe(true);
  });
});