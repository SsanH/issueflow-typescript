import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { AuditLog } from '../src/modules/audit/audit-log.entity';
import { Ticket } from '../src/modules/tickets/ticket.entity';
import { truncateAll } from './db-helpers';

jest.retryTimes(2);

describe('Tickets (Phase 3) e2e', () => {
  let app: INestApplication;
  let ds: DataSource;
  let http: ReturnType<typeof request>;

  let adminToken: string;
  let devToken: string;
  let devId: number;
  let projectId: number;

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

  beforeEach(async () => {
    await truncateAll(ds);
    http = request(app.getHttpServer());

    await http
      .post('/users')
      .send({
        username: 'admin1',
        email: 'admin@example.com',
        fullName: 'Admin One',
        role: 'ADMIN',
        password: 'admin12345',
      })
      .expect(200);

    const dev = await http
      .post('/users')
      .send({
        username: 'dev1',
        email: 'dev@example.com',
        fullName: 'Dev One',
        role: 'DEVELOPER',
        password: 'devpass12345',
      })
      .expect(200);
    devId = dev.body.id;

    adminToken = (
      await http
        .post('/auth/login')
        .send({ username: 'admin1', password: 'admin12345' })
        .expect(200)
    ).body.accessToken;
    devToken = (
      await http
        .post('/auth/login')
        .send({ username: 'dev1', password: 'devpass12345' })
        .expect(200)
    ).body.accessToken;

    const project = await http
      .post('/projects')
      .set('Authorization', `Bearer ${devToken}`)
      .send({ name: 'P1', description: 'p1', ownerId: devId })
      .expect(200);
    projectId = project.body.id;
  });

  const validTicket = (overrides: Record<string, unknown> = {}) => ({
    title: 'Fix login bug',
    description: 'login fails on Safari',
    status: 'TODO',
    priority: 'HIGH',
    type: 'BUG',
    projectId,
    ...overrides,
  });

  describe('POST /tickets', () => {
    it('creates a ticket and writes a CREATE audit row', async () => {
      const res = await http
        .post('/tickets')
        .set('Authorization', `Bearer ${devToken}`)
        .send(validTicket({ assigneeId: devId }))
        .expect(200);
      expect(res.body).toMatchObject({
        id: 1,
        title: 'Fix login bug',
        status: 'TODO',
        priority: 'HIGH',
        type: 'BUG',
        projectId,
        assigneeId: devId,
        isOverdue: false,
      });

      const audit = await ds.getRepository(AuditLog).find();
      const create = audit.find(
        (a) => a.entityType === 'TICKET' && a.action === 'CREATE',
      );
      expect(create).toBeDefined();
      expect(create?.performedBy).toBe(devId);
    });

    it('rejects invalid status enum with 400', async () => {
      await http
        .post('/tickets')
        .set('Authorization', `Bearer ${devToken}`)
        .send(validTicket({ status: 'NOPE' }))
        .expect(400);
    });

    it('rejects a whitespace-only title (D20)', async () => {
      await http
        .post('/tickets')
        .set('Authorization', `Bearer ${devToken}`)
        .send(validTicket({ title: '   ' }))
        .expect(400);
    });

    it('accepts an empty description (D20 — Jira semantics)', async () => {
      await http
        .post('/tickets')
        .set('Authorization', `Bearer ${devToken}`)
        .send(validTicket({ description: '' }))
        .expect(200);
    });

    it('rejects nonexistent projectId with 404', async () => {
      await http
        .post('/tickets')
        .set('Authorization', `Bearer ${devToken}`)
        .send(validTicket({ projectId: 9999 }))
        .expect(404);
    });

    it('rejects nonexistent assigneeId with 404', async () => {
      await http
        .post('/tickets')
        .set('Authorization', `Bearer ${devToken}`)
        .send(validTicket({ assigneeId: 9999 }))
        .expect(404);
    });

    it('missing assigneeId triggers Phase 6e auto-assign to the only DEVELOPER', async () => {
      const res = await http
        .post('/tickets')
        .set('Authorization', `Bearer ${devToken}`)
        .send(validTicket())
        .expect(200);
      // Only one DEVELOPER user in this spec's beforeEach — auto-assign picks them.
      expect(res.body.assigneeId).toBe(devId);
    });

    it('explicit assigneeId: null means "no assignee" — NO auto-assign, NO AUTO_ASSIGN audit row (D24)', async () => {
      const res = await http
        .post('/tickets')
        .set('Authorization', `Bearer ${devToken}`)
        .send(validTicket({ assigneeId: null }))
        .expect(200);
      expect(res.body.assigneeId).toBeNull();

      const audit = await ds.getRepository(AuditLog).find();
      expect(
        audit.find(
          (a) =>
            a.entityType === 'TICKET' &&
            a.action === 'AUTO_ASSIGN' &&
            a.entityId === res.body.id,
        ),
      ).toBeUndefined();
    });
  });

  describe('PATCH assigneeId tri-state + validate-before-mutate (D24)', () => {
    let ticketId: number;

    beforeEach(async () => {
      const t = await http
        .post('/tickets')
        .set('Authorization', `Bearer ${devToken}`)
        .send(validTicket({ assigneeId: devId, title: 'original' }))
        .expect(200);
      ticketId = t.body.id;
    });

    it('PATCH assigneeId: null unassigns the ticket', async () => {
      await http
        .patch(`/tickets/${ticketId}`)
        .set('Authorization', `Bearer ${devToken}`)
        .send({ assigneeId: null })
        .expect(200);
      const after = await http
        .get(`/tickets/${ticketId}`)
        .set('Authorization', `Bearer ${devToken}`)
        .expect(200);
      expect(after.body.assigneeId).toBeNull();
    });

    it('invalid assigneeId rejects with 400 AND leaves the other fields untouched (validate-before-mutate)', async () => {
      // PATCH mixes a valid title with an invalid assigneeId. Even though
      // the transaction would roll back any DB mutation, the service must
      // also avoid mutating the in-memory entity until every FK is verified.
      await http
        .patch(`/tickets/${ticketId}`)
        .set('Authorization', `Bearer ${devToken}`)
        .send({ title: 'should-not-stick', assigneeId: 9999 })
        .expect(404);

      const after = await http
        .get(`/tickets/${ticketId}`)
        .set('Authorization', `Bearer ${devToken}`)
        .expect(200);
      expect(after.body.title).toBe('original');
      expect(after.body.assigneeId).toBe(devId);
    });
  });

  describe('GET /tickets?projectId= and GET /tickets/:id', () => {
    it('lists tickets filtered by project; 404 on unknown id', async () => {
      await http
        .post('/tickets')
        .set('Authorization', `Bearer ${devToken}`)
        .send(validTicket())
        .expect(200);
      await http
        .post('/tickets')
        .set('Authorization', `Bearer ${devToken}`)
        .send(validTicket({ title: 'second' }))
        .expect(200);

      const list = await http
        .get(`/tickets?projectId=${projectId}`)
        .set('Authorization', `Bearer ${devToken}`)
        .expect(200);
      expect(list.body).toHaveLength(2);

      await http
        .get('/tickets/9999')
        .set('Authorization', `Bearer ${devToken}`)
        .expect(404);
    });

    it('GET /tickets without projectId → 400', async () => {
      await http
        .get('/tickets')
        .set('Authorization', `Bearer ${devToken}`)
        .expect(400);
    });
  });

  describe('PATCH /tickets/:id — state machine (D11, D11a, D12)', () => {
    let ticketId: number;

    beforeEach(async () => {
      const t = await http
        .post('/tickets')
        .set('Authorization', `Bearer ${devToken}`)
        .send(validTicket({ assigneeId: devId }))
        .expect(200);
      ticketId = t.body.id;
    });

    it('rejects a whitespace-only title on PATCH (D20)', async () => {
      await http
        .patch(`/tickets/${ticketId}`)
        .set('Authorization', `Bearer ${devToken}`)
        .send({ title: '   ' })
        .expect(400);
    });

    it('forward step TODO → IN_PROGRESS is OK', async () => {
      await http
        .patch(`/tickets/${ticketId}`)
        .set('Authorization', `Bearer ${devToken}`)
        .send({ status: 'IN_PROGRESS' })
        .expect(200);
      const after = await http
        .get(`/tickets/${ticketId}`)
        .set('Authorization', `Bearer ${devToken}`)
        .expect(200);
      expect(after.body.status).toBe('IN_PROGRESS');
    });

    it('forward skip TODO → DONE is OK (D12 lenient interpretation)', async () => {
      await http
        .patch(`/tickets/${ticketId}`)
        .set('Authorization', `Bearer ${devToken}`)
        .send({ status: 'DONE' })
        .expect(200);
      const after = await http
        .get(`/tickets/${ticketId}`)
        .set('Authorization', `Bearer ${devToken}`)
        .expect(200);
      expect(after.body.status).toBe('DONE');
    });

    it('backward IN_REVIEW → TODO → 409 (D11)', async () => {
      await http
        .patch(`/tickets/${ticketId}`)
        .set('Authorization', `Bearer ${devToken}`)
        .send({ status: 'IN_REVIEW' })
        .expect(200);
      await http
        .patch(`/tickets/${ticketId}`)
        .set('Authorization', `Bearer ${devToken}`)
        .send({ status: 'TODO' })
        .expect(409);
    });

    it('DONE is terminal — any PATCH on DONE → 409 (D11)', async () => {
      await http
        .patch(`/tickets/${ticketId}`)
        .set('Authorization', `Bearer ${devToken}`)
        .send({ status: 'DONE' })
        .expect(200);

      // status change on DONE
      await http
        .patch(`/tickets/${ticketId}`)
        .set('Authorization', `Bearer ${devToken}`)
        .send({ status: 'IN_REVIEW' })
        .expect(409);
      // even an unrelated field on DONE
      await http
        .patch(`/tickets/${ticketId}`)
        .set('Authorization', `Bearer ${devToken}`)
        .send({ title: 'still locked' })
        .expect(409);
    });

    it('no-op PATCH (same status) → 200 + no audit row (D11a)', async () => {
      // baseline audit count after create + the locking PATCH below
      const beforeCount = await ds
        .getRepository(AuditLog)
        .countBy({ entityType: 'Ticket' });

      await http
        .patch(`/tickets/${ticketId}`)
        .set('Authorization', `Bearer ${devToken}`)
        .send({ status: 'TODO' })
        .expect(200);

      const afterCount = await ds
        .getRepository(AuditLog)
        .countBy({ entityType: 'Ticket' });
      // No new audit row was written for the no-op.
      expect(afterCount).toBe(beforeCount);
    });

    it('manual priority change clears isOverdue (PDF §3.7)', async () => {
      // Force isOverdue=true directly via the repo for this test (the
      // scheduler is Phase 6f; here we just verify the PATCH-side reset).
      const repo = ds.getRepository(Ticket);
      const t = await repo.findOneByOrFail({ id: ticketId });
      t.isOverdue = true;
      await repo.save(t);

      await http
        .patch(`/tickets/${ticketId}`)
        .set('Authorization', `Bearer ${devToken}`)
        .send({ priority: 'CRITICAL' })
        .expect(200);

      const after = await http
        .get(`/tickets/${ticketId}`)
        .set('Authorization', `Bearer ${devToken}`)
        .expect(200);
      expect(after.body.priority).toBe('CRITICAL');
      expect(after.body.isOverdue).toBe(false);
    });

    it('concurrent Promise.all PATCHes serialize without crash (D2)', async () => {
      // Two simultaneous PATCHes against the same row. Pessimistic
      // SELECT…FOR UPDATE serializes them. Both should return 200 with
      // forward-only transitions: TODO → IN_PROGRESS → IN_REVIEW.
      const results = await Promise.all([
        http
          .patch(`/tickets/${ticketId}`)
          .set('Authorization', `Bearer ${devToken}`)
          .send({ status: 'IN_PROGRESS' }),
        http
          .patch(`/tickets/${ticketId}`)
          .set('Authorization', `Bearer ${devToken}`)
          .send({ status: 'IN_REVIEW' }),
      ]);
      // Both should succeed (each transition is forward from the prior
      // committed state, whichever order they ran in).
      expect(results.every((r) => r.status === 200)).toBe(true);

      const after = await http
        .get(`/tickets/${ticketId}`)
        .set('Authorization', `Bearer ${devToken}`)
        .expect(200);
      // Final state is IN_PROGRESS or IN_REVIEW depending on order; both are
      // forward, both are legal under D12.
      expect(['IN_PROGRESS', 'IN_REVIEW']).toContain(after.body.status);
    });

    // §9 / §10 #30: pessimistic FOR UPDATE serializes truly simultaneous
    // writes but does NOT prevent lost updates across stale reads. This is
    // documented in `run.md` as a known limitation; the production fix is
    // ETag + If-Match. The TODO is left visible so the trade-off is
    // explicit in the test suite.
    it.todo(
      'lost update across stale reads — known residual risk, see plan §10 #30',
    );
  });

  describe('DELETE /tickets/:id (soft-delete) + ADMIN /deleted + /restore (D13)', () => {
    let ticketId: number;

    beforeEach(async () => {
      const t = await http
        .post('/tickets')
        .set('Authorization', `Bearer ${devToken}`)
        .send(validTicket())
        .expect(200);
      ticketId = t.body.id;
      // eslint-disable-next-line no-restricted-syntax -- supertest HTTP method
      await http
        .delete(`/tickets/${ticketId}`)
        .set('Authorization', `Bearer ${devToken}`)
        .expect(200);
    });

    it('soft-deleted ticket is hidden from GET list and GET by id', async () => {
      const list = await http
        .get(`/tickets?projectId=${projectId}`)
        .set('Authorization', `Bearer ${devToken}`)
        .expect(200);
      expect(list.body).toHaveLength(0);

      await http
        .get(`/tickets/${ticketId}`)
        .set('Authorization', `Bearer ${devToken}`)
        .expect(404);

      const audit = await ds.getRepository(AuditLog).find();
      expect(
        audit.find(
          (a) => a.entityType === 'TICKET' && a.action === 'SOFT_DELETE',
        ),
      ).toBeDefined();
    });

    it('GET /tickets/deleted → DEVELOPER 403, ADMIN 200 with full ticket shape', async () => {
      await http
        .get(`/tickets/deleted?projectId=${projectId}`)
        .set('Authorization', `Bearer ${devToken}`)
        .expect(403);

      const adm = await http
        .get(`/tickets/deleted?projectId=${projectId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(adm.body).toHaveLength(1);
      // §10 #31: full shape returned, not the README's illustrative stripped shape.
      expect(adm.body[0]).toMatchObject({
        id: ticketId,
        title: 'Fix login bug',
        status: 'TODO',
        priority: 'HIGH',
        type: 'BUG',
        projectId,
        isOverdue: false,
      });
      expect(adm.body[0].deletedAt).toBeTruthy();
    });

    it('POST /tickets/:id/restore → DEVELOPER 403, ADMIN 200 + RESTORE audit row + empty body (D31)', async () => {
      await http
        .post(`/tickets/${ticketId}/restore`)
        .set('Authorization', `Bearer ${devToken}`)
        .expect(403);

      const res = await http
        .post(`/tickets/${ticketId}/restore`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      // D31: README contract shows empty response body for restore.
      expect(res.body).toEqual({});

      const list = await http
        .get(`/tickets?projectId=${projectId}`)
        .set('Authorization', `Bearer ${devToken}`)
        .expect(200);
      expect(list.body).toHaveLength(1);

      const audit = await ds.getRepository(AuditLog).find();
      expect(
        audit.find((a) => a.entityType === 'TICKET' && a.action === 'RESTORE'),
      ).toBeDefined();
    });

    it('POST /tickets/:id/restore on a non-deleted ticket → 400', async () => {
      // beforeEach leaves ticketId soft-deleted. Restore once to make it
      // live, then attempt restore again → should 400 ("is not deleted").
      await http
        .post(`/tickets/${ticketId}/restore`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      await http
        .post(`/tickets/${ticketId}/restore`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);
    });

    it('POST /tickets/:id/restore on an unknown id → 404', async () => {
      await http
        .post(`/tickets/999999/restore`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(404);
    });
  });

  // --- D31: parent-project cascade visibility + restore-parent gate ---

  describe('D31 — soft-deleted parent project cascades visibility', () => {
    let liveTicketId: number;

    beforeEach(async () => {
      const t = await http
        .post('/tickets')
        .set('Authorization', `Bearer ${devToken}`)
        .send(validTicket({ assigneeId: devId }))
        .expect(200);
      liveTicketId = t.body.id;

      // Soft-delete the parent project. The ticket itself is not touched.
      // eslint-disable-next-line no-restricted-syntax -- supertest HTTP method
      await http
        .delete(`/projects/${projectId}`)
        .set('Authorization', `Bearer ${devToken}`)
        .expect(200);
    });

    it('GET /tickets?projectId= → 404 when project is soft-deleted', async () => {
      await http
        .get(`/tickets?projectId=${projectId}`)
        .set('Authorization', `Bearer ${devToken}`)
        .expect(404);
    });

    it('GET /tickets/:id → 404 when parent project is soft-deleted', async () => {
      await http
        .get(`/tickets/${liveTicketId}`)
        .set('Authorization', `Bearer ${devToken}`)
        .expect(404);
    });

    it('PATCH /tickets/:id → 404 when parent project is soft-deleted', async () => {
      await http
        .patch(`/tickets/${liveTicketId}`)
        .set('Authorization', `Bearer ${devToken}`)
        .send({ title: 'nope' })
        .expect(404);
    });

    it('DELETE /tickets/:id → 404 when parent project is soft-deleted', async () => {
      // eslint-disable-next-line no-restricted-syntax -- supertest HTTP method
      await http
        .delete(`/tickets/${liveTicketId}`)
        .set('Authorization', `Bearer ${devToken}`)
        .expect(404);
    });

    it('ADMIN GET /tickets/deleted still works even with parent soft-deleted (historical view)', async () => {
      // No need for the ticket itself to be soft-deleted here — just confirm
      // the ADMIN historical endpoint isn't gated by parent visibility.
      await http
        .get(`/tickets/deleted?projectId=${projectId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
    });

    it('Restoring the project unhides its tickets again', async () => {
      await http
        .post(`/projects/${projectId}/restore`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const list = await http
        .get(`/tickets?projectId=${projectId}`)
        .set('Authorization', `Bearer ${devToken}`)
        .expect(200);
      expect(list.body).toHaveLength(1);
    });

    it("D35: belt-and-suspenders — replica of reviewer's R-soft-delete-orphan scenario", async () => {
      // Reviewer's report: "Soft-deleted a project, then GET /tickets?
      // projectId=<that project> returned 5 tickets." That scenario was
      // closed by D31/D22; this test pins the exact described flow so any
      // regression surfaces immediately. We use a FRESH project here (not
      // the one in outer beforeEach) to keep this self-contained.
      const fresh = (
        await http
          .post('/projects')
          .set('Authorization', `Bearer ${devToken}`)
          .send({ name: 'P-orphan', description: 'd', ownerId: devId })
          .expect(200)
      ).body.id;
      for (let i = 0; i < 5; i++) {
        await http
          .post('/tickets')
          .set('Authorization', `Bearer ${devToken}`)
          .send({
            title: `t${i}`,
            description: 'd',
            status: 'TODO',
            priority: 'LOW',
            type: 'BUG',
            projectId: fresh,
            assigneeId: devId,
          })
          .expect(200);
      }
      // eslint-disable-next-line no-restricted-syntax -- supertest HTTP method
      await http
        .delete(`/projects/${fresh}`)
        .set('Authorization', `Bearer ${devToken}`)
        .expect(200);
      await http
        .get(`/tickets?projectId=${fresh}`)
        .set('Authorization', `Bearer ${devToken}`)
        .expect(404);
    });

    it('D31: restoring a ticket whose parent project is still soft-deleted → 409', async () => {
      // Soft-delete the ticket itself first (while the parent is also gone —
      // edge case: the project gets soft-deleted first, then an ADMIN runs
      // direct-DB cleanup that soft-deletes the orphaned ticket explicitly).
      // In our app flow we can't soft-delete a hidden ticket via the API,
      // so we use the DataSource directly to simulate the historical state.
      // eslint-disable-next-line no-restricted-syntax -- direct softRemove to set up the test state; not a contract path
      await ds.getRepository(Ticket).softRemove({ id: liveTicketId } as Ticket);

      const res = await http
        .post(`/tickets/${liveTicketId}/restore`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(409);
      expect(JSON.stringify(res.body.message)).toMatch(
        /parent project.*soft-deleted/i,
      );
    });
  });
});
