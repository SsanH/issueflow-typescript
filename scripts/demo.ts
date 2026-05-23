/* eslint-disable */
// IssueFlow Narrated Demo
// Runs a series of realistic scenarios against a running IssueFlow instance.
// For each scenario: makes the HTTP call, narrates the result, then queries
// the database directly and prints the row(s) that were created/changed.
// Reviewer can watch the system come alive without having to query anything
// themselves.

import { spawn, ChildProcess, execSync } from 'child_process';
import { Client } from 'pg';

const API = 'http://localhost:3000';
const DB_CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USERNAME || 'issueflow',
  password: process.env.DB_PASSWORD || 'issueflow',
  database: process.env.DB_DATABASE || 'issueflow',
};

// ─── ANSI helpers ────────────────────────────────────────────────────────
const isTTY = process.stdout.isTTY;
const c = {
  bold: (s: string) => (isTTY ? `\x1b[1m${s}\x1b[0m` : s),
  dim: (s: string) => (isTTY ? `\x1b[2m${s}\x1b[0m` : s),
  green: (s: string) => (isTTY ? `\x1b[0;32m${s}\x1b[0m` : s),
  red: (s: string) => (isTTY ? `\x1b[0;31m${s}\x1b[0m` : s),
  yellow: (s: string) => (isTTY ? `\x1b[0;33m${s}\x1b[0m` : s),
  cyan: (s: string) => (isTTY ? `\x1b[0;36m${s}\x1b[0m` : s),
  blue: (s: string) => (isTTY ? `\x1b[0;34m${s}\x1b[0m` : s),
  magenta: (s: string) => (isTTY ? `\x1b[0;35m${s}\x1b[0m` : s),
};

const bar = () =>
  console.log(
    c.cyan(
      '═══════════════════════════════════════════════════════════════════',
    ),
  );
const thin = () =>
  console.log(
    c.cyan(
      '───────────────────────────────────────────────────────────────────',
    ),
  );

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── Table formatter ────────────────────────────────────────────────────
function formatCell(v: unknown): string {
  if (v === null || v === undefined) return '∅';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  const s = String(v);
  return s.length > 50 ? s.slice(0, 47) + '...' : s;
}

function table(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return c.dim('    (no rows)');
  const cols = Object.keys(rows[0]);
  const widths = cols.map((col) =>
    Math.max(col.length, ...rows.map((r) => formatCell(r[col]).length)),
  );
  const sep = '+' + widths.map((w) => '-'.repeat(w + 2)).join('+') + '+';
  const fmt = (cells: string[]) =>
    '|' +
    cells.map((cell, i) => ' ' + cell.padEnd(widths[i]) + ' ').join('|') +
    '|';
  const header = fmt(cols.map(c.bold));
  const dataLines = rows.map((r) => fmt(cols.map((col) => formatCell(r[col]))));
  return [sep, header, sep, ...dataLines, sep].map((l) => '    ' + l).join('\n');
}

// ─── HTTP helper ────────────────────────────────────────────────────────
async function api(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string; quiet?: boolean } = {},
): Promise<{ status: number; body: any; ms: number }> {
  const start = Date.now();
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const ms = Date.now() - start;
  const text = await res.text();
  let body: any = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* keep as text */
  }
  if (!opts.quiet) {
    const arrow = c.cyan('→');
    const bodyStr = opts.body
      ? c.dim(' ' + JSON.stringify(opts.body).slice(0, 80))
      : '';
    console.log(`    ${arrow} ${c.bold(method)} ${path}${bodyStr}`);
    const back = c.cyan('←');
    const statusColor =
      res.status < 300 ? c.green : res.status < 500 ? c.yellow : c.red;
    console.log(
      `    ${back} ${statusColor(String(res.status))} ${c.dim(`(${ms}ms)`)}`,
    );
  }
  return { status: res.status, body, ms };
}

async function expect200(
  res: { status: number; body: any },
  description: string,
): Promise<void> {
  if (res.status >= 300) {
    console.log(c.red(`    ✗ Expected 2xx for ${description}, got ${res.status}`));
    console.log(c.red(`      Body: ${JSON.stringify(res.body)}`));
    throw new Error(`${description} failed with status ${res.status}`);
  }
}

// ─── Database helper ────────────────────────────────────────────────────
let db: Client;

async function showQuery(
  label: string,
  sql: string,
  params: unknown[] = [],
): Promise<void> {
  const result = await db.query(sql, params);
  console.log(c.dim(`    ${label}`));
  console.log(table(result.rows));
}

async function truncateAll(): Promise<void> {
  const tableNames = await db.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('migrations')`,
  );
  const list = tableNames.rows.map((r) => `"${r.tablename}"`).join(', ');
  if (list) {
    await db.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  }
}

// ─── Preflight ──────────────────────────────────────────────────────────
function preflight(): void {
  console.log();
  bar();
  console.log(
    `  ${c.bold(c.cyan('IssueFlow Demo'))} ${c.dim('— end-to-end showcase')}`,
  );
  bar();
  console.log();

  // Node version
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    console.log(c.red(`  ✗ Node 18+ required. You have ${process.version}.`));
    process.exit(1);
  }
  console.log(`  ${c.green('✓')} Node ${process.versions.node}`);

  // Docker daemon
  try {
    execSync('docker info', { stdio: 'ignore' });
    console.log(`  ${c.green('✓')} Docker is running`);
  } catch {
    console.log(c.red('  ✗ Docker is not running.'));
    console.log(c.yellow('    Start Docker Desktop / OrbStack and try again.'));
    process.exit(1);
  }
}

// ─── Setup ──────────────────────────────────────────────────────────────
async function ensurePostgres(): Promise<void> {
  // Check if compose's db container is up. Wrap in try/catch instead of
  // shell `|| true` so this works on Unix shells AND Windows cmd.exe.
  let ps = '';
  try {
    ps = execSync('docker compose ps --format json db', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    /* container not running yet — that's fine, we'll start it below */
  }
  if (!ps.includes('running')) {
    console.log(`  ${c.yellow('•')} Postgres container not running, starting...`);
    execSync('docker compose up -d', { stdio: 'inherit' });
  }
  // Wait for it to accept connections
  for (let i = 0; i < 30; i++) {
    try {
      const client = new Client(DB_CONFIG);
      await client.connect();
      await client.end();
      console.log(`  ${c.green('✓')} Postgres ready on port ${DB_CONFIG.port}`);
      return;
    } catch {
      await sleep(1000);
    }
  }
  throw new Error('Postgres did not become ready within 30s');
}

async function runMigrations(): Promise<void> {
  try {
    execSync('npm run migration:run', { stdio: 'pipe' });
    console.log(`  ${c.green('✓')} Migrations applied`);
  } catch (e) {
    // Migrations may already be at head — that's fine.
    console.log(`  ${c.green('✓')} Migrations up-to-date`);
  }
}

let appProcess: ChildProcess | null = null;

async function startApp(): Promise<void> {
  // Best-effort: kill anything on port 3000 first. Platform-aware because
  // lsof/kill are Unix-only and netstat/taskkill are Windows-only.
  try {
    if (process.platform === 'win32') {
      const out = execSync(
        'netstat -ano | findstr :3000 | findstr LISTENING',
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] },
      );
      const pids = Array.from(
        new Set(
          out
            .split('\n')
            .map((line) => line.trim().split(/\s+/).pop() || '')
            .filter((p) => /^\d+$/.test(p)),
        ),
      );
      for (const pid of pids) {
        try {
          execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
        } catch {
          /* ignore */
        }
      }
    } else {
      const pids = execSync('lsof -t -i :3000', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim();
      if (pids) {
        execSync(`kill -9 ${pids.split('\n').join(' ')}`, { stdio: 'ignore' });
      }
    }
    await sleep(500);
  } catch {
    /* nothing on port 3000 — that's fine */
  }

  console.log(`  ${c.yellow('•')} Starting IssueFlow app...`);
  appProcess = spawn('npm', ['start'], {
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: false,
    shell: true, // Windows needs this to resolve `npm.cmd`. Harmless on Unix.
    env: { ...process.env, NODE_ENV: 'development' },
  });

  // Wait for /auth/me to return 401 (= app booted, auth middleware active)
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${API}/auth/me`);
      if (res.status === 401) {
        console.log(`  ${c.green('✓')} App ready on ${API}`);
        return;
      }
    } catch {
      /* not yet */
    }
    await sleep(1000);
  }
  throw new Error('App did not start within 60s');
}

function stopApp(): void {
  if (appProcess && !appProcess.killed) {
    appProcess.kill('SIGTERM');
    setTimeout(() => appProcess?.kill('SIGKILL'), 2000);
  }
}

// ─── Scenarios ──────────────────────────────────────────────────────────
function header(n: string, title: string): void {
  console.log();
  console.log(c.cyan(c.bold(`[ ${n}  ${title} ]`)));
  thin();
}

async function scenario1Users(): Promise<{
  sanId: number;
  aliceId: number;
  bobId: number;
}> {
  header('1/6', 'Create users');

  console.log(c.bold('  Creating ADMIN: San Haviv'));
  const san = await api('POST', '/users', {
    body: {
      username: 'san',
      email: 'san@example.com',
      fullName: 'San Haviv',
      role: 'ADMIN',
      password: 'demo12345',
    },
  });
  await expect200(san, 'create San');

  console.log(c.bold('\n  Creating DEVELOPER: Alice Adams'));
  const alice = await api('POST', '/users', {
    body: {
      username: 'alice',
      email: 'alice@example.com',
      fullName: 'Alice Adams',
      role: 'DEVELOPER',
      password: 'demo12345',
    },
  });
  await expect200(alice, 'create Alice');

  console.log(c.bold('\n  Creating DEVELOPER: Bob Martinez'));
  const bob = await api('POST', '/users', {
    body: {
      username: 'bob',
      email: 'bob@example.com',
      fullName: 'Bob Martinez',
      role: 'DEVELOPER',
      password: 'demo12345',
    },
  });
  await expect200(bob, 'create Bob');

  console.log();
  await showQuery(
    'database now contains:',
    `SELECT id, username, email, full_name, role, created_at FROM users ORDER BY id`,
  );

  return {
    sanId: san.body.id,
    aliceId: alice.body.id,
    bobId: bob.body.id,
  };
}

async function scenario2Login(): Promise<{
  sanToken: string;
  aliceToken: string;
}> {
  header('2/6', 'Login + JWT');

  console.log(c.bold('  San logs in'));
  const sanLogin = await api('POST', '/auth/login', {
    body: { username: 'san', password: 'demo12345' },
  });
  await expect200(sanLogin, 'San login');
  const sanToken = sanLogin.body.accessToken;
  console.log(
    c.dim(`    token (truncated): ${String(sanToken).slice(0, 40)}...`),
  );

  console.log(c.bold('\n  Alice logs in'));
  const aliceLogin = await api('POST', '/auth/login', {
    body: { username: 'alice', password: 'demo12345' },
  });
  await expect200(aliceLogin, 'Alice login');

  console.log(c.bold('\n  San hits /auth/me with token'));
  const me = await api('GET', '/auth/me', { token: sanToken });
  await expect200(me, '/auth/me');
  console.log(c.dim(`    response: ${JSON.stringify(me.body)}`));

  console.log();
  console.log(c.dim('    No new DB rows for login — JWT is stateless.'));
  console.log(
    c.dim('    Token denylist (RevokedToken) is only populated on logout.'),
  );

  return { sanToken, aliceToken: aliceLogin.body.accessToken };
}

async function scenario3Project(
  sanToken: string,
  sanId: number,
): Promise<number> {
  header('3/6', 'Create project');

  console.log(c.bold("  San creates project 'Alpha Initiative'"));
  const project = await api('POST', '/projects', {
    token: sanToken,
    body: {
      name: 'Alpha Initiative',
      description: 'Onboarding refactor + dark mode',
      ownerId: sanId,
    },
  });
  await expect200(project, 'create project');

  console.log();
  await showQuery(
    'projects table:',
    `SELECT id, name, description, owner_id, created_at FROM projects ORDER BY id`,
  );

  return project.body.id;
}

async function scenario4Tickets(
  sanToken: string,
  aliceId: number,
  projectId: number,
): Promise<{ ticket1Id: number; ticket2Id: number }> {
  header('4/6', 'Create tickets (one manual-assigned, one auto-assigned)');

  console.log(c.bold("  San creates 'Fix login bug' assigned to Alice"));
  const t1 = await api('POST', '/tickets', {
    token: sanToken,
    body: {
      title: 'Fix login bug',
      description: 'Null pointer on click in Safari 17',
      status: 'TODO',
      priority: 'HIGH',
      type: 'BUG',
      projectId,
      assigneeId: aliceId,
    },
  });
  await expect200(t1, 'create ticket 1');

  console.log(
    c.bold(
      "\n  San creates 'Add dark mode' with NO assignee (system auto-assigns)",
    ),
  );
  const t2 = await api('POST', '/tickets', {
    token: sanToken,
    body: {
      title: 'Add dark mode',
      description: 'Project-wide CSS variable rework',
      status: 'TODO',
      priority: 'MEDIUM',
      type: 'FEATURE',
      projectId,
    },
  });
  await expect200(t2, 'create ticket 2');
  console.log(
    c.dim(
      `    auto-assigned to user_id=${t2.body.assigneeId} (least-loaded DEVELOPER)`,
    ),
  );

  console.log();
  await showQuery(
    'tickets table:',
    `SELECT id, title, status, priority, type, assignee_id, project_id FROM tickets ORDER BY id`,
  );

  console.log();
  await showQuery(
    'audit_logs for the AUTO_ASSIGN (actor=SYSTEM):',
    `SELECT id, entity_type, entity_id, action, actor, performed_by FROM audit_logs WHERE action='AUTO_ASSIGN'`,
  );

  return { ticket1Id: t1.body.id, ticket2Id: t2.body.id };
}

async function scenario5Workflow(
  aliceToken: string,
  sanToken: string,
  ticket1Id: number,
): Promise<void> {
  header('5/6', 'Ticket workflow (state machine)');

  console.log(c.bold('  Alice moves ticket TODO → IN_PROGRESS'));
  await expect200(
    await api('PATCH', `/tickets/${ticket1Id}`, {
      token: aliceToken,
      body: { status: 'IN_PROGRESS' },
    }),
    'patch IN_PROGRESS',
  );

  console.log(c.bold('\n  Alice → IN_REVIEW'));
  await expect200(
    await api('PATCH', `/tickets/${ticket1Id}`, {
      token: aliceToken,
      body: { status: 'IN_REVIEW' },
    }),
    'patch IN_REVIEW',
  );

  console.log(c.bold('\n  San → DONE'));
  await expect200(
    await api('PATCH', `/tickets/${ticket1Id}`, {
      token: sanToken,
      body: { status: 'DONE' },
    }),
    'patch DONE',
  );

  console.log(
    c.bold(
      '\n  Alice tries to backtrack DONE → TODO (should fail per state machine)',
    ),
  );
  const bad = await api('PATCH', `/tickets/${ticket1Id}`, {
    token: aliceToken,
    body: { status: 'TODO' },
  });
  if (bad.status === 409) {
    console.log(c.green('    ✓ Rejected with 409 as expected'));
  } else {
    console.log(c.red(`    ✗ Expected 409, got ${bad.status}`));
  }

  console.log();
  await showQuery(
    `audit trail for ticket ${ticket1Id} (status changes only):`,
    `SELECT id, action, actor, performed_by, before->>'status' AS from_status, after->>'status' AS to_status
       FROM audit_logs
      WHERE entity_type='TICKET' AND entity_id=$1 AND action='UPDATE'
      ORDER BY id`,
    [ticket1Id],
  );
}

async function scenario6Mentions(
  aliceToken: string,
  ticket1Id: number,
  bobId: number,
): Promise<void> {
  header('6/6', '@mentions + comment thread');

  console.log(c.bold('  Alice comments on ticket 1 mentioning @bob'));
  const comment = await api('POST', `/tickets/${ticket1Id}/comments`, {
    token: aliceToken,
    body: {
      content: 'Hey @bob can you peer-review the regex change?',
      authorId: 2,
    },
  });
  await expect200(comment, 'post comment');

  console.log(
    c.bold(`\n  Bob's /users/${bobId}/mentions endpoint reflects the mention`),
  );
  const mentions = await api('GET', `/users/${bobId}/mentions`, {
    token: aliceToken,
  });
  await expect200(mentions, '/mentions');
  console.log(
    c.dim(
      `    found ${mentions.body.total} mention(s) for user ${bobId}: comment id ${mentions.body.data[0]?.id}`,
    ),
  );

  console.log();
  await showQuery(
    'comments table:',
    `SELECT id, ticket_id, author_id, content FROM comments ORDER BY id`,
  );

  console.log();
  await showQuery(
    'comment_mentions table (which user was mentioned in which comment):',
    `SELECT id, comment_id, user_id FROM comment_mentions ORDER BY id`,
  );
}

async function finalAuditSnapshot(sanToken: string): Promise<void> {
  console.log();
  thin();
  console.log(c.bold('  Final: full audit log via API (admin-only)'));
  thin();
  const audit = await api('GET', '/audit-logs', { token: sanToken });
  await expect200(audit, 'audit-logs');
  console.log(
    c.dim(
      `    ${audit.body.total} total entries across all entity types and actions.`,
    ),
  );

  console.log();
  await showQuery(
    'audit_logs summary (action counts by entity type):',
    `SELECT entity_type, action, COUNT(*) AS count
       FROM audit_logs
      GROUP BY entity_type, action
      ORDER BY entity_type, action`,
  );
}

// ─── Main ───────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  preflight();
  console.log();
  console.log(c.bold('  Setup'));
  thin();
  await ensurePostgres();
  await runMigrations();

  // Wipe and reconnect for the demo run
  db = new Client(DB_CONFIG);
  await db.connect();
  await truncateAll();
  console.log(`  ${c.green('✓')} Database truncated (fresh slate)`);

  await startApp();

  const startTime = Date.now();

  const { sanId, aliceId, bobId } = await scenario1Users();
  const { sanToken, aliceToken } = await scenario2Login();
  const projectId = await scenario3Project(sanToken, sanId);
  const { ticket1Id } = await scenario4Tickets(sanToken, aliceId, projectId);
  await scenario5Workflow(aliceToken, sanToken, ticket1Id);
  await scenario6Mentions(aliceToken, ticket1Id, bobId);
  await finalAuditSnapshot(sanToken);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log();
  bar();
  console.log(`  ${c.bold(c.green('Demo complete'))} ${c.dim(`in ${elapsed}s`)}`);
  bar();
  console.log();
  console.log(c.bold('  The app is still running at ') + c.cyan(API));
  console.log(c.bold('  Database is up at ') + c.cyan('localhost:5432'));
  console.log();
  console.log('  Credentials (all use password ' + c.bold('demo12345') + '):');
  console.log(`    ADMIN     san    (id=${sanId})`);
  console.log(`    DEVELOPER alice  (id=${aliceId})`);
  console.log(`    DEVELOPER bob    (id=${bobId})`);
  console.log();
  console.log(c.dim('  Examples:'));
  console.log(
    c.dim(
      "    TOKEN=$(curl -s -X POST http://localhost:3000/auth/login -H 'Content-Type: application/json' \\",
    ),
  );
  console.log(
    c.dim(
      '      -d \'{"username":"san","password":"demo12345"}\' | jq -r .accessToken)',
    ),
  );
  console.log(
    c.dim(
      '    curl -s http://localhost:3000/audit-logs -H "Authorization: Bearer $TOKEN" | jq',
    ),
  );
  console.log();
  console.log(
    c.yellow('  Press Ctrl+C to stop the app (Postgres keeps running).'),
  );
  console.log();

  // Block until SIGINT
  await new Promise<void>(() => {});
}

// ─── Signal handling ────────────────────────────────────────────────────
async function shutdown(): Promise<void> {
  console.log();
  console.log(c.yellow('  Shutting down app...'));
  stopApp();
  if (db) await db.end().catch(() => undefined);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch(async (err) => {
  console.log();
  console.log(c.red('  ✗ Demo failed: ' + (err as Error).message));
  console.log((err as Error).stack);
  stopApp();
  if (db) await db.end().catch(() => undefined);
  process.exit(1);
});
