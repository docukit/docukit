## Collaboration Rules

- When I ask a question or describe a problem, start by brainstorming a few potential solutions.
- Show example code for each and help me compare them.
- Ask which one we should try together.

## Implementation Loop

- After I decide, implement the chosen path.
- Keep refining until:
  - In `pnpm test:coverage:once` all tests and pass, and coverage is 100% in the docnode package (you can ignore docsync coverage)
  - In `pnpm fix` all pass.

## Tests

- Test files should be highly declarative and easy to understand. Extract repetitive utilities, setup, or cleanup functions into utils.ts files.
- Do your best to ensure that `await tick(X)` uses an X between 3-5, 6-15 if really necessary, and definitely never greater than 30. Don't be overly cautious. Start with small waits and increase them if needed.
- The pattern for exporting private APIs is to use class methods and properties prefixed with `private`. TypeScript allows access to these from outside the class using bracket notation. If you don't recognize the method, you may need to change it to `protected` in your source code. Never export top-level internal modules, nor use assertions to cast an internal property.
  - **IMPORTANT**: When writing tests that need to access internal class properties, ALWAYS change those properties from `private` to `protected` in the source code. Then use bracket notation (e.g., `instance["_property"]`) in tests WITHOUT any type assertions (`as`, `as any`, `as unknown as`). Never use type assertions to access private/internal properties - change them to `protected` instead.

## Troubleshooting

### Playwright Browser Tests Failing with "Target page, context or browser has been closed"

**Cause:** Zombie Playwright processes from previous runs interfere with new browser instances.

**Solution:**

```bash
# Clean up zombie processes
pkill -f "playwright.*test-server"

# Then run tests
pnpm vitest --run tests/docsync/local-first/realtime.browser.test.ts
```

**Prevention:** Use Ctrl+C (not `kill -9`) to stop tests.
