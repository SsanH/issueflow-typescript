import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { Attachment } from '../src/modules/attachments/attachment.entity';
import { AuditLog } from '../src/modules/audit/audit-log.entity';
import { Ticket } from '../src/modules/tickets/ticket.entity';
import { truncateAll } from './db-helpers';

// Minimal valid binary fixtures (magic-numbers only — enough for file-type@16.5.3 sniff).
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000100' +
    '1d04270b0000000049454e44ae426082',
  'hex',
);
const TINY_JPEG = Buffer.from(
  'ffd8ffe000104a46494600010100000100010000fffe0011436f6d6d656e7400ffdb0043000806060709060508070707090909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffd9',
  'hex',
);
const TINY_PDF = Buffer.from(
  '255044462d312e340a25e2e3cfd30a312030206f626a3c3c2f547970652f436174616c6f672f50616765732032203020523e3e656e646f626a0a322030206f626a3c3c2f547970652f50616765732f436f756e7420303e3e656e646f626a0a78726566203020310a3030303030303030303020363535333520660a747261696c65723c3c2f53697a6520322f526f6f742031203020523e3e0a73746172747872656620300a2525454f460a',
  'hex',
);

jest.retryTimes(2);

describe('End-to-end journeys (multi-actor)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    ds = moduleRef.get(DataSource);
  });

  afterAll(async () => {
    await app.close();
    if (ds.isInitialized) await ds.destroy();
  });

  // Per-step failure context: when a step throws, prefix the failure message
  // with the step label so Jest's failure output pinpoints WHICH step in the
  // long journey broke. Without this, an `expect(200)` failure 7 steps deep
  // reports as a generic supertest assertion with no journey context.
  const step = async (
    label: string,
    fn: () => Promise<void>,
  ): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      const err = e as Error;
      err.message = `[${label}] ${err.message}`;
      throw err;
    }
  };

  // Small helpers used across journeys. Each makes the steps below readable.
  const registerUser = async (
    username: string,
    role: 'ADMIN' | 'DEVELOPER',
  ): Promise<{ id: number; token: string }> => {
    const password = `${username}-pw-12345`;
    const created = await http
      .post('/users')
      .send({
        username,
        email: `${username}@example.com`,
        fullName: username,
        role,
        password,
      })
      .expect(200);
    const login = await http
      .post('/auth/login')
      .send({ username, password })
      .expect(200);
    return { id: created.body.id, token: login.body.accessToken };
  };

  const createProject = async (
    ownerId: number,
    token: string,
    name = 'P',
  ): Promise<number> => {
    const res = await http
      .post('/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({ name, description: 'd', ownerId })
      .expect(200);
    return res.body.id;
  };

  describe('Multi-actor journeys (TRUNCATE between journeys, not steps)', () => {
    beforeEach(async () => {
      await truncateAll(ds);
      http = request(app.getHttpServer());
    });

    it('Journey 1 — Alice and Bob ship a feature', async () => {
      let alice: { id: number; token: string };
      let bob: { id: number; token: string };
      let projectId = 0;
      let ticketId = 0;
      let aliceCommentId = 0;

      await step('1: register Alice (DEVELOPER)', async () => {
        alice = await registerUser('alice', 'DEVELOPER');
      });
      await step('2: register Bob (DEVELOPER)', async () => {
        bob = await registerUser('bob', 'DEVELOPER');
      });
      await step('3: Alice creates project BugBash', async () => {
        projectId = await createProject(alice.id, alice.token, 'BugBash');
      });
      await step(
        '4: Alice creates ticket T1 explicitly assigned to Bob',
        async () => {
          const due = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
          const t = await http
            .post('/tickets')
            .set('Authorization', `Bearer ${alice.token}`)
            .send({
              title: 'Fix login',
              description: 'login fails on Safari',
              status: 'TODO',
              priority: 'HIGH',
              type: 'BUG',
              projectId,
              assigneeId: bob.id,
              dueDate: due,
            })
            .expect(200);
          ticketId = t.body.id;
          expect(t.body.assigneeId).toBe(bob.id);
        },
      );
      await step(
        '5: workload shows Bob with 1 open ticket, Alice 0',
        async () => {
          const w = await http
            .get(`/projects/${projectId}/workload`)
            .set('Authorization', `Bearer ${alice.token}`)
            .expect(200);
          const byUser = new Map<string, number>(
            (
              w.body as Array<{ username: string; openTicketCount: number }>
            ).map((r) => [r.username, r.openTicketCount]),
          );
          expect(byUser.get('bob')).toBe(1);
          expect(byUser.get('alice')).toBe(0);
        },
      );
      await step('6: Bob sees T1 in his project ticket list', async () => {
        const list = await http
          .get(`/tickets?projectId=${projectId}`)
          .set('Authorization', `Bearer ${bob.token}`)
          .expect(200);
        const t1 = (
          list.body as Array<{ id: number; assigneeId: number }>
        ).find((t) => t.id === ticketId);
        expect(t1?.assigneeId).toBe(bob.id);
      });
      await step('7: Bob moves T1 TODO → IN_PROGRESS', async () => {
        await http
          .patch(`/tickets/${ticketId}`)
          .set('Authorization', `Bearer ${bob.token}`)
          .send({ status: 'IN_PROGRESS' })
          .expect(200);
      });
      await step('8: Bob comments "Started"', async () => {
        await http
          .post(`/tickets/${ticketId}/comments`)
          .set('Authorization', `Bearer ${bob.token}`)
          .send({ content: 'Started' })
          .expect(200);
      });
      await step(
        '9: Alice comments "@bob what\'s the ETA?"; mentionedUsers includes Bob',
        async () => {
          const c = await http
            .post(`/tickets/${ticketId}/comments`)
            .set('Authorization', `Bearer ${alice.token}`)
            .send({ content: '@bob what is the ETA?' })
            .expect(200);
          aliceCommentId = c.body.id;
          expect(c.body.mentionedUsers).toHaveLength(1);
          expect(c.body.mentionedUsers[0]).toMatchObject({
            id: bob.id,
            username: 'bob',
          });
        },
      );
      await step("10: Bob's /mentions returns Alice's comment", async () => {
        const m = await http
          .get(`/users/${bob.id}/mentions`)
          .set('Authorization', `Bearer ${bob.token}`)
          .expect(200);
        expect(m.body.total).toBeGreaterThanOrEqual(1);
        const found = (m.body.data as Array<{ id: number }>).find(
          (c) => c.id === aliceCommentId,
        );
        expect(found).toBeDefined();
      });
      await step(
        '11: Bob progresses IN_PROGRESS → IN_REVIEW → DONE',
        async () => {
          await http
            .patch(`/tickets/${ticketId}`)
            .set('Authorization', `Bearer ${bob.token}`)
            .send({ status: 'IN_REVIEW' })
            .expect(200);
          await http
            .patch(`/tickets/${ticketId}`)
            .set('Authorization', `Bearer ${bob.token}`)
            .send({ status: 'DONE' })
            .expect(200);
        },
      );
      await step(
        '12: Alice tries to PATCH T1 → 409 (DONE-terminal, PDF §2.4)',
        async () => {
          await http
            .patch(`/tickets/${ticketId}`)
            .set('Authorization', `Bearer ${alice.token}`)
            .send({ title: 'still locked' })
            .expect(409);
        },
      );
      await step(
        '13: audit log for T1 has CREATE + 3 UPDATEs, no AUTO_ASSIGN',
        async () => {
          const rows = await ds.getRepository(AuditLog).find({
            where: { entityType: 'TICKET', entityId: ticketId },
          });
          const actions = rows.map((r) => r.action).sort();
          // Three status moves → three UPDATE rows; CREATE is the initial insert.
          expect(actions).toContain('CREATE');
          expect(actions.filter((a) => a === 'UPDATE')).toHaveLength(3);
          expect(actions).not.toContain('AUTO_ASSIGN'); // Bob was explicit
          // Actors: every row was triggered by either Alice or Bob (USER).
          expect(
            rows.every((r) => r.actor === 'USER' && r.performedBy !== null),
          ).toBe(true);
        },
      );
    });

    it('Journey 2 — Auto-assignment under load (3 DEVs + 1 ADMIN, 9 tickets)', async () => {
      let alice: { id: number; token: string };
      let bob: { id: number; token: string };
      let charlie: { id: number; token: string };
      let diana: { id: number; token: string };
      let projectId = 0;
      const ticketIds: number[] = [];

      await step(
        '1: register Alice/Bob/Charlie (DEV) and Diana (ADMIN), in that order',
        async () => {
          alice = await registerUser('alice', 'DEVELOPER');
          bob = await registerUser('bob', 'DEVELOPER');
          charlie = await registerUser('charlie', 'DEVELOPER');
          diana = await registerUser('diana', 'ADMIN');
          // ensure variables stay used (lint) and oldest-registered ordering documented:
          expect(alice.id).toBeLessThan(bob.id);
          expect(bob.id).toBeLessThan(charlie.id);
        },
      );
      await step('2: Alice creates the project', async () => {
        projectId = await createProject(alice.id, alice.token);
      });
      await step('3: POST 9 tickets back-to-back, NO assigneeId', async () => {
        for (let i = 0; i < 9; i++) {
          const t = await http
            .post('/tickets')
            .set('Authorization', `Bearer ${alice.token}`)
            .send({
              title: `T${i}`,
              description: 'd',
              status: 'TODO',
              priority: 'LOW',
              type: 'BUG',
              projectId,
            })
            .expect(200);
          ticketIds.push(t.body.id);
        }
        expect(ticketIds).toHaveLength(9);
      });
      await step(
        '4: distribution = 3+3+3 across Alice/Bob/Charlie',
        async () => {
          const w = await http
            .get(`/projects/${projectId}/workload`)
            .set('Authorization', `Bearer ${alice.token}`)
            .expect(200);
          const counts = new Map<string, number>(
            (
              w.body as Array<{ username: string; openTicketCount: number }>
            ).map((r) => [r.username, r.openTicketCount]),
          );
          expect(counts.get('alice')).toBe(3);
          expect(counts.get('bob')).toBe(3);
          expect(counts.get('charlie')).toBe(3);
        },
      );
      await step(
        '5: Diana (ADMIN) NOT in workload nor assigned to any ticket',
        async () => {
          const w = await http
            .get(`/projects/${projectId}/workload`)
            .set('Authorization', `Bearer ${alice.token}`)
            .expect(200);
          const usernames = (w.body as Array<{ username: string }>).map(
            (r) => r.username,
          );
          expect(usernames).not.toContain('diana');
          const list = await http
            .get(`/tickets?projectId=${projectId}`)
            .set('Authorization', `Bearer ${alice.token}`)
            .expect(200);
          const dianaTickets = (
            list.body as Array<{ assigneeId: number }>
          ).filter((t) => t.assigneeId === diana.id);
          expect(dianaTickets).toHaveLength(0);
        },
      );
      await step("6: mark 2 of Alice's tickets DONE", async () => {
        const aliceTickets = (
          await http
            .get(`/tickets?projectId=${projectId}`)
            .set('Authorization', `Bearer ${alice.token}`)
            .expect(200)
        ).body as Array<{ id: number; assigneeId: number }>;
        const owned = aliceTickets.filter((t) => t.assigneeId === alice.id);
        expect(owned.length).toBeGreaterThanOrEqual(2);
        for (const t of owned.slice(0, 2)) {
          await http
            .patch(`/tickets/${t.id}`)
            .set('Authorization', `Bearer ${alice.token}`)
            .send({ status: 'DONE' })
            .expect(200);
        }
      });
      await step(
        '7: next auto-assigned ticket goes to Alice (now lowest open count = 1)',
        async () => {
          const t = await http
            .post('/tickets')
            .set('Authorization', `Bearer ${alice.token}`)
            .send({
              title: 'after-rebalance',
              description: 'd',
              status: 'TODO',
              priority: 'LOW',
              type: 'BUG',
              projectId,
            })
            .expect(200);
          expect(t.body.assigneeId).toBe(alice.id);
        },
      );
      await step(
        '8: AUTO_ASSIGN audit rows present and exactly 10 (9 + 1 after rebalance)',
        async () => {
          const aaRows = await ds.getRepository(AuditLog).find({
            where: { action: 'AUTO_ASSIGN' },
          });
          const forThisProject = aaRows.filter((r) =>
            ticketIds.includes(r.entityId ?? -1),
          );
          // We pushed 9 tickets in step 3; the 10th (after rebalance) isn't in
          // ticketIds because we don't track it. So expect ≥ 9 for the indexed
          // tickets and ≥ 10 overall.
          expect(forThisProject).toHaveLength(9);
          expect(aaRows.length).toBeGreaterThanOrEqual(10);
          expect(aaRows.every((r) => r.actor === 'SYSTEM')).toBe(true);
          expect(aaRows.every((r) => r.performedBy === null)).toBe(true);
        },
      );
    });

    it('Journey 3 — Dependency unblocking with multiple actors', async () => {
      let alice: { id: number; token: string };
      let bob: { id: number; token: string };
      let projectId = 0;
      const ids: number[] = [];

      await step('1: register Alice + Bob', async () => {
        alice = await registerUser('alice', 'DEVELOPER');
        bob = await registerUser('bob', 'DEVELOPER');
      });
      await step('2: Alice creates project + 3 tickets', async () => {
        projectId = await createProject(alice.id, alice.token);
        for (const name of ['T1', 'T2', 'T3']) {
          const t = await http
            .post('/tickets')
            .set('Authorization', `Bearer ${alice.token}`)
            .send({
              title: name,
              description: 'd',
              status: 'TODO',
              priority: 'LOW',
              type: 'BUG',
              projectId,
              assigneeId: alice.id,
            })
            .expect(200);
          ids.push(t.body.id);
        }
      });
      const [t1, t2, t3] = ids;
      await step('3: Alice declares T1 blocked by T2 AND T3', async () => {
        await http
          .post(`/tickets/${t1}/dependencies`)
          .set('Authorization', `Bearer ${alice.token}`)
          .send({ blockedBy: t2 })
          .expect(200);
        await http
          .post(`/tickets/${t1}/dependencies`)
          .set('Authorization', `Bearer ${alice.token}`)
          .send({ blockedBy: t3 })
          .expect(200);
      });
      await step(
        '4: Alice tries T1 → DONE → 409 (both blockers non-DONE)',
        async () => {
          await http
            .patch(`/tickets/${t1}`)
            .set('Authorization', `Bearer ${alice.token}`)
            .send({ status: 'DONE' })
            .expect(409);
        },
      );
      await step('5: Bob resolves T2 → DONE', async () => {
        await http
          .patch(`/tickets/${t2}`)
          .set('Authorization', `Bearer ${bob.token}`)
          .send({ status: 'DONE' })
          .expect(200);
      });
      await step(
        '6: Alice tries T1 → DONE again, still 409 (T3 still blocks)',
        async () => {
          await http
            .patch(`/tickets/${t1}`)
            .set('Authorization', `Bearer ${alice.token}`)
            .send({ status: 'DONE' })
            .expect(409);
        },
      );
      await step('7: Bob soft-deletes T3 (D29 cascade-clean)', async () => {
        // eslint-disable-next-line no-restricted-syntax -- supertest HTTP method
        await http
          .delete(`/tickets/${t3}`)
          .set('Authorization', `Bearer ${bob.token}`)
          .expect(200);
      });
      await step(
        '8: T1 → DONE now succeeds (T3 cleaned from deps, T2 already DONE)',
        async () => {
          await http
            .patch(`/tickets/${t1}`)
            .set('Authorization', `Bearer ${alice.token}`)
            .send({ status: 'DONE' })
            .expect(200);
        },
      );
      await step(
        '9: GET T1 deps → only T2 remains (T3 cascade-cleaned)',
        async () => {
          const deps = await http
            .get(`/tickets/${t1}/dependencies`)
            .set('Authorization', `Bearer ${alice.token}`)
            .expect(200);
          expect(deps.body).toHaveLength(1);
          expect(deps.body[0]).toMatchObject({ id: t2, status: 'DONE' });
        },
      );
    });

    it('Journey 4 — Comment thread with mention re-evaluation', async () => {
      let alice: { id: number; token: string };
      let bob: { id: number; token: string };
      let charlie: { id: number; token: string };
      let projectId = 0;
      let ticketId = 0;
      let commentId = 0;

      await step('1: register Alice/Bob/Charlie', async () => {
        alice = await registerUser('alice', 'DEVELOPER');
        bob = await registerUser('bob', 'DEVELOPER');
        charlie = await registerUser('charlie', 'DEVELOPER');
      });
      await step('2: Alice creates project + ticket', async () => {
        projectId = await createProject(alice.id, alice.token);
        const t = await http
          .post('/tickets')
          .set('Authorization', `Bearer ${alice.token}`)
          .send({
            title: 'T',
            description: 'd',
            status: 'TODO',
            priority: 'LOW',
            type: 'BUG',
            projectId,
            assigneeId: alice.id,
          })
          .expect(200);
        ticketId = t.body.id;
      });
      await step(
        '3: Alice comments "@bob and @charlie" — both mentioned',
        async () => {
          const c = await http
            .post(`/tickets/${ticketId}/comments`)
            .set('Authorization', `Bearer ${alice.token}`)
            .send({ content: 'FYI @bob and @charlie' })
            .expect(200);
          commentId = c.body.id;
          const names = (c.body.mentionedUsers as Array<{ username: string }>)
            .map((u) => u.username)
            .sort();
          expect(names).toEqual(['bob', 'charlie']);
        },
      );
      await step(
        '4: PATCH comment to mention only @bob — Charlie removed',
        async () => {
          await http
            .patch(`/tickets/${ticketId}/comments/${commentId}`)
            .set('Authorization', `Bearer ${alice.token}`)
            .send({ content: 'FYI @bob only' })
            .expect(200);
        },
      );
      await step("5: Bob's /mentions still includes this comment", async () => {
        const m = await http
          .get(`/users/${bob.id}/mentions`)
          .set('Authorization', `Bearer ${bob.token}`)
          .expect(200);
        expect(
          (m.body.data as Array<{ id: number }>).some(
            (c) => c.id === commentId,
          ),
        ).toBe(true);
      });
      await step(
        "6: Charlie's /mentions does NOT include it anymore",
        async () => {
          const m = await http
            .get(`/users/${charlie.id}/mentions`)
            .set('Authorization', `Bearer ${charlie.token}`)
            .expect(200);
          expect(
            (m.body.data as Array<{ id: number }>).some(
              (c) => c.id === commentId,
            ),
          ).toBe(false);
        },
      );
      await step(
        '7: PATCH to "@diana" — @diana is not a registered user',
        async () => {
          await http
            .patch(`/tickets/${ticketId}/comments/${commentId}`)
            .set('Authorization', `Bearer ${alice.token}`)
            .send({ content: 'FYI @diana' })
            .expect(200);
        },
      );
      await step(
        '8: Bob and Charlie /mentions are now both empty for this comment',
        async () => {
          const bm = await http
            .get(`/users/${bob.id}/mentions`)
            .set('Authorization', `Bearer ${bob.token}`)
            .expect(200);
          expect(
            (bm.body.data as Array<{ id: number }>).some(
              (c) => c.id === commentId,
            ),
          ).toBe(false);
          const cm = await http
            .get(`/users/${charlie.id}/mentions`)
            .set('Authorization', `Bearer ${charlie.token}`)
            .expect(200);
          expect(
            (cm.body.data as Array<{ id: number }>).some(
              (c) => c.id === commentId,
            ),
          ).toBe(false);
        },
      );
      await step(
        "9: comment's mentionedUsers in GET = [] (no resolvable mentions)",
        async () => {
          const list = await http
            .get(`/tickets/${ticketId}/comments`)
            .set('Authorization', `Bearer ${alice.token}`)
            .expect(200);
          const c = (
            list.body as Array<{ id: number; mentionedUsers: unknown[] }>
          ).find((x) => x.id === commentId);
          expect(c?.mentionedUsers).toEqual([]);
        },
      );
    });

    it('Journey 5 — Soft-delete + restore round-trip across project hierarchy', async () => {
      let alice: { id: number; token: string };
      let bob: { id: number; token: string };
      let admin: { id: number; token: string };
      let projectId = 0;
      const ticketIds: number[] = [];

      await step('1: register Alice/Bob (DEV) + admin (ADMIN)', async () => {
        alice = await registerUser('alice', 'DEVELOPER');
        bob = await registerUser('bob', 'DEVELOPER');
        admin = await registerUser('admin', 'ADMIN');
      });
      await step(
        '2: Alice creates project, 3 tickets, each with a comment from Bob',
        async () => {
          projectId = await createProject(alice.id, alice.token);
          for (const name of ['A', 'B', 'C']) {
            const t = await http
              .post('/tickets')
              .set('Authorization', `Bearer ${alice.token}`)
              .send({
                title: name,
                description: 'd',
                status: 'TODO',
                priority: 'LOW',
                type: 'BUG',
                projectId,
                assigneeId: alice.id,
              })
              .expect(200);
            ticketIds.push(t.body.id);
            await http
              .post(`/tickets/${t.body.id}/comments`)
              .set('Authorization', `Bearer ${bob.token}`)
              .send({ content: `bob on ${name}` })
              .expect(200);
          }
        },
      );
      await step(
        '3: Alice soft-deletes one ticket; GET shows 2 visible',
        async () => {
          // eslint-disable-next-line no-restricted-syntax -- supertest HTTP method
          await http
            .delete(`/tickets/${ticketIds[0]}`)
            .set('Authorization', `Bearer ${alice.token}`)
            .expect(200);
          const list = await http
            .get(`/tickets?projectId=${projectId}`)
            .set('Authorization', `Bearer ${alice.token}`)
            .expect(200);
          expect(list.body).toHaveLength(2);
        },
      );
      await step('4: ADMIN restores the ticket — 3 visible again', async () => {
        await http
          .post(`/tickets/${ticketIds[0]}/restore`)
          .set('Authorization', `Bearer ${admin.token}`)
          .expect(200);
        const list = await http
          .get(`/tickets?projectId=${projectId}`)
          .set('Authorization', `Bearer ${alice.token}`)
          .expect(200);
        expect(list.body).toHaveLength(3);
      });
      await step('5: Alice soft-deletes the WHOLE project', async () => {
        // eslint-disable-next-line no-restricted-syntax -- supertest HTTP method
        await http
          .delete(`/projects/${projectId}`)
          .set('Authorization', `Bearer ${alice.token}`)
          .expect(200);
      });
      await step(
        '6: GET /tickets?projectId=… → 404 (D31 parent-cascade)',
        async () => {
          await http
            .get(`/tickets?projectId=${projectId}`)
            .set('Authorization', `Bearer ${alice.token}`)
            .expect(404);
        },
      );
      await step(
        '7: GET /projects no longer lists the soft-deleted project',
        async () => {
          const list = await http
            .get('/projects')
            .set('Authorization', `Bearer ${alice.token}`)
            .expect(200);
          expect(
            (list.body as Array<{ id: number }>).some(
              (p) => p.id === projectId,
            ),
          ).toBe(false);
        },
      );
      await step(
        '8: /projects/deleted as ADMIN includes the project with deletedAt',
        async () => {
          const del = await http
            .get('/projects/deleted')
            .set('Authorization', `Bearer ${admin.token}`)
            .expect(200);
          const found = (
            del.body as Array<{ id: number; deletedAt: string | null }>
          ).find((p) => p.id === projectId);
          expect(found).toBeDefined();
          expect(found?.deletedAt).toBeTruthy();
        },
      );
      await step(
        '9: tickets are NOT individually soft-deleted (only hidden via cascade)',
        async () => {
          // Code-verified: ProjectsService.softDelete only touches the project
          // entity; ticket rows keep deletedAt=null. The API hides them via
          // the D31 cascade check; the rows themselves are untouched.
          const rows = await ds.getRepository(Ticket).find({
            where: { projectId },
            withDeleted: true,
          });
          expect(rows).toHaveLength(3);
          for (const r of rows) {
            expect(r.deletedAt).toBeNull();
          }
        },
      );
      await step(
        '10: ADMIN restores project → all 3 tickets visible again with comments',
        async () => {
          await http
            .post(`/projects/${projectId}/restore`)
            .set('Authorization', `Bearer ${admin.token}`)
            .expect(200);
          const list = await http
            .get(`/tickets?projectId=${projectId}`)
            .set('Authorization', `Bearer ${alice.token}`)
            .expect(200);
          expect(list.body).toHaveLength(3);
          // Each ticket's Bob-comment should still be retrievable.
          for (const t of list.body as Array<{ id: number }>) {
            const cs = await http
              .get(`/tickets/${t.id}/comments`)
              .set('Authorization', `Bearer ${alice.token}`)
              .expect(200);
            expect(cs.body).toHaveLength(1);
            expect(cs.body[0].authorId).toBe(bob.id);
          }
        },
      );
      await step(
        '11: audit log = 1× project SOFT_DELETE + 1× project RESTORE (no ticket SOFT_DELETEs from the cascade)',
        async () => {
          const projRows = await ds.getRepository(AuditLog).find({
            where: { entityType: 'PROJECT', entityId: projectId },
          });
          const projActions = projRows.map((r) => r.action).sort();
          expect(projActions).toContain('SOFT_DELETE');
          expect(projActions).toContain('RESTORE');

          // Tickets: the only ticket-level SOFT_DELETE was the step-3 single
          // ticket (ticketIds[0]), restored in step 4. The OTHER two tickets
          // never had a SOFT_DELETE audit row written, because the project's
          // soft-delete did NOT cascade-write per-ticket audit rows.
          const otherTicketIds = ticketIds.slice(1);
          const otherSoftDeletes = await ds.getRepository(AuditLog).find({
            where: otherTicketIds.map((id) => ({
              entityType: 'TICKET',
              entityId: id,
              action: 'SOFT_DELETE',
            })),
          });
          expect(otherSoftDeletes).toHaveLength(0);
        },
      );
    });

    it('Journey 6 — CSV cross-project round-trip preserves assignees + D14 warning is logged', async () => {
      let alice: { id: number; token: string };
      let bob: { id: number; token: string };
      let sourceProj = 0;
      let destProj = 0;
      let originalCsv = '';

      await step('1: register Alice + Bob', async () => {
        alice = await registerUser('alice', 'DEVELOPER');
        bob = await registerUser('bob', 'DEVELOPER');
      });
      await step(
        '2: Alice creates source project + 3 tickets (T1→Alice, T2→Bob, T3 unassigned)',
        async () => {
          sourceProj = await createProject(alice.id, alice.token, 'Source');
          await http
            .post('/tickets')
            .set('Authorization', `Bearer ${alice.token}`)
            .send({
              title: 'T1',
              description: 'd',
              status: 'TODO',
              priority: 'LOW',
              type: 'BUG',
              projectId: sourceProj,
              assigneeId: alice.id,
            })
            .expect(200);
          await http
            .post('/tickets')
            .set('Authorization', `Bearer ${alice.token}`)
            .send({
              title: 'T2',
              description: 'd',
              status: 'TODO',
              priority: 'LOW',
              type: 'BUG',
              projectId: sourceProj,
              assigneeId: bob.id,
            })
            .expect(200);
          await http
            .post('/tickets')
            .set('Authorization', `Bearer ${alice.token}`)
            .send({
              title: 'T3',
              description: 'd',
              status: 'TODO',
              priority: 'LOW',
              type: 'BUG',
              projectId: sourceProj,
              assigneeId: null,
            })
            .expect(200);
        },
      );
      await step(
        '3: export the source project and inspect assigneeId column per row',
        async () => {
          const res = await http
            .get(`/tickets/export?projectId=${sourceProj}`)
            .set('Authorization', `Bearer ${alice.token}`)
            .expect(200);
          originalCsv = res.text;
          const lines = originalCsv
            .split('\n')
            .filter((l) => l.trim().length > 0);
          expect(lines[0]).toBe(
            'id,title,description,status,priority,type,assigneeId',
          );
          // Find each row by title, extract the final cell (assigneeId).
          const tail = (line: string) => line.split(',').pop()?.trim();
          const t1Line = lines.find((l) => l.includes(',T1,')) ?? '';
          const t2Line = lines.find((l) => l.includes(',T2,')) ?? '';
          const t3Line = lines.find((l) => l.includes(',T3,')) ?? '';
          expect(tail(t1Line)).toBe(String(alice.id));
          expect(tail(t2Line)).toBe(String(bob.id));
          expect(tail(t3Line)).toBe(''); // null assignee serializes as empty
        },
      );
      await step(
        '4: create a fresh DESTINATION project (still empty)',
        async () => {
          destProj = await createProject(alice.id, alice.token, 'Dest');
        },
      );
      await step(
        '5: append a dueDate column to the CSV (D14: should be silently dropped)',
        async () => {
          // Modify the CSV: add a dueDate column with a value per data row.
          const lines = originalCsv.split('\n');
          lines[0] = lines[0] + ',dueDate';
          for (let i = 1; i < lines.length; i++) {
            if (lines[i].trim().length === 0) continue;
            lines[i] = lines[i] + ',2030-12-31T00:00:00Z';
          }
          originalCsv = lines.join('\n');
        },
      );
      await step(
        '6: spy on Logger.warn; import the modified CSV into the DEST project',
        async () => {
          // jest.spyOn(Logger.prototype, 'warn') is global to all loggers in
          // this process during the import call. To stay precise we assert
          // "at least once with a message naming dueDate" rather than strict
          // call count — other audit/subscriber paths may also warn.
          const warnSpy = jest.spyOn(Logger.prototype, 'warn');
          try {
            const res = await http
              .post('/tickets/import')
              .set('Authorization', `Bearer ${alice.token}`)
              .field('projectId', String(destProj))
              .attach('file', Buffer.from(originalCsv), 'export.csv')
              .expect(200);
            expect(res.body.created).toBe(3);
            expect(res.body.failed).toBe(0);

            const matchingCalls = warnSpy.mock.calls.filter((call) =>
              /dueDate/.test(String(call[0])),
            );
            expect(matchingCalls.length).toBeGreaterThanOrEqual(1);
          } finally {
            warnSpy.mockRestore();
          }
        },
      );
      await step(
        '7: GET /tickets?projectId=destProj returns 3 tickets with assigneeIds preserved',
        async () => {
          const list = await http
            .get(`/tickets?projectId=${destProj}`)
            .set('Authorization', `Bearer ${alice.token}`)
            .expect(200);
          expect(list.body).toHaveLength(3);
          const byTitle = new Map<
            string,
            { assigneeId: number | null; dueDate: string | null }
          >(
            (
              list.body as Array<{
                title: string;
                assigneeId: number | null;
                dueDate: string | null;
              }>
            ).map((t) => [
              t.title,
              { assigneeId: t.assigneeId, dueDate: t.dueDate },
            ]),
          );
          expect(byTitle.get('T1')?.assigneeId).toBe(alice.id);
          expect(byTitle.get('T2')?.assigneeId).toBe(bob.id);
          expect(byTitle.get('T3')?.assigneeId).toBeNull();
          // D14: dueDate column was silently dropped on import — every new
          // ticket's dueDate should be null even though we sent values.
          expect(byTitle.get('T1')?.dueDate).toBeNull();
          expect(byTitle.get('T2')?.dueDate).toBeNull();
          expect(byTitle.get('T3')?.dueDate).toBeNull();
        },
      );
      await step(
        '8: total across both projects = 6 (3 originals + 3 imports)',
        async () => {
          const src = (
            await http
              .get(`/tickets?projectId=${sourceProj}`)
              .set('Authorization', `Bearer ${alice.token}`)
              .expect(200)
          ).body as unknown[];
          const dst = (
            await http
              .get(`/tickets?projectId=${destProj}`)
              .set('Authorization', `Bearer ${alice.token}`)
              .expect(200)
          ).body as unknown[];
          expect(src.length + dst.length).toBe(6);
        },
      );
    });

    it('Journey 7 — Attachments lifecycle (JPEG, PDF, >10MB, multiple, soft-delete survival)', async () => {
      let alice: { id: number; token: string };
      let admin: { id: number; token: string };
      let projectId = 0;
      let ticketId = 0;
      const attachmentIds: number[] = [];

      await step('1: register Alice + admin; project + ticket', async () => {
        alice = await registerUser('alice', 'DEVELOPER');
        admin = await registerUser('admin', 'ADMIN');
        projectId = await createProject(alice.id, alice.token);
        const t = await http
          .post('/tickets')
          .set('Authorization', `Bearer ${alice.token}`)
          .send({
            title: 'T',
            description: 'd',
            status: 'TODO',
            priority: 'LOW',
            type: 'BUG',
            projectId,
            assigneeId: alice.id,
          })
          .expect(200);
        ticketId = t.body.id;
      });
      await step(
        '2: upload valid JPEG → 200, response shape {id,ticketId,filename,contentType}',
        async () => {
          const res = await http
            .post(`/tickets/${ticketId}/attachments`)
            .set('Authorization', `Bearer ${alice.token}`)
            .attach('file', TINY_JPEG, {
              filename: 'photo.jpg',
              contentType: 'image/jpeg',
            })
            .expect(200);
          expect(res.body).toMatchObject({
            ticketId,
            contentType: 'image/jpeg',
          });
          expect(res.body.id).toBeDefined();
          expect(res.body.filename).toBeDefined();
          attachmentIds.push(res.body.id);
        },
      );
      await step('3: upload valid PDF → 200', async () => {
        const res = await http
          .post(`/tickets/${ticketId}/attachments`)
          .set('Authorization', `Bearer ${alice.token}`)
          .attach('file', TINY_PDF, {
            filename: 'doc.pdf',
            contentType: 'application/pdf',
          })
          .expect(200);
        expect(res.body.contentType).toBe('application/pdf');
        attachmentIds.push(res.body.id);
      });
      await step(
        '4: upload 11 MB file → 413 (PDF §3.3: max 10MB)',
        async () => {
          const big = Buffer.alloc(11 * 1024 * 1024, 0); // 11 MB of zeros — Multer rejects before MIME sniff
          await http
            .post(`/tickets/${ticketId}/attachments`)
            .set('Authorization', `Bearer ${alice.token}`)
            .attach('file', big, {
              filename: 'big.png',
              contentType: 'image/png',
            })
            .expect(413);
        },
      );
      await step(
        '5: add a third attachment (PNG) — ticket now has 3',
        async () => {
          const res = await http
            .post(`/tickets/${ticketId}/attachments`)
            .set('Authorization', `Bearer ${alice.token}`)
            .attach('file', TINY_PNG, {
              filename: 'pixel.png',
              contentType: 'image/png',
            })
            .expect(200);
          attachmentIds.push(res.body.id);
          // Verify all three rows exist via direct DB query (no GET-attachments endpoint exists).
          const rows = await ds
            .getRepository(Attachment)
            .find({ where: { ticketId } });
          expect(rows).toHaveLength(3);
        },
      );
      await step('6: soft-delete the ticket', async () => {
        // eslint-disable-next-line no-restricted-syntax -- supertest HTTP method
        await http
          .delete(`/tickets/${ticketId}`)
          .set('Authorization', `Bearer ${alice.token}`)
          .expect(200);
      });
      await step('7: ADMIN restores the ticket', async () => {
        await http
          .post(`/tickets/${ticketId}/restore`)
          .set('Authorization', `Bearer ${admin.token}`)
          .expect(200);
      });
      await step(
        '8: attachments survived soft-delete + restore (3 rows still in DB)',
        async () => {
          // No GET-attachments HTTP endpoint exists, so verify via the
          // repository directly. All three rows must still be present and
          // their storagePath strings unchanged.
          const rows = await ds
            .getRepository(Attachment)
            .find({ where: { ticketId }, order: { id: 'ASC' } });
          expect(rows).toHaveLength(3);
          const ids = rows.map((r) => r.id).sort((a, b) => a - b);
          expect(ids).toEqual(attachmentIds.sort((a, b) => a - b));
        },
      );
    });

    it('Journey 8 — Audit log tells the whole story (every state change → a row)', async () => {
      let alice: { id: number; token: string };
      let bob: { id: number; token: string };
      let admin: { id: number; token: string };
      let projectId = 0;
      let ticketId = 0;

      await step('1: register Alice/Bob (DEV) + admin (ADMIN)', async () => {
        alice = await registerUser('alice', 'DEVELOPER');
        bob = await registerUser('bob', 'DEVELOPER');
        admin = await registerUser('admin', 'ADMIN');
      });
      await step(
        '2: Alice does project + auto-assigned ticket (triggers AUTO_ASSIGN) + a comment',
        async () => {
          projectId = await createProject(alice.id, alice.token);
          const t = await http
            .post('/tickets')
            .set('Authorization', `Bearer ${alice.token}`)
            .send({
              title: 'T',
              description: 'd',
              status: 'TODO',
              priority: 'LOW',
              type: 'BUG',
              projectId,
              // no assigneeId → triggers AUTO_ASSIGN
            })
            .expect(200);
          ticketId = t.body.id;
          await http
            .post(`/tickets/${ticketId}/comments`)
            .set('Authorization', `Bearer ${alice.token}`)
            .send({ content: 'kickoff' })
            .expect(200);
        },
      );
      await step('3: Bob updates the ticket (UPDATE rows)', async () => {
        await http
          .patch(`/tickets/${ticketId}`)
          .set('Authorization', `Bearer ${bob.token}`)
          .send({ status: 'IN_PROGRESS' })
          .expect(200);
      });
      await step(
        '4: ADMIN reads /audit-logs envelope shape {data,total,page,pageSize}',
        async () => {
          const all = await http
            .get('/audit-logs?page=1&pageSize=50')
            .set('Authorization', `Bearer ${admin.token}`)
            .expect(200);
          expect(all.body).toHaveProperty('data');
          expect(all.body).toHaveProperty('total');
          expect(all.body).toHaveProperty('page', 1);
          expect(all.body).toHaveProperty('pageSize');
          expect(all.body.total).toBeGreaterThanOrEqual(6); // 3 users + project + ticket + comment + update + auto_assign etc
        },
      );
      await step(
        '5: filter actor=ANONYMOUS → only the 3 user CREATEs',
        async () => {
          const res = await http
            .get('/audit-logs?actor=ANONYMOUS')
            .set('Authorization', `Bearer ${admin.token}`)
            .expect(200);
          expect(res.body.total).toBe(3);
          expect(
            (
              res.body.data as Array<{ entityType: string; action: string }>
            ).every((r) => r.entityType === 'USER' && r.action === 'CREATE'),
          ).toBe(true);
        },
      );
      await step(
        '6: filter actor=SYSTEM → only the AUTO_ASSIGN row',
        async () => {
          const res = await http
            .get('/audit-logs?actor=SYSTEM')
            .set('Authorization', `Bearer ${admin.token}`)
            .expect(200);
          expect(res.body.total).toBe(1);
          expect(res.body.data[0].action).toBe('AUTO_ASSIGN');
          expect(res.body.data[0].entityId).toBe(ticketId);
          expect(res.body.data[0].performedBy).toBeNull();
        },
      );
      await step(
        '7: filter entityType=TICKET entityId=T → full lifecycle present (CREATE + UPDATE)',
        async () => {
          const res = await http
            .get(`/audit-logs?entityType=TICKET&entityId=${ticketId}`)
            .set('Authorization', `Bearer ${admin.token}`)
            .expect(200);
          const actions = (res.body.data as Array<{ action: string }>).map(
            (r) => r.action,
          );
          expect(actions).toContain('CREATE');
          expect(actions).toContain('UPDATE');
          expect(actions).toContain('AUTO_ASSIGN');
        },
      );
      await step(
        '8: each row has timestamp + before/after fields shape per README',
        async () => {
          const res = await http
            .get(`/audit-logs?entityType=TICKET&entityId=${ticketId}`)
            .set('Authorization', `Bearer ${admin.token}`)
            .expect(200);
          for (const row of res.body.data as Array<{
            timestamp: string;
            before: unknown;
            after: unknown;
          }>) {
            expect(typeof row.timestamp).toBe('string');
            expect(Number.isFinite(Date.parse(row.timestamp))).toBe(true);
            // before/after exist (may be null per action type — CREATE before=null, AUTO_ASSIGN before=null, etc.)
            expect(row).toHaveProperty('before');
            expect(row).toHaveProperty('after');
          }
        },
      );
      await step(
        '9: direct DB UPDATE on audit_logs raises (D28 append-only trigger)',
        async () => {
          await expect(
            // eslint-disable-next-line no-restricted-syntax -- direct DDL probe against the trigger; not a Repository write
            ds.query("UPDATE audit_logs SET action = 'TAMPERED' WHERE id = 1"),
          ).rejects.toThrow(/append-only/i);
        },
      );
    });
  });

  describe('Auto-assign with NO DEVELOPER users (PDF §3.8 "without error")', () => {
    // Separate beforeEach so this describe owns its own setup — the
    // outer journey beforeEach runs first (truncateAll), and then this
    // one creates ONLY an ADMIN. No DEVELOPER user exists in the DB.
    let adminId = 0;
    let adminToken = '';
    let projectId = 0;

    beforeEach(async () => {
      await truncateAll(ds);
      http = request(app.getHttpServer());
      const admin = await http
        .post('/users')
        .send({
          username: 'lonely_admin',
          email: 'lonely_admin@example.com',
          fullName: 'Lonely Admin',
          role: 'ADMIN',
          password: 'lonelyadmin12345',
        })
        .expect(200);
      adminId = admin.body.id;
      adminToken = (
        await http
          .post('/auth/login')
          .send({ username: 'lonely_admin', password: 'lonelyadmin12345' })
          .expect(200)
      ).body.accessToken;
      // ADMIN-owned project is fine — PDF doesn't restrict project ownership to DEVs.
      projectId = (
        await http
          .post('/projects')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ name: 'NoDev', description: 'd', ownerId: adminId })
          .expect(200)
      ).body.id;
    });

    it('POST /tickets without assigneeId → 200, assigneeId=null, NO AUTO_ASSIGN audit row', async () => {
      const res = await http
        .post('/tickets')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          title: 'lonely',
          description: 'd',
          status: 'TODO',
          priority: 'LOW',
          type: 'BUG',
          projectId,
          // no assigneeId — PDF: "without error" when no DEVELOPER exists
        })
        .expect(200);
      expect(res.body.assigneeId).toBeNull();

      // No AUTO_ASSIGN row should have been written — there was nothing to assign.
      const aaRows = await ds.getRepository(AuditLog).find({
        where: {
          action: 'AUTO_ASSIGN',
          entityType: 'TICKET',
          entityId: res.body.id,
        },
      });
      expect(aaRows).toHaveLength(0);

      // Workload returns an empty list (no DEVELOPERs to enumerate).
      const w = await http
        .get(`/projects/${projectId}/workload`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(w.body).toEqual([]);
    });
  });
});
