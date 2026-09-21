import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AGENTS_MD_MARKER,
  buildAgentsMdContext,
  findAgentsMdFiles,
  hasAgentsMdContext,
} from "../src/context/agentsmd";

function makeTree(): string {
  const root = mkdtempSync(join(tmpdir(), "agentsmd-"));
  return root;
}

describe("findAgentsMdFiles", () => {
  test("finds nested and parent AGENTS.md nearest-first", () => {
    const root = makeTree();
    try {
      const nested = join(root, "a", "b");
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(root, "AGENTS.md"), "root content");
      writeFileSync(join(nested, "AGENTS.md"), "nested content");

      const files = findAgentsMdFiles(nested, root);
      expect(files).toEqual([
        join(nested, "AGENTS.md"),
        join(root, "AGENTS.md"),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("nonexistent start dir returns [] and does not throw", () => {
    const root = makeTree();
    try {
      const missing = join(root, "does", "not", "exist");
      let files: string[] = [];
      expect(() => {
        files = findAgentsMdFiles(missing, root);
      }).not.toThrow();
      expect(files).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("buildAgentsMdContext", () => {
  test("contains marker and file content", () => {
    const root = makeTree();
    try {
      const file = join(root, "AGENTS.md");
      writeFileSync(file, "hello agents");
      const out = buildAgentsMdContext([file]);
      expect(out).toContain(AGENTS_MD_MARKER);
      expect(out).toContain("hello agents");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("truncates large content to ~8000 chars ending with ellipsis", () => {
    const root = makeTree();
    try {
      const file = join(root, "AGENTS.md");
      writeFileSync(file, "x".repeat(20000));
      const out = buildAgentsMdContext([file]);
      expect(out.length).toBeLessThanOrEqual(8000);
      expect(out.endsWith("…")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("hasAgentsMdContext", () => {
  test("true only when marker present", () => {
    expect(hasAgentsMdContext([`${AGENTS_MD_MARKER} /x]`])).toBe(true);
    expect(hasAgentsMdContext(["no marker here"])).toBe(false);
    expect(hasAgentsMdContext([])).toBe(false);
  });
});
