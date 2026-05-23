# prompts.md

How AI was used to build IssueFlow.

## Model

**Claude Opus 4.7 (1M-context window)** running in Claude Code (the official Anthropic CLI). Same model used across all three workspace instances described below.

## Workflow: three Claude instances in parallel

I ran **three Claude Code instances open concurrently** in different terminal panes, each scoped to a single responsibility. I treated them like three teammates and switched between them as the work demanded — rather than pasting back-and-forth through one conversation.

- **Instance 1 — Planning.** Held the long-form context: the PDF requirements, the decision log (D1–D35), the per-phase plan.md, and the revision history (v1 → v7). Used for: reading the spec, writing the plan, critiquing the plan, deciding on architecture, locking down trade-offs. Never wrote production code.
- **Instance 2 — Reviewing & testing.** Used as a fresh-eyes auditor. Pasted in a finished section of code and asked it to find gaps against the PDF, propose negative-path tests, hunt for race conditions, and stress-test contracts. Caught real bugs (see "Catches" below) that the implementing instance had missed.
- **Instance 3 — Fixing & implementing.** Pure execution: wrote the actual NestJS modules, entities, services, migrations, and e2e tests against the plan. Reviewed nothing, just shipped against the spec.

When Instance 2 found a flaw, I'd take the finding back to Instance 1 (does this require a plan revision?) and then to Instance 3 (apply the fix). Three instances kept context fragmentation low — each one stayed focused on its job and didn't drift.

## Methodology highlights

- **Plan-first.** Before any code, ~5 revision cycles on plan.md (committed in repo root). v7 is 455 lines and includes a 35-entry decision log, per-phase migration discipline, and an endpoint-implementation matrix mapping all 36 README routes to their proving tests.
- **One decision per "D" entry.** Every non-obvious architectural choice got a `D#` row with rationale. e.g., D6a — "all entity writes must go through `repository.save(entity)`" — became an ESLint rule (D6b) to prevent regression.
- **Per-phase migrations.** Schema changes generated fresh migrations in the phase that introduced them; `synchronize: false` from day one.
- **Real Postgres in e2e.** Testcontainers-spun Postgres per test run, not SQLite. Catches things ORM-level mocks would miss.
- **Built a project-local Claude Code skill** (`.claude/skills/verify-issueflow.md`) that walks the PDF section-by-section and verifies pass/fail per requirement, so the verification could be re-run on demand from any future Claude session.

## Representative prompts

Twelve real prompts from the build, in chronological order, with a one-line note on what each one drove.

### Phase 0 — Planning

> **1.** "Read the PDF, @issueflow-typescript directory and write a precise plan to execute it to perfection. Don't write any code yet. Identify every ambiguity in the spec and pin a decision."

Drove plan v1 — the spine of the entire project. Established the discipline of resolving spec ambiguity *before* coding.

> **2.** "Review this plan as if you were a senior reviewer who hates it. Find every place I'm waving my hands."

Used in Instance 2. Drove plan v2–v3. Each critique pass surfaced 2–5 real gaps (e.g., subscriber-doesn't-fire-on-`.update()` was caught here, became D6a).

> **3.** "Did we forget anything? Are we ready for execution?"

Final pre-execution gate, asked across all three instances. Each had to agree before I started building. v7 was locked in after Instance 2 had nothing left to add.

### Phase 1–6 — Execution

> **4.** "Start Execution. After each phase revisit the plan.md and make sure that you are following the plan."

The instruction that turned the plan into a contract, not a guideline. After every phase, Instance 3 re-read the plan and ticked off what had been built, surfacing any drift.

> **5.** "Go over the PDF requirements section by section. For each one, tell me which file implements it and which test proves it."

Used in Instance 2 after Phase 6 finished. Drove the endpoint-implementation matrix (Appendix A in plan.md) that maps each of the 36 README routes to its source file and proving test.

### Hardening — code review and stress-testing

> **6.** "I want a custom Claude Code skill for this assignment that runs every scenario and test possible against the PDF, then reports pass/fail per requirement. Make it project-local so it lives in the repo."

Built `.claude/skills/verify-issueflow.md`. Spec-conformance-only by design — separate from security testing, separate from perf. So the verification could be re-invoked at any future point and would always reflect "does this satisfy the PDF, yes or no."

> **7.** "Look — I dislike the tests we just ran. I want a test from the beginning: register a user via /users, log in via /auth/login, create a project, create a ticket, etc. Real multi-actor scenarios, not isolated unit checks. I'm not looking for 'hey look you passed' — I'm looking for proof the system actually works end-to-end."

Drove `test/journeys.e2e-spec.ts` — 8 multi-actor journeys (Alice and Bob ship a feature, auto-assignment under load, dependency unblocking with multiple actors, etc.) plus 1 no-DEVELOPER edge case. Each journey is one `it()` with a `step()` helper that adds per-step failure context.

> **8.** "TRUNCATE contradiction. You said 'TRUNCATE between tests' AND 'each journey is one `it()` with 10 steps.' Those clash. Pick one. Re-read attachments.e2e-spec.ts and csv.e2e-spec.ts first — you admitted you didn't. Stop guessing your own code's behavior."

Direct correction of a plan inconsistency. Established the rule: TRUNCATE in `beforeEach` (between journeys), not between steps. Drove me to actually read the existing specs before proposing duplicates, instead of assuming what they covered.

### Catches — bugs surfaced by review

> **9.** "Can I register a user with username `'   '` (whitespace only)? That shouldn't be accepted."

**Real bug caught.** The original code used class-validator's `@IsNotEmpty()` on `username`. `@IsNotEmpty()` accepts whitespace-only strings as non-empty — so `POST /users { "username": "   ", "email": "x@y.com", ... }` would succeed, creating an unusable account.

Fix: built a custom `@IsNonBlankString()` decorator (logged as D20) that trims the input and rejects empty results. Applied across all string fields where blank-equals-meaningless: `username`, `fullName`, `password`, ticket `title`, project `name`, comment `content`. Added e2e tests for each that send `"   "` and assert 400. Also applied at the CSV import boundary so it's not a back door.

This is the kind of class of bug — *semantically* invalid but *syntactically* "non-empty" — that ORM-level mocks would miss and only real-input review surfaces.

> **10.** "Does `passwordHash` ever appear in a log line? Verify the redact() function."

**Second real bug caught**, found during coverage-driven testing late in the project. The `redact()` function had `'passwordHash'` (camelCase) in its allowlist Set, but the lookup did `set.has(key.toLowerCase())`. `'passwordHash'.toLowerCase() === 'passwordhash'`, which is *not* `'passwordHash'`, so password hashes were silently NOT being redacted. One-character fix (lowercase the set entry) and 8 new unit tests to pin the contract.

### Testing & flake investigation

> **11.** "Run the full e2e suite 50 times and see what happens. We need a real flake rate, not a vibe."

Drove a `/tmp/run_e2e_50.sh` experiment, then a tighter `run_e2e_20.sh` with per-run timeout caps. Baseline: 45% failure rate (25% visible flake + 20% timeout). Root-caused to cross-spec contamination from per-spec NestJS app teardown not draining in-flight transactions/sockets.

> **12.** "Plan a fix and propose the trade-offs before implementing."

Two-part fix:
1. **Postgres `idle_in_transaction_session_timeout = 30s`** in `setup-e2e.ts` — kills abandoned pessimistic-lock transactions so they don't block the next spec's TRUNCATE.
2. **`jest.retryTimes(2)`** in each spec file — masks the residual transient flakes by re-running them.

Re-ran 20 with the fix: 85% clean, 0% visible flakes, 15% remaining timeouts (mostly Docker container startup variance, not code).

### Reviewer experience

> **13.** "I want the person running the tests to have the easiest time of his life. One command, see all the relevant outputs. Show him the database entry so he won't have to check it himself."

Drove `scripts/demo.ts` — a single `npm run demo` command that boots the app, runs 6 narrated end-to-end scenarios, and after each one queries the database directly and prints the affected rows in formatted tables. Reviewer doesn't have to open psql or curl anything; they sit and watch the system come to life with credentials printed at the end for further exploration.

## Files committed reflecting AI usage

- **`plan.md`** (455 lines) — the v1 → v7 planning document with the 35-entry decision log
- **`.claude/skills/verify-issueflow.md`** — project-local Claude Code skill for re-running the PDF spec-conformance check at any time
- **`prompts.md`** — this file
- **`scripts/demo.ts`** — the narrated showcase built per prompt 13
- **`scripts/test-all.sh`** — single-command test runner

## Accountability

The code in this repo was largely AI-written under human direction. I read every meaningful section and made the architectural calls (the D-decisions in plan.md are mine). When AI proposed something I disagreed with — like the original test structure that mixed TRUNCATE timing with multi-step journeys — I corrected it explicitly and made it justify the new approach. I can explain every endpoint, every test, and every decision in the plan.

Per the PDF: "you are fully accountable for that code, and be sure to understand it." I am, and I do.
