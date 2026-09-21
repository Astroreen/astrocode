import { test, expect, describe, beforeEach } from "bun:test";
import {
  clearChildSessions,
  getChildSessionAgent,
  isChildSession,
  registerChildSession,
  registerChildSessionFromInfo,
  unregisterChildSession,
} from "../src/fallback/subagent";

describe("child session registry", () => {
  beforeEach(() => clearChildSessions());

  test("registers a child and exposes its agent", () => {
    registerChildSession("child-1", "explore");
    expect(isChildSession("child-1")).toBe(true);
    expect(getChildSessionAgent("child-1")).toBe("explore");
  });

  test("an agent is optional", () => {
    registerChildSession("child-1");
    expect(isChildSession("child-1")).toBe(true);
    expect(getChildSessionAgent("child-1")).toBeUndefined();
  });

  test("unknown session is not a child", () => {
    expect(isChildSession("nope")).toBe(false);
    expect(getChildSessionAgent("nope")).toBeUndefined();
  });

  test("registerChildSessionFromInfo requires a non-empty parentID", () => {
    expect(registerChildSessionFromInfo({ id: "root", agent: "build" })).toBe(false);
    expect(isChildSession("root")).toBe(false);

    expect(
      registerChildSessionFromInfo({
        id: "child-2",
        parentID: "root",
        agent: "oracle",
      }),
    ).toBe(true);
    expect(isChildSession("child-2")).toBe(true);
    expect(getChildSessionAgent("child-2")).toBe("oracle");
  });

  test("registerChildSessionFromInfo tolerates garbage", () => {
    expect(registerChildSessionFromInfo(undefined)).toBe(false);
    expect(registerChildSessionFromInfo(null)).toBe(false);
    expect(registerChildSessionFromInfo("nope")).toBe(false);
    expect(registerChildSessionFromInfo({ id: 1, parentID: 2 })).toBe(false);
    expect(registerChildSessionFromInfo({ id: "x", parentID: "" })).toBe(false);
    expect(registerChildSessionFromInfo({ id: "", parentID: "root" })).toBe(false);
  });

  test("unregister removes a single child", () => {
    registerChildSession("child-3", "explore");
    registerChildSession("child-4", "oracle");

    unregisterChildSession("child-3");

    expect(isChildSession("child-3")).toBe(false);
    expect(isChildSession("child-4")).toBe(true);
  });

  test("clearChildSessions wipes the registry", () => {
    registerChildSession("child-5");
    clearChildSessions();
    expect(isChildSession("child-5")).toBe(false);
  });
});
