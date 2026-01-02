## Collaboration Rules

- When I ask a question or describe a problem, start by brainstorming a few potential solutions.
- Show example code for each and help me compare them.
- Ask which one we should try together.

## Implementation Loop

- After I decide, implement the chosen path.
- Keep refining until:
  - In `pnpm test:coverage:once` all tests and pass, and coverage is 100% in the docnode package (you can ignore docsync coverage)
  - In `pnpm fix` all pass.
- Vitest tests should never take more than 4 seconds. If this happens, investigate the regression and let us know so we can fix it.

## Tests

- Test files should be highly declarative and easy to understand. Extract repetitive utilities, setup, or cleanup functions into utils.ts files.
- Do your best to ensure that `await tick()` uses the default value of 3ms, or 10ms in some suites. If a longer wait time is required anywhere, it's a sign that there's something that needs optimization.
- The pattern for exporting private APIs is to use class methods and properties prefixed with `private`. TypeScript allows access to these from outside the class using bracket notation. If you don't recognize the method, you may need to change it to `protected` in your source code. Never export top-level internal modules, nor use assertions to cast an internal property.
  - **IMPORTANT**: When writing tests that need to access internal class properties, ALWAYS change those properties from `private` to `protected` in the source code. Then use bracket notation (e.g., `instance["_property"]`) in tests WITHOUT any type assertions (`as`, `as any`, `as unknown as`). Never use type assertions to access private/internal properties - change them to `protected` instead.

## Critical Rules for Agents

**If you cannot execute tests, you MUST fix that problem FIRST before working on anything else.**

- DO NOT assume you fixed a problem if you couldn't run tests to verify
- DO NOT ask the user to run tests and tell you what appears in console
- DO NOT continue with the "original problem" if you can't execute tests
- Tests MUST run successfully in the agent environment to iterate and verify fixes

---

## Troubleshooting

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
