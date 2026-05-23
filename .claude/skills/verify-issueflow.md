---
name: verify-issueflow
description: Use when the user wants to verify the IssueFlow backend implements every PDF/README requirement correctly. Walks each PDF section's happy path AND the negative paths the PDF explicitly calls out (invalid enum values, missing required fields, role-gated endpoints). Reports pass/fail per PDF requirement. PURE CONTRACT CONFORMANCE — does NOT hunt for security vulnerabilities, performance issues, or design smells. The goal is to prove the homework satisfies the spec.
---

# verify-issueflow

You are verifying that the IssueFlow backend satisfies the PDF (`TDP_issueflow_requirements.pdf` one level up from the repo) and the README contract — **nothing more, nothing less**. The PDF and README ARE the rubric. If a scenario isn't in the PDF or README, don't test it.

## Operating principles

- **Spec only.** No security testing (CSV injection, password hash leaks, etc.). No race conditions. No "what would a senior reviewer ding us on." Just "does this endpoint behave the way the PDF says it should."
- **Happy path first.** For each endpoint, run the documented success case. Then run negative cases the PDF explicitly mentions (invalid enum, missing required field, role-gated access).
- **Match response shapes against the README.** If README says `{ id, username, email, fullName, role }` then `passwordHash` must NOT appear (because it's not in the contract — not because of any vulnerability reasoning).
- **Reference PDF sections** by their number (`§2.1`, `§3.5`) in every scenario name, so a reviewer can map each PASS/FAIL back to a requirement line.
- **Don't invent constraints.** PDF says "Role must be one of ADMIN, DEVELOPER" → test that PROJECT_MANAGER returns 400. PDF does NOT say "password is required for registration" → don't test password requirements unless README does (it doesn't; D5 is our addition, leave to a separate spec).
- **Skip what can't be tested via HTTP.** Async cron, multi-instance concurrency, etc. — note as SKIP, point to the e2e test that covers them.

## Phase 1 — Preflight

Working directory should be the repo root (`issueflow-typescript/`). If you're somewhere else, `cd` there first.

1. **Postgres.** `docker compose ps`. If `issueflow-typescript-db-1` isn't running, `docker compose up -d`, wait for `pg_isready`.
2. **`.env` present.** If not, `cp .env.example .env`.
3. **Migrations applied.** `npm run migration:run`.
4. **App boot.** If port 3000 is listening, verify with `curl /auth/me` returns 401 — if so reuse, if not kill the stale process and `npm start > /tmp/app.log 2>&1 &`. Capture PID.
5. **TRUNCATE the DB** so the run starts clean — same SQL the e2e helpers use:
   `TRUNCATE TABLE comment_mentions, comments, ticket_dependencies, attachments, tickets, projects, audit_logs, revoked_tokens, users RESTART IDENTITY CASCADE`.

Abort if any preflight step fails.

## Phase 2 — Walk every PDF section

For each PDF requirement, write a test scenario. Map directly:

### §2.1 User Management
- `POST /users` happy with role=ADMIN → 200, response has `{id, username, email, fullName, role}`, no `passwordHash` key.
- `POST /users` happy with role=DEVELOPER → 200.
- `POST /users` with role=PROJECT_MANAGER → **400** (PDF constraint: role must be ADMIN or DEVELOPER).
- `POST /users` with role=MANAGER → 400.
- `POST /users` with missing role → 400.
- `GET /users` → 200, returns array of users.
- `GET /users/:id` happy → 200, right shape.
- `GET /users/9999` → 404.
- `POST /users/update/:id` updating fullName → 200; subsequent GET reflects the change.
- `POST /users/update/:id` updating role to ADMIN → 200; reflected.
- `POST /users/update/:id` updating role to PROJECT_MANAGER → 400.
- `DELETE /users/:id` → 200; subsequent GET → 404.

### §2.2 Authentication
- `POST /auth/login` with valid creds → 200, body has `{accessToken, tokenType:"Bearer", expiresIn}`.
- `POST /auth/login` with wrong password → 401.
- `POST /auth/login` with unknown user → 401.
- `GET /auth/me` with token → 200, returns user profile.
- `GET /auth/me` without token → 401.
- `POST /auth/logout` → 200.
- After logout, `GET /auth/me` with same token → 401.
- Any protected route without token → 401 (PDF: "must protect all API endpoints").

### §2.3 Project Management
- `POST /projects` happy → 200, response has `{id, name, description, ownerId}`.
- `POST /projects` with bad ownerId → 404.
- `POST /projects` missing name → 400.
- `GET /projects` → 200.
- `GET /projects/:id` → 200.
- `GET /projects/9999` → 404.
- `PATCH /projects/:id` updating name → 200.
- `PATCH /projects/:id` updating description → 200.
- `DELETE /projects/:id` → 200 (soft per §3.5).
- After delete, `GET /projects/:id` → 404 and `GET /projects` does not include it.

### §2.4 Ticket Management
- `POST /tickets` happy with all 7 fields incl. assigneeId → 200, response has expected shape.
- `POST /tickets` with status="WAT" → 400 (PDF: TODO/IN_PROGRESS/IN_REVIEW/DONE).
- `POST /tickets` with priority="URGENT" → 400 (PDF: LOW/MEDIUM/HIGH/CRITICAL).
- `POST /tickets` with type="STORY" → 400 (PDF: BUG/FEATURE/TECHNICAL).
- `POST /tickets` with bad projectId → 404.
- `POST /tickets` with bad assigneeId → 404.
- `POST /tickets` without assigneeId → auto-assigned per §3.8 (200, response has non-null assigneeId).
- `GET /tickets?projectId=X` → 200, array.
- `GET /tickets/:id` → 200.
- `GET /tickets/9999` → 404.
- `PATCH /tickets/:id` updating title → 200, reflected.
- `PATCH /tickets/:id` status forward (TODO → IN_PROGRESS) → 200.
- `PATCH /tickets/:id` status backward (IN_PROGRESS → TODO) → 409 (PDF: "Backward transitions are not allowed").
- `PATCH /tickets/:id` on a DONE ticket → 409 (PDF: "can't be updated once it's DONE").
- `DELETE /tickets/:id` → 200 (soft per §3.5).

### §2.5 Comment Management
- `POST /tickets/:id/comments` happy with content + authorId → 200.
- `POST` with bad ticketId → 404.
- `POST` with empty content → 400.
- `GET /tickets/:id/comments` → 200, array.
- `PATCH /tickets/:id/comments/:cid` updating content → 200.
- `DELETE /tickets/:id/comments/:cid` → 200.

### §3.1 Audit Log
- After any state-changing call above, the matching audit row exists.
- `GET /audit-logs` returns the log.
- `GET /audit-logs?entityType=TICKET` filters to ticket rows.
- `GET /audit-logs?entityId=X` filters to one entity's rows.
- `GET /audit-logs?action=CREATE` filters to create rows.
- `GET /audit-logs?actor=USER` filters to user-initiated rows.

### §3.2 Ticket Dependencies
- `POST /tickets/:id/dependencies` with `{ blockedBy: X }` happy → 200.
- `GET /tickets/:id/dependencies` → array of blockers.
- `DELETE /tickets/:id/dependencies/:blockerId` → 200.
- Cross-project dep → 409 (PDF constraint).
- `PATCH ticket → DONE` while a blocker is non-DONE → 409 (PDF: "cannot transition to DONE if it has unresolved blockers").
- After resolving the blocker, PATCH → DONE → 200.

### §3.3 Attachments
- `POST /tickets/:id/attachments` with valid PNG → 200.
- Upload > 10 MB → 413 (PDF constraint).
- Upload application/octet-stream (disallowed MIME) → 415 (PDF: only png/jpeg/pdf/text allowed).
- Upload valid text/plain → 200.
- `DELETE /tickets/:id/attachments/:aid` → 200.

### §3.4 CSV Export & Import
- `GET /tickets/export?projectId=X` → 200, CSV with header `id,title,description,status,priority,type,assigneeId`.
- Export of ticket with commas/quotes in description → CSV correctly escapes.
- `POST /tickets/import` happy with projectId form field → 200, body has `{created, failed, errors}`.
- Import without projectId form field → 400.
- Import with a row having invalid enum → counted in `failed[]`, line number in errors.

### §3.5 Soft Delete
- `DELETE /tickets/:id` → 200; ticket hidden from default list.
- `GET /tickets/deleted?projectId=X` as ADMIN → 200, includes the deleted ticket.
- `GET /tickets/deleted` as DEVELOPER → 403 (PDF: ADMIN only).
- `POST /tickets/:id/restore` as ADMIN → 200; ticket visible again.
- `POST /tickets/:id/restore` as DEVELOPER → 403.
- Same shape for `/projects/deleted` and `/projects/:id/restore`.

### §3.6 @Mentions
- Comment with `@vrf_dev2` → `mentionedUsers` includes vrf_dev2 with `{id, username, fullName}`.
- Comment with `@VRF_DEV2` (uppercase) → mention resolves (PDF: case-insensitive).
- Comment with `@nonexistent` → `mentionedUsers: []` (no error).
- PATCH comment swapping mentions → list re-evaluated (PDF requirement).
- `GET /users/:id/mentions` → 200, comments newest-first, includes `mentionedUsers` on each.

### §3.7 Escalation
- SKIP: cron not invokable via HTTP. The full LOW→MEDIUM→HIGH→CRITICAL→isOverdue chain is covered by `test/escalation.e2e-spec.ts`. Note in the report that this is intentional.
- Verify the PDF constraint "manual priority change resets is_overdue" testable via PATCH: set isOverdue=true via SQL, PATCH priority, verify isOverdue=false.

### §3.8 Workload + Auto-Assign
- `POST /tickets` without assigneeId → response has a DEVELOPER assigned (PDF: "system queries all DEVELOPER").
- Audit log has an `AUTO_ASSIGN` row with `actor=SYSTEM` for that ticket.
- `GET /projects/:id/workload` → 200, array of `{userId, username, openTicketCount}`.
- Sorted by openTicketCount ASC (PDF requirement).
- Per-project: a ticket assigned to dev2 in another project does NOT bleed into project P's workload (PDF: "within the same project").

## Phase 3 — Report

Print a structured report to stdout. Per-PDF-section pass/fail counts plus a flat list of failures with PDF reference. No "Phase 4 Risk" section, no R-flags, no "recommended next action" coloring. Just: did the implementation satisfy the spec or not?

```
verify-issueflow (PDF spec conformance) — <timestamp>

§2.1 Users          12 PASS / 0 FAIL
§2.2 Auth            8 PASS / 0 FAIL
...

TOTALS: N PASS / M FAIL / K SKIP

Failures:
  [§2.1] role=PROJECT_MANAGER on update should 400 (got 200)
  ...

Skips:
  [§3.7] escalation cron not testable via HTTP — see escalation.e2e-spec.ts
```

## When NOT to invoke this skill

- Looking for security/perf issues — different skill.
- During active dev — too slow, use targeted e2e.
- In CI — already covered by `npm run test:e2e`.
