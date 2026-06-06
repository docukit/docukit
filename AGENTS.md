## Collaboration Rules

- When I ask a question or describe a problem, start by brainstorming a few potential solutions.
- Show example code for each and help me compare them.
- Ask which one we should try together.
- Git commands that only read information are allowed, such as `git status`, `git diff`, `git show`, `git log`, and `git branch --show-current`.
- Do not perform any git action that mutates state unless I explicitly ask for that exact action in the current conversation. This includes staging, unstaging, committing, pushing, branching, switching branches, rebasing, stashing, restoring files, or any other command that mutates git state.

## Git Safety Rules

- Read-only git commands are allowed when they help inspect work, review staged files, compare changes, or understand history.
- Never run `git add`, `git commit`, `git push`, or any other git command that mutates git state unless I explicitly ask for that exact git action in the current conversation.
- Updating a PR, editing documentation, fixing code, or running tests does not imply permission to stage, commit, push, branch, rebase, stash, restore, checkout, or mutate git state.
- If a change is ready but I did not explicitly ask for a git action, leave it unstaged.

## Implementation Loop

- After I decide, implement the chosen path.
- Keep refining until:
  - In `pnpm test:coverage:once` all tests and pass, and coverage is 100% in the docnode package (you can ignore docsync coverage)
  - In `pnpm fix` all pass.
- Vitest tests should never take more than 8 seconds. If this happens, investigate the regression and let us know so we can fix it.

## DocSync Architecture Rules

**CRDT Agnostic:** DocSync must remain completely CRDT-agnostic. It should work with Yjs, Loro, DocNode, or any other CRDT library without inspecting or understanding the structure of operations or documents.

- **NEVER** inspect node IDs, operation contents, or document structure

## Tests

- Test files should be highly declarative and easy to understand. Extract repetitive utilities, setup, or cleanup functions into utils.ts files.
- Use `checkUndoManager(...)` to wrap as much `docnode` test logic as is practical.
- Do your best to ensure that `await tick()` uses the default value of 3ms, or 10ms in some suites. If a longer wait time is required anywhere, it's a sign that there's something that needs optimization.
- The pattern for exporting private APIs is to use class methods and properties prefixed with `private`. TypeScript allows access to these from outside the class using bracket notation. If you don't recognize the method, you may need to change it to `protected` in your source code. Never export top-level internal modules, nor use assertions to cast an internal property.
  - **IMPORTANT**: When writing tests that need to access internal class properties, ALWAYS change those properties from `private` to `protected` in the source code. Then use bracket notation (e.g., `instance["_property"]`) in tests WITHOUT any type assertions (`as`, `as any`, `as unknown as`). Never use type assertions to access private/internal properties - change them to `protected` instead.
  - **Accepted exception:** `@docukit/docnode-lexical` may export `_INTERNAL_setupUndoManager` for tests that need to validate the undo binding without mounting React.

## TypeScript Rules

- **NEVER add `any` (or `as any`, `as unknown as ...`, etc.) without first stopping, presenting every alternative you can think of, and waiting for explicit approval.** This applies to both implementation code and tests, to both new code and edits to existing code, and to both function signatures (including generic defaults like `<T = any>`) and local values. If TS inference is failing, the right move is to surface the problem and the trade-offs — not to silence it with `any`. Even if the existing code already used `any`, do not preserve it without asking.
- Never call a function with an explicit type parameter. Let TypeScript infer it. For example, write `createQueryResultReducer(...)`, not `createQueryResultReducer<Data>(...)`.

## Critical Rules for Agents

**If you cannot execute tests, you MUST fix that problem FIRST before working on anything else.**

- DO NOT assume you fixed a problem if you couldn't run tests to verify
- DO NOT ask the user to run tests and tell you what appears in console
- DO NOT continue with the "original problem" if you can't execute tests
- Tests MUST run successfully in the agent environment to iterate and verify fixes

---

## Troubleshooting

### `pnpm run check` fails with "Cannot find name 'LayoutProps'" or 'PageProps'

Next.js auto-generates these types in `.next/types/` during `next dev` or `next build`. Run `pnpm dev` (or `pnpm build`) first to generate them, then re-run `pnpm run check`. In CI this is not an issue because `pnpm build` runs before the check.

### Playwright Browser Tests Failing (For AI Agents)

⚠️ **This is an AI agent problem, not a user problem.** Users can run tests normally in their terminal.

**Root Cause:** Cursor's sandbox restricts Chromium's access to macOS display system.

**SOLUTION - ALWAYS use `required_permissions: ["all"]` for browser tests:**

```typescript
run_terminal_cmd({
  command:
    "cd /path/to/project && pnpm test:once tests/path/to/browser.test.ts",
  required_permissions: ["all"], // <-- THIS IS REQUIRED FOR BROWSER TESTS
});
```

**Before running browser tests, clean up processes:**

```bash
pkill -f "vitest" 2>/dev/null || true; killall -9 "headless_shell" 2>/dev/null || true
```

**DO NOT:**

- Run browser tests WITHOUT `required_permissions: ["all"]` - they will fail
- Reinstall Playwright or browsers (wastes time, doesn't fix the issue)
- Create npm scripts for this - it's an agent workflow issue, not a user issue
