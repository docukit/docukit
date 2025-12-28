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
