Thanks for contributing to Docukit!

## Local Development

### Prerequisites

- Node.js >= 22
- [pnpm](https://pnpm.io/) 9.10+
- [Docker](https://www.docker.com/) (must be running before starting dev, unless using your own PostgreSQL)

### Getting Started

```bash
pnpm install
pnpm dev
```

`pnpm dev` automatically:

1. Starts a PostgreSQL container via Docker Compose (skipped if `examples/.env` exists)
2. Pushes the database schema (via `drizzle-kit push`)
3. Launches all packages in dev mode with [Turbo](https://turbo.build/)

To use your own PostgreSQL instead of Docker, create `examples/.env`:

```
DOCNODE_DB_URL=postgres://user:password@localhost:5432/dbname
```

The two main apps are:

| App          | Port             | Description                                                       |
| ------------ | ---------------- | ----------------------------------------------------------------- |
| **examples** | `localhost:4000` | Docukit playground (see below) with a DocSync server on port 8081 |
| **docs**     | `localhost:3000` | Documentation site ([docukit.dev](https://docukit.dev))           |

The playground includes two examples:

- **Editor** (`/editor`) — A Lexical rich text editor with real-time collaboration via DocSync. Demonstrates `docnode-lexical` integration.
- **Subdocs** (`/subdocs`) — Hierarchical document structure with nested navigation. Shows how to build tree-based UIs with DocNode.

## Contributor License Agreement (CLA)

By submitting a contribution to this repository, you agree to the following:

1. You grant the repository owner a perpetual, worldwide, royalty-free license to use, modify, distribute and sublicense your contribution.
2. You affirm that your contribution does not contain any third-party code or intellectual property that could violate the repository's license terms.

## Release Process

Releases are driven end-to-end by the `/release` skill in Claude Code. From a clean working tree, run:

```
/release
```

The skill walks you through every step: creating the release branch, running `pnpm bump`, sanity-checking the bump, drafting the changelog, reviewing, and opening the PR. Merging the resulting `chore: release v<version>` PR into `main` triggers the GitHub Actions workflow that publishes to npm and creates the GitHub release.
