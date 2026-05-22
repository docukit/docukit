Thanks for contributing to Docukit!

## Local Development

### Prerequisites

- Node.js >= 22
- [pnpm](https://pnpm.io/) 9.10+

### Getting Started

```bash
pnpm install
pnpm dev
```

`pnpm dev` automatically:

1. Launches the docs site with [Turbo](https://turbo.build/)
2. Starts the DocSync examples server on port 8081

The two main apps are:

| App      | Port             | Description                                             |
| -------- | ---------------- | ------------------------------------------------------- |
| **docs** | `localhost:3000` | Documentation site and examples playground              |
| DocSync  | `localhost:8081` | WebSocket server used by the examples and homepage demo |

The playground includes two examples:

- **Editor** (`/examples/editor`) — A Lexical rich text editor with real-time collaboration via DocSync. Demonstrates `docnode-lexical` integration.
- **Subdocs** (`/examples/subdocs`) — Hierarchical document structure with nested navigation. Shows how to build tree-based UIs with DocNode.

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
