---
name: verify-before-done
description: Evidence gate checklist before claiming a task is done. Run tests and typecheck, report observed output faithfully, never claim done without evidence.
---

# verify-before-done

Do not claim a task is complete until every item below is checked.

## Checklist

1. Run the relevant tests. Capture the actual pass/fail counts.
2. Run the typecheck / build for the changed code.
3. Run linters or formatters if the project uses them.
4. Re-read the original request and confirm each requirement is met.
5. Confirm no unrelated files were modified.

## Reporting

- Quote the observed command output; do not paraphrase results.
- If a check was skipped, say so and why.
- If a check failed, report the failure — never hide or soften it.
- "Done" requires observed evidence. Absence of evidence is not success.

## Output

A short checklist with the observed result for each item.