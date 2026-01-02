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

## Troubleshooting

### Playwright Browser Tests Failing with "Target page, context or browser has been closed"

**Cause 1:** Zombie Playwright processes from previous runs interfere with new browser instances.

**Solution:**

```bash
# Clean up zombie processes
pkill -f "playwright.*test-server"

# Or:
killall -9 "headless_shell"
```

**Prevention:** Use Ctrl+C (not `kill -9`) to stop tests.

---

**Cause 2:** The error appears at the END of test execution when closing the browser, but tests actually ran successfully.

**How to verify tests ran:**

1. Look for test results BEFORE the error:

   ```
   Test Files  15 passed | 2 skipped (18)
        Tests  5 failed | 333 passed | 9 skipped
   ```

2. Check for "Duration" in the output (e.g., `Duration 24.68s`)

3. If you see test results, the tests RAN. The "Target page closed" error is just a cleanup issue.

**When this happens:**

- ✅ Tests executed successfully
- ✅ Results are valid
- ❌ Browser cleanup failed (cosmetic issue)

**If you see the error IMMEDIATELY with "no tests" and Duration < 1s:**

- This is a real problem (browser crashed before loading tests)
- Try the cleanup solution above
- May need to reinstall Playwright: `pnpm exec playwright install chromium --with-deps`

---

### Common Test Failures

**ConstraintError: Key already exists in the object store**

**Cause:** Multiple tests using the same IndexedDB key (usually same docId).

**Solution:** Ensure each test uses unique IDs:

```typescript
const docId = generateDocId(); // Generates unique ID each time
```

**Node already exists in the doc**

**Cause:** ID conflicts when creating nodes, usually from shared state between tests.

**Solution:** Ensure proper test isolation and unique document IDs per test.
