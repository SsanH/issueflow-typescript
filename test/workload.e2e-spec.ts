import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { AuditLog } from '../src/modules/audit/audit-log.entity';
import { truncateAll } from './db-helpers';

jest.retryTimes(2);

describe('Workload + Auto-Assign (Phase 6e) e2e', () => {
  let app: INestApplication;
  let ds: DataSource;
  let http: ReturnType<typeof request>;

  let adminId: number;
  let dev1Id: number;
  let dev2Id: number;
  let token: string;
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

    adminId = (
      await http
        .post('/users')
        .send({
          username: 'admin1',
          email: 'admin@example.com',
          fullName: 'Admin',
          role: 'ADMIN',
          password: 'admin12345',
        })
        .expect(200)
    ).body.id;
    dev1Id = (
      await http
        .post('/users')
        .send({
          username: 'dev1',
          email: 'dev1@example.com',
          fullName: 'Dev One',
          role: 'DEVELOPER',
          password: 'devpass12345',
        })
        .expect(200)
    ).body.id;
    dev2Id = (
      await http
        .post('/users')
        .send({
          username: 'dev2',
          email: 'dev2@example.com',
          fullName: 'Dev Two',
          role: 'DEVELOPER',
          password: 'devpass67890',
        })
        .expect(200)
    ).body.id;

    token = (
      await http
        .post('/auth/login')
        .send({ username: 'dev1', password: 'devpass12345' })
        .expect(200)
    ).body.accessToken;

    projectId = (
      await http
        .post('/projects')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'P', description: 'p', ownerId: dev1Id })
        .expect(200)
    ).body.id;
  });

  const newTicket = (overrides: Record<string, unknown> = {}) => ({
    title: 'T',
    description: 'd',
    status: 'TODO',
    priority: 'LOW',
    type: 'BUG',
    projectId,
    ...overrides,
  });

  it('GET /projects/:id/workload lists DEVELOPER users only with zero counts initially (D13, D17)', async () => {
    const res = await http
      .get(`/projects/${projectId}/workload`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body).toHaveLength(2); // dev1, dev2 only — admin excluded
    expect(
      res.body.map((r: { username: string }) => r.username).sort(),
    ).toEqual(['dev1', 'dev2']);
    expect(
      res.body.every(
        (r: { openTicketCount: number }) => r.openTicketCount === 0,
      ),
    ).toBe(true);
    expect(res.body).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ username: 'admin1' })]),
    );
    // Sanity: admin user is not in the list.
    expect(
      res.body.find((r: { userId: number }) => r.userId === adminId),
    ).toBeUndefined();
  });

  it('counts are per-project, not global (G1)', async () => {
    // Assign 2 open tickets to dev1 in THIS project.
    await http
      .post('/tickets')
      .set('Authorization', `Bearer ${token}`)
      .send(newTicket({ assigneeId: dev1Id }))
      .expect(200);
    await http
      .post('/tickets')
      .set('Authorization', `Bearer ${token}`)
      .send(newTicket({ assigneeId: dev1Id }))
      .expect(200);

    // Create a second project + assign dev1 a ticket there — must not bleed.
    const otherProject = (
      await http
        .post('/projects')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Q', description: 'q', ownerId: dev1Id })
        .expect(200)
    ).body.id;
    await http
      .post('/tickets')
      .set('Authorization', `Bearer ${token}`)
      .send(newTicket({ projectId: otherProject, assigneeId: dev1Id }))
      .expect(200);

    const res = await http
      .get(`/projects/${projectId}/workload`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(
      res.body.find((r: { username: string }) => r.username === 'dev1')
        .openTicketCount,
    ).toBe(2);
    expect(
      res.body.find((r: { username: string }) => r.username === 'dev2')
        .openTicketCount,
    ).toBe(0);
  });

  it('DONE tickets do NOT count toward openTicketCount', async () => {
    const t = await http
      .post('/tickets')
      .set('Authorization', `Bearer ${token}`)
      .send(newTicket({ assigneeId: dev1Id }))
      .expect(200);
    await http
      .patch(`/tickets/${t.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'DONE' })
      .expect(200);

    const res = await http
      .get(`/projects/${projectId}/workload`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(
      res.body.find((r: { username: string }) => r.username === 'dev1')
        .openTicketCount,
    ).toBe(0);
  });

  it('auto-assigns to least-loaded DEVELOPER when assigneeId omitted (D15) + writes AUTO_ASSIGN audit row', async () => {
    // Pre-load: dev1 has 1 open ticket; dev2 has 0. Auto-assign should pick dev2.
    await http
      .post('/tickets')
      .set('Authorization', `Bearer ${token}`)
      .send(newTicket({ assigneeId: dev1Id }))
      .expect(200);

    const t = await http
      .post('/tickets')
      .set('Authorization', `Bearer ${token}`)
      .send(newTicket())
      .expect(200);
    expect(t.body.assigneeId).toBe(dev2Id);

    const audit = await ds.getRepository(AuditLog).find();
    expect(
      audit.find(
        (a) =>
          a.entityType === 'TICKET' &&
          a.entityId === t.body.id &&
          a.action === 'AUTO_ASSIGN' &&
          a.actor === 'SYSTEM',
      ),
    ).toBeDefined();
  });

  it('D31: GET /projects/9999/workload → 404 for unknown project', async () => {
    await http
      .get('/projects/9999/workload')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('D31: GET workload on a soft-deleted project → 404', async () => {
    // eslint-disable-next-line no-restricted-syntax -- supertest HTTP method
    await http
      .delete(`/projects/${projectId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    await http
      .get(`/projects/${projectId}/workload`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('D34: concurrent auto-assign POSTs distribute evenly via per-project advisory lock', async () => {
    // 4 concurrent POSTs with no assigneeId, project has 2 DEVELOPERs.
    // Without D34: all 4 go to dev1 (both reads see the same snapshot
    // before any save commits). With D34: pg_advisory_xact_lock(P) serializes
    // the auto-assign branch, so each call's workload query reads the
    // previous commit — distribution is 2 + 2.
    const newTicket = (): Record<string, unknown> => ({
      title: 'T',
      description: 'd',
      status: 'TODO',
      priority: 'LOW',
      type: 'BUG',
      projectId,
    });

    const results = await Promise.all(
      [0, 1, 2, 3].map(() =>
        http
          .post('/tickets')
          .set('Authorization', `Bearer ${token}`)
          .send(newTicket()),
      ),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);

    const counts = new Map<number, number>();
    for (const r of results) {
      const a = r.body.assigneeId as number;
      counts.set(a, (counts.get(a) ?? 0) + 1);
    }
    // Both DEVELOPERs (dev1Id, dev2Id) should have been picked exactly twice.
    expect(counts.get(dev1Id)).toBe(2);
    expect(counts.get(dev2Id)).toBe(2);
  });

  it('tie-break: equal workload → oldest DEVELOPER (created_at ASC) wins', async () => {
    // Both devs at 0. dev1 was created first.
    const t = await http
      .post('/tickets')
      .set('Authorization', `Bearer ${token}`)
      .send(newTicket())
      .expect(200);
    expect(t.body.assigneeId).toBe(dev1Id);
  });
});
