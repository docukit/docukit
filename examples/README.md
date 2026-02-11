# DocNode Examples

This directory contains interactive examples showcasing DocNode features.

## Running Examples

```bash
# From the root of the monorepo
pnpm dev:examples

# Or from this directory
cd examples
pnpm dev
```

The examples app runs on `http://localhost:4000`

## Available Examples

### Home (`/`)

Landing page with overview of all examples.

### Editor (`/editor`)

Lexical-based rich text editor with formatting toolbar and dark theme.

- Rich text formatting (bold, italic, underline, strikethrough)
- Heading levels (H1, H2, H3)
- Text alignment
- Undo/redo support

### Subdocs (`/subdocs`)

Hierarchical document structure with nested navigation and real-time sync.

- Creating and managing nested documents
- Real-time synchronization across tabs
- DocNode tree structure
- CRUD operations on document nodes

## Structure

```
examples/
├── app/
│   ├── layout.tsx       # Root layout with sidebar
│   ├── page.tsx         # Landing page
│   ├── editor/          # Lexical editor example
│   └── subdocs/         # Nested docs example
└── package.json
```

## Development

Examples use the latest workspace versions of:

- `docnode` - Core document library
- `@docukit/docsync-react` - React hooks and components for sync
- `lexical` - Rich text editor framework

Changes to these packages will automatically reflect in the examples during development.
