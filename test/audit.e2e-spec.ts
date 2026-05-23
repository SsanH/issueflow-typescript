import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { truncateAll } from './db-helpers';

jest.retryTimes(2);

describe('Audit log (Phase 5) e2e', () => {
  let app: INestApplication;
  let ds: DataSource;
  let http: ReturnType<typeof request>;

  let adminToken: string;
  let devToken: string;
  let devId: number;

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
        email: 'dev1@example.com',
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
  });

  it('DEVELOPER → 403 (D13)', async () => {
    await http
      .get('/audit-logs')
      .set('Authorization', `Bearer ${devToken}`)
      .expect(403);
  });

  it('ADMIN → 200, lists rows newest-first, paginated envelope', async () => {
    // Create some audited activity.
    await http
      .post('/projects')
      .set('Authorization', `Bearer ${devToken}`)
      .send({ name: 'P', description: 'p', ownerId: devId })
      .expect(200);

    const res = await http
      .get('/audit-logs')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('total');
    expect(res.body).toHaveProperty('page', 1);
    expect(res.body).toHaveProperty('pageSize');
    // At least: 2 USER CREATE rows (admin + dev), 1 PROJECT CREATE row.
    expect(res.body.total).toBeGreaterThanOrEqual(3);
    // Newest first: timestamps non-increasing.
    for (let i = 1; i < res.body.data.length; i++) {
      expect(
        new Date(res.body.data[i - 1].timestamp).getTime(),
      ).toBeGreaterThanOrEqual(new Date(res.body.data[i].timestamp).getTime());
    }
  });

  it('filter by entityType uppercase matches what the subscriber wrote', async () => {
    await http
      .post('/projects')
      .set('Authorization', `Bearer ${devToken}`)
      .send({ name: 'P', description: 'p', ownerId: devId })
      .expect(200);

    const res = await http
      .get('/audit-logs?entityType=PROJECT')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    expect(
      res.body.data.every(
        (r: { entityType: string }) => r.entityType === 'PROJECT',
      ),
    ).toBe(true);
  });

  it('filter by entityId narrows to a single resource', async () => {
    const p = await http
      .post('/projects')
      .set('Authorization', `Bearer ${devToken}`)
      .send({ name: 'P', description: 'p', ownerId: devId })
      .expect(200);

    const res = await http
      .get(`/audit-logs?entityType=PROJECT&entityId=${p.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(
      res.body.data.every(
        (r: { entityType: string; entityId: number }) =>
          r.entityType === 'PROJECT' && r.entityId === p.body.id,
      ),
    ).toBe(true);
  });

  it('filter by action CREATE returns only CREATE rows', async () => {
    await http
      .post('/projects')
      .set('Authorization', `Bearer ${devToken}`)
      .send({ name: 'P', description: 'p', ownerId: devId })
      .expect(200);
    const res = await http
      .get('/audit-logs?action=CREATE')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(
      res.body.data.every((r: { action: string }) => r.action === 'CREATE'),
    ).toBe(true);
  });

  it('filter by actor=USER excludes SYSTEM and ANONYMOUS rows', async () => {
    const res = await http
      .get('/audit-logs?actor=USER')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(
      res.body.data.every((r: { actor: string }) => r.actor === 'USER'),
    ).toBe(true);
  });

  // --- D28 hardening ---

  it('D28: user-CREATE audit row does NOT include passwordHash in after', async () => {
    // The admin and dev users registered in beforeEach already produced
    // two USER CREATE rows. Inspect them.
    const res = await http
      .get('/audit-logs?entityType=USER&action=CREATE')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body.total).toBeGreaterThanOrEqual(2);
    for (const row of res.body.data as Array<{
      after: Record<string, unknown> | null;
    }>) {
      expect(row.after).not.toBeNull();
      expect(row.after).not.toHaveProperty('passwordHash');
      expect(row.after).not.toHaveProperty('password');
    }
  });

  it('D28: public-route registration writes actor=ANONYMOUS, not SYSTEM', async () => {
    // Fresh user — produced in this very request via a public POST /users.
    await http
      .post('/users')
      .send({
        username: 'newbie',
        email: 'newbie@example.com',
        fullName: 'Newbie',
        role: 'DEVELOPER',
        password: 'newbiepass123',
      })
      .expect(200);

    const res = await http
      .get('/audit-logs?entityType=USER&action=CREATE')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    // The 'newbie' row should be present with ANONYMOUS actor.
    const newbieRow = (
      res.body.data as Array<{
        after: { username?: string } | null;
        actor: string;
      }>
    ).find((r) => r.after?.username === 'newbie');
    expect(newbieRow).toBeDefined();
    expect(newbieRow?.actor).toBe('ANONYMOUS');
  });

  it('D28: hard-deleting a comment writes action=DELETE (not SOFT_DELETE)', async () => {
    // Set up a project + ticket + comment, then hard-delete the comment.
    const project = (
      await http
        .post('/projects')
        .set('Authorization', `Bearer ${devToken}`)
        .send({ name: 'P', description: 'p', ownerId: devId })
        .expect(200)
    ).body;
    const ticket = (
      await http
        .post('/tickets')
        .set('Authorization', `Bearer ${devToken}`)
        .send({
          title: 'T',
          description: 'd',
          status: 'TODO',
          priority: 'LOW',
          type: 'BUG',
          projectId: project.id,
          assigneeId: devId,
        })
        .expect(200)
    ).body;
    const comment = (
      await http
        .post(`/tickets/${ticket.id}/comments`)
        .set('Authorization', `Bearer ${devToken}`)
        .send({ content: 'doomed' })
        .expect(200)
    ).body;
    // eslint-disable-next-line no-restricted-syntax -- supertest HTTP method
    await http
      .delete(`/tickets/${ticket.id}/comments/${comment.id}`)
      .set('Authorization', `Bearer ${devToken}`)
      .expect(200);

    // D28: also verifies entityId is captured for DELETE rows (TypeORM
    // clears entity.id after repo.remove; the subscriber uses event.entityId
    // as a fallback so the DELETE row stays queryable by entity id).
    const res = await http
      .get(`/audit-logs?entityType=COMMENT&entityId=${comment.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const actions = (
      res.body.data as Array<{ action: string; entityId: number | null }>
    ).map((r) => r.action);
    expect(actions).toContain('DELETE');
    expect(actions).not.toContain('SOFT_DELETE');
  });

  it('D28: ?entityId=abc returns 400 (NaN-safe)', async () => {
    await http
      .get('/audit-logs?entityId=abc')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });

  it('D28: ?page=xyz returns 400', async () => {
    await http
      .get('/audit-logs?page=xyz')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400);
  });

  it('D28: audit_logs is append-only at the DB layer (UPDATE raises)', async () => {
    // Provoke an audit row to exist.
    await http
      .post('/projects')
      .set('Authorization', `Bearer ${devToken}`)
      .send({ name: 'P', description: 'p', ownerId: devId })
      .expect(200);

    await expect(
      // eslint-disable-next-line no-restricted-syntax -- direct DDL test against the trigger; not a Repository write
      ds.query(`UPDATE audit_logs SET action = 'TAMPERED' WHERE id = 1`),
    ).rejects.toThrow(/append-only/i);
  });

  it('D32: CommentMention writes do NOT produce audit rows (parent Comment audit carries the diff)', async () => {
    // Set up a project + ticket + a comment with @-mentions of dev1.
    const project = (
      await http
        .post('/projects')
        .set('Authorization', `Bearer ${devToken}`)
        .send({ name: 'P', description: 'p', ownerId: devId })
        .expect(200)
    ).body;
    const ticket = (
      await http
        .post('/tickets')
        .set('Authorization', `Bearer ${devToken}`)
        .send({
          title: 'T',
          description: 'd',
          status: 'TODO',
          priority: 'LOW',
          type: 'BUG',
          projectId: project.id,
          assigneeId: devId,
        })
        .expect(200)
    ).body;
    // Mention dev1 (a real user) so a CommentMention row gets written.
    await http
      .post(`/tickets/${ticket.id}/comments`)
      .set('Authorization', `Bearer ${devToken}`)
      .send({ content: 'hey @dev1 look at this' })
      .expect(200);

    const res = await http
      .get('/audit-logs?entityType=COMMENTMENTION')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(res.body.total).toBe(0);
    expect(res.body.data).toEqual([]);

    // Sanity: the parent COMMENT row IS audited.
    const commentAudit = await http
      .get('/audit-logs?entityType=COMMENT&action=CREATE')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(commentAudit.body.total).toBeGreaterThanOrEqual(1);
  });

  it('D28: audit_logs is append-only at the DB layer (DELETE raises)', async () => {
    await http
      .post('/projects')
      .set('Authorization', `Bearer ${devToken}`)
      .send({ name: 'P', description: 'p', ownerId: devId })
      .expect(200);

    await expect(
      // eslint-disable-next-line no-restricted-syntax -- direct DDL test against the trigger; not a Repository write
      ds.query(`DELETE FROM audit_logs WHERE id = 1`),
    ).rejects.toThrow(/append-only/i);
  });
});
