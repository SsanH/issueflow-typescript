# run.md

IssueFlow — setup, build, run, and test instructions.

## Prerequisites

- **Node 18+** (Node 20 recommended; tested on 20.x and 24.x)
- **Docker** running (Docker Desktop, OrbStack, or colima)
- macOS / Linux. Untested on Windows.

## Quickstart (recommended)

```bash
npm install
npm run demo
```

That's it. `npm run demo` is a **narrated showcase**: it starts the dev Postgres, boots the app, then runs through 6 realistic scenarios — creating users, logging in, creating a project + tickets, walking a ticket through the state machine, posting an @-mention, and pulling the audit log — printing both the HTTP calls and the resulting **database rows** at each step. The app stays up after the demo so you can keep poking at it.

Expected wall-clock: ~30-40s after the first run (the first run pulls the Postgres image, which can add 30-60s).

Sample output (abbreviated):

```
═══════════════════════════════════════════════════════════════════
  IssueFlow Demo — end-to-end showcase
═══════════════════════════════════════════════════════════════════
  ✓ Node 20.10  ✓ Docker  ✓ Postgres ready  ✓ App on :3000

[ 1/6  Create users ]
───────────────────────────────────────────────────────────────────
  Creating ADMIN: San Haviv
    → POST /users {"username":"san", ...}
    ← 200 (340ms)

    database now contains:
    +----+----------+-------------------+--------------+-----------+
    | id | username | email             | full_name    | role      |
    +----+----------+-------------------+--------------+-----------+
    | 1  | san      | san@example.com   | San Haviv    | ADMIN     |
    | 2  | alice    | alice@example.com | Alice Adams  | DEVELOPER |
    | 3  | bob      | bob@example.com   | Bob Martinez | DEVELOPER |
    +----+----------+-------------------+--------------+-----------+

[ 4/6  Create tickets (one manual-assigned, one auto-assigned) ]
───────────────────────────────────────────────────────────────────
  San creates 'Add dark mode' with NO assignee (system auto-assigns)
    → POST /tickets { ... }
    ← 200 (66ms)
    auto-assigned to user_id=3 (least-loaded DEVELOPER)

    audit_logs for the AUTO_ASSIGN (actor=SYSTEM):
    +----+-------------+-----------+-------------+--------+--------------+
    | id | entity_type | entity_id | action      | actor  | performed_by |
    +----+-------------+-----------+-------------+--------+--------------+
    | 7  | TICKET      | 2         | AUTO_ASSIGN | SYSTEM | ∅            |
    +----+-------------+-----------+-------------+--------+--------------+
...

═══════════════════════════════════════════════════════════════════
  Demo complete in 2.0s

  The app is still running at http://localhost:3000
  Credentials (password: demo12345): admin=san, devs=alice + bob
  Press Ctrl+C to stop the app (Postgres keeps running).
```

After the demo: hit `http://localhost:3000` directly with curl or your tool of choice. Login as `san` / `demo12345` (admin) or `alice` / `demo12345` (developer) and explore. Press **Ctrl+C** when done — the app stops, the Postgres container keeps running.

## Run the formal test suite

```bash
npm run test:all
```

One command runs **14 unit tests** + **189 e2e tests + 2 documented `todo` markers**. Prints a clean pass/fail summary at the end. Wall-clock ~75-120s.

Sample tail:

```
═════════════════════════════════════════════════════════════════
  SUMMARY
═════════════════════════════════════════════════════════════════

  Wall time:  1m 3s (63s total)
  Unit tests: PASS
  E2E tests:  PASS

All tests passed.
```

If you'd rather run pieces separately:

```bash
npm test            # Unit tests only (fast, no DB)
npm run test:e2e    # E2E only (boots ephemeral Postgres via Testcontainers)
npm run test:cov    # Coverage report → ./coverage/
```

### If a test fails

- **Very first e2e run after `git clone`** may time out while Testcontainers pulls the Postgres image (60-120s on a clean machine). Just re-run `npm run test:all`; subsequent runs reuse the cached image and finish in ~75s.
- **Beyond that**, there's a ~5% residual cross-spec flake rate from the conventional NestJS per-spec-app pattern. Transient failures are auto-retried 2x via `jest.retryTimes(2)` so most never surface. If you see a visible failure: re-run once before investigating.

---

## Manual setup (if you don't want the quickstart)

The steps `npm run demo` does for you, listed individually:

### 1. Start the database

```bash
docker compose up -d
```

Brings up Postgres 16 on port 5432 (user/pass/db all `issueflow`).

### 2. Configure environment

```bash
cp .env.example .env
```

Defaults match `compose.yml`. For non-dev, set a real `JWT_SECRET`.

### 3. Run migrations

```bash
npm run migration:run
```

### 4. Build (optional, for production-mode start)

```bash
npm run build
```

### 5. Run the app

```bash
npm run start:dev    # auto-reload, dev mode
npm run start        # nest start (no watch)
npm run start:prod   # node dist/main (after build)
```

API listens on `http://localhost:3000`. Sanity:

```bash
curl -i http://localhost:3000/auth/me
# HTTP/1.1 401 Unauthorized  (auth required, route is alive)
```

## Submission notes

- `prompts.md` (required by README "AI & Agents" section): ✓ included in repo
- `plan.md` (455-line planning doc, v1 → v7 with decision log): ✓ included in repo
- `.claude/skills/verify-issueflow.md` (project-local Claude Code skill): ✓ included in repo
- Public Git repo push + HackerRank submission: user-side step per PDF §5
