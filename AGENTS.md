# Working in this repository

Rules for any person or agent working on Inferest. Read this file, then `docs/08-status.md` in full, then the Decisions table in `README.md`, before doing anything else.

## Start here

1. Read `docs/08-status.md`: what is built, how to run it, what is left, and which decisions are still open.
2. Run `npm install`, `npm test` and `npm run typecheck`, and report the counts before starting work. The contracts need `git submodule update --init --recursive` and `forge test`.
3. Pick the next unclaimed item from "What is left" in `docs/08-status.md`, say which one, and look in `docs/superpowers/specs/` for a spec before writing code. The spec is the authority; a plan argues from it.
4. Two secrets never live in the repository and have to come from a founder: the `.env` values (`.env.example` lists the names) and `private/events.md` (submission targets and dates).

## How we work

- One branch per task. A fresh reviewer, with only the diff and the spec, checks it before merge. Merge into `main` with `--no-ff` only when the review is clean. Scan the commits since `origin/main` for secrets, then push `main`.
- Several people and their agents use this repository at the same time, sometimes in one checkout. Run `git branch --show-current` and `git status --short` before any checkout, merge or reset; if the branch is not yours or there are edits you did not make, work in a `git worktree` instead.
- Tests first where the code is testable: `node:test` files sit next to the code under `engine/`, `app/test/` and `agent/test/`. Run them with `node --test --test-timeout=60000 --test-force-exit <files>` so a hung server test cannot stall the run.
- The dashboard pages under `app/dashboard/` are checked in a real browser at 1440 wide against the PNGs in `design/`; screenshots are the acceptance test.

## Never commit

`.env` and any `.env.*` file except `.env.example`; `inferest.db*`; `contracts/deployments/*.json` (the `.gitkeep` stays; a real-chain record is added on purpose with `git add -f`); `app/dashboard/dynamic.bundle.js`; anything under `private/`. Stage files by name, never `git add -A`. Never print the values of an `.env` file into a log, a report or a chat.

## Never write into the repository

The name of a submission event, program, judge or prize, or anything else from `private/`. Say "the first submission" or "the target chain" instead. A real person's name without their consent.

## Prose and commits

- Plain sentences, American spelling, no em dashes. This applies to docs, page copy, comments and commit messages.
- Commit subjects are plain sentences saying what the change does, not conventional-commit prefixes (`git log --oneline -10` shows the style). Add your tool's attribution trailer if it has one.
- Numbers in docs trace to `docs/`, `engine/ledger.ts` or the live pages; nothing is invented.

## Where things are

| | |
|---|---|
| `engine/ledger.ts` | The ledger kernel, source of truth for every number |
| `contracts/` | One Octant ERC-4626 vault per customer, the Splitter, the factory, tests, the deploy script |
| `app/` | Keeper, inference proxy at `/v1`, paid tools over MCP at `/mcp`, HTTP API, the three pages under `app/dashboard/` |
| `agent/` | The hosted financial agent: runner, fence, executor, log, tests |
| `config/` | Per-chain addresses and yield sources |
| `docs/` | Problem, landscape, architecture, economics, risks, workflow, walkthrough, status; specs and plans under `docs/superpowers/` |
| `design/` | pen.dev source, PNG exports, the logo, the How it works prototype |

Claude Code users: `.claude/settings.json` denies reads of `.env` files on purpose; ask the founder to run those commands.
