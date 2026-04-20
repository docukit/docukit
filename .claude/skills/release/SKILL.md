---
name: release
description: Orchestrate a DocuKit release end-to-end. Guides the user through branch creation, bump, sanity-check, changelog drafting, approval, and PR opening. Use this whenever the user says "release", "cut a release", or invokes /release.
---

# Release orchestration

You drive the entire release flow. The user should not have to remember any step — you ask for confirmation at each gate and do the mechanical work in between.

Do not run `pnpm bump` yourself (it is interactive). Do not commit/push until the user explicitly approves the changelog.

## Phase 1 — branch

1. Check `git status --porcelain`. If dirty, stop and tell the user to commit/stash first.
2. Check the current branch with `git rev-parse --abbrev-ref HEAD`.
3. If on `main`, create a release branch from `origin/main`. Use the intended version if known (e.g. `release/v0.3.2`); otherwise use a placeholder you'll rename once the bump fixes the version: `git fetch origin main && git checkout -b release/pending origin/main`.
4. If already on a non-main branch, ask the user: "You are on `<branch>`. Keep this branch for the release, or branch off `origin/main`?"
5. Confirm the branch to the user before moving on.

## Phase 2 — bump

Tell the user to run `pnpm bump` in their terminal and follow the prompts. The script is interactive; do not try to run it non-interactively.

When the user reports the bump is done, continue.

## Phase 3 — sanity check the bump (no user action)

Silently verify the bump makes sense. If anything is off, flag it to the user before drafting notes.

1. Run `git diff --name-only` — should show only `packages/*/package.json` files. Flag anything else.
2. Read each bumped `package.json` and confirm all publishable packages agree on `major.minor.patch`. Alpha packages may carry `-alpha.N`.
3. Derive the target release tag:
   - If at least one publishable package is stable (no `-alpha.`), tag = `v<major>.<minor>.<patch>`.
   - Otherwise (alpha-only release), tag = `v<major>.<minor>.<patch>-alpha.<N>`.
4. Determine the baseline: the most recent `changelog/v*.md` file, or the first commit if none exists.
5. Count commits between baseline and HEAD (`git log BASELINE..HEAD --no-merges --oneline | wc -l`). If zero, stop — there is nothing to release.

## Phase 4 — draft changelog

Produce two files: `changelog/<tag>.md` (committed) and `changelog/<tag>_DISCORD.md` (gitignored).

### Investigating the diff

This repo does **not** use conventional commits. Commit titles are hints, not truth — breaking changes will **not** reliably be marked. You must read the diff itself.

Commands:

- `git log BASELINE..HEAD --no-merges --format='%h %s'` — short SHAs + titles (hints)
- `git diff BASELINE..HEAD -- packages/` — the substantive diff
- `git diff BASELINE..HEAD -- 'packages/*/package.json'` — exports/peerDeps/deps shifts

Classify every change into: **Breaking**, **Features**, **Fixes**, **Docs**, **Internal**.

**Before drafting, sanity-check the bump magnitude against what you find.** If the user picked `patch` but the diff contains breaking changes, or picked `major` but nothing is user-facing, surface that to the user before writing the changelog — they may want to `pnpm bump` again with a different kind.

**Breaking-change patterns — hunt actively:**

- Removed or renamed exports in `src/exports/` (deletions; renamed files)
- Changed function/method signatures: params added/removed/reordered/retyped
- Changed return types on public functions
- Renamed, removed, or retyped fields on exported types/interfaces
- Changed default behavior on the same inputs (behavior change with no API change still breaks consumers that depend on it)
- `exports` field changes in `package.json`: removed subpaths, reordered `types`/`default`
- Peer-dep range bumps that force consumer upgrades
- Removed or renamed public constants/enums

For every breaking change, include a **Migration:** note that tells the consumer exactly what to change.

**Features / Fixes / Docs / Internal:**

- **Features**: new public exports, new options/props, new subpaths.
- **Fixes**: behavior-correcting diffs in existing code paths with no API change.
- **Docs**: changes under `docs/`. Only note if user-facing.
- **Internal**: tests, CI, build, refactors with no external effect. Keep short.

Attribute each bullet to a PR number (squash-merge titles often end with `(#123)`) or a short SHA.

### Template — `changelog/<tag>.md`

```
# <tag> — YYYY-MM-DD

## Breaking changes

- [Short description.] **Migration:** [what the consumer changes]. (#123)

## Features

- [Description] (#124)

## Fixes

- [Description] (#125)

## Docs

- ...

## Internal

- ...
```

Rules:

- If no breaking changes were found, write `_No breaking changes in this release._` under that section. **Do not omit the section** — explicit emptiness lets a reviewer catch a false negative.
- Keep bullets user-facing. "Renamed `foo` → `bar`" — not "refactored internal foo helpers".
- Group bullets that share a migration.
- Omit empty Features/Fixes/Docs/Internal sections silently — only Breaking is mandatory.

Use today's date from the environment.

### Discord sibling — `changelog/<tag>_DISCORD.md`

Same content, transformed:

- **No `#` headings.** Use `**BREAKING CHANGES**`, `**FEATURES**`, etc. in bold+caps.
- Emojis per section: 🚨 Breaking, ✨ Features, 🐛 Fixes, 📚 Docs, 🛠 Internal.
- URLs as plain text — paste `https://github.com/docukit/docukit/pull/123` literally. **No `[text](url)` markdown link syntax.**
- Open with a one-line summary: `🚀 DocuKit <tag> released!` then a blank line.
- Keep it skimmable.

This file is gitignored (`changelog/*_DISCORD.md`) — never let it be committed.

## Phase 5 — approval

Show the user:

1. The path of both changelog files.
2. Breaking-change count (prominently if non-zero).
3. Total commit count you analyzed.
4. A short snippet of the changelog (first ~20 lines) inline.
5. "Review `<path>` and tell me: approve, revise, or abort."

Wait for explicit approval before continuing. If the user asks for revisions, edit the file and re-show. Do not proceed on implicit agreement.

## Phase 6 — commit and push

On approval:

1. `git add changelog/<tag>.md packages/*/package.json`.
2. Verify `git status` shows only expected files. If `_DISCORD.md` shows up, abort and check `.gitignore`. If `docs/package.json` or `examples/package.json` appear, abort — those are private and should never change during a release.
3. `git commit -m "chore: release <tag>"`.
4. `git push -u origin HEAD`.

## Phase 7 — open the PR

`gh pr create --base main --title "chore: release <tag>" --body "Release PR. See \`changelog/<tag>.md\` for notes."`

Report the PR URL back. Remind the user:

- The `validate` workflow job runs on PR open — it should turn green.
- Merging into main (squash merge) triggers the `publish` job, which pushes to npm and creates the GitHub release.
- The Discord copy is ready at `changelog/<tag>_DISCORD.md` for after publish.
