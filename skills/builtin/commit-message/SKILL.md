---
name: commit-message
description: Generate a Conventional Commits message from the staged diff. Subject <=50 chars, body only when the "why" is not obvious.
---

# commit-message

Write a commit message for the currently staged changes.

## Steps

1. Inspect the staged diff (`git diff --cached`) and recent log for style.
2. Pick a Conventional Commits type: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `build`, `ci`.
3. Write the subject: `type(scope): summary`.
   - Imperative mood, lowercase, no trailing period.
   - 50 characters or fewer.
4. Add a body only when the "why" is not obvious from the subject.
   - Separate from the subject with a blank line.
   - Explain motivation and trade-offs, not a restatement of the diff.
5. Never invent changes that are not in the staged diff.

## Output

Return the raw commit message only. No fences, no commentary.