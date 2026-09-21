---
name: code-review
description: Review a diff for correctness, edge cases, and regressions. One line per finding with location, problem, and fix.
---

# code-review

Review the provided diff or change set.

## Focus

- Correctness: does the code do what it claims?
- Edge cases: empty input, null/undefined, boundaries, concurrency.
- Regressions: does it break existing callers or behavior?
- Error handling: are failures surfaced, not swallowed?
- Tests: is the new behavior covered?

## Rules

- One line per finding: `location — problem — fix`.
- Order findings by severity, highest first.
- Cite the file and line/symbol for every finding.
- Do not restate the diff or praise unchanged code.
- If there are no findings, say so explicitly.

## Output

A flat list of findings. No preamble.