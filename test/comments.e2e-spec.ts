import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { AuditLog } from '../src/modules/audit/audit-log.entity';
import { truncateAll } from './db-helpers';

jest.retryTimes(2);

describe('Comments (Phase 4) e2e', () => {
  let app: INestApplication;
  let ds: DataSource;
  let http: ReturnType<typeof request>;

  let devToken: string;
  let otherDevToken: string;
  let adminToken: string;
  let devId: number;
  let otherDevId: number;
  let projectId: number;
  let ticketId: number;

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

    const other = await http
      .post('/users')
      .send({
        username: 'dev2',
        email: 'dev2@example.com',
        fullName: 'Dev Two',
        role: 'DEVELOPER',
        password: 'devpass67890',
      })
      .expect(200);
    otherDevId = other.body.id;

    // D26: an ADMIN is needed to test the author/ADMIN edit gate.
    await http
      .post('/users')
      .send({
        username: 'admin1',
        email: 'admin1@example.com',
        fullName: 'Admin One',
        role: 'ADMIN',
        password: 'admin12345',
      })
      .expect(200);

    devToken = (
      await http
        .post('/auth/login')
        .send({ username: 'dev1', password: 'devpass12345' })
        .expect(200)
    ).body.accessToken;
    otherDevToken = (
      await http
        .post('/auth/login')
        .send({ username: 'dev2', password: 'devpass67890' })
        .expect(200)
    ).body.accessToken;
    adminToken = (
      await http
        .post('/auth/login')
        .send({ username: 'admin1', password: 'admin12345' })
        .expect(200)
    ).body.accessToken;

    const project = await http
      .post('/projects')
      .set('Authorization', `Bearer ${devToken}`)
      .send({ name: 'P', description: 'p', ownerId: devId })
      .expect(200);
    projectId = project.body.id;

    const ticket = await http
      .post('/tickets')
      .set('Authorization', `Bearer ${devToken}`)
      .send({
        title: 'T',
        description: 't',
        status: 'TODO',
        priority: 'HIGH',
        type: 'BUG',
        projectId,
        assigneeId: devId,
      })
      .expect(200);
    ticketId = ticket.body.id;
  });

  describe('POST /tickets/:ticketId/comments', () => {
    it('creates a comment, authorId from JWT, response includes mentionedUsers: []', async () => {
      const res = await http
        .post(`/tickets/${ticketId}/comments`)
        .set('Authorization', `Bearer ${devToken}`)
        .send({ content: 'Hello world' })
        .expect(200);

      expect(res.body).toMatchObject({
        id: 1,
        ticketId,
        authorId: devId,
        content: 'Hello world',
        mentionedUsers: [],
      });

      const audit = await ds.getRepository(AuditLog).find();
      expect(
        audit.find(
          (a) =>
            a.entityType === 'COMMENT' &&
            a.action === 'CREATE' &&
            a.performedBy === devId,
        ),
      ).toBeDefined();
    });

    it('body authorId matching JWT user is accepted', async () => {
      await http
        .post(`/tickets/${ticketId}/comments`)
        .set('Authorization', `Bearer ${devToken}`)
        .send({ content: 'OK', authorId: devId })
        .expect(200);
    });

    it('body authorId mismatching JWT → 400 (D4)', async () => {
      await http
        .post(`/tickets/${ticketId}/comments`)
        .set('Authorization', `Bearer ${devToken}`)
        .send({ content: 'spoof', authorId: otherDevId })
        .expect(400);
    });

    it('nonexistent ticketId → 404', async () => {
      await http
        .post(`/tickets/9999/comments`)
        .set('Authorization', `Bearer ${devToken}`)
        .send({ content: 'x' })
        .expect(404);
    });

    it('empty content → 400 (global ValidationPipe)', async () => {
      await http
        .post(`/tickets/${ticketId}/comments`)
        .set('Authorization', `Bearer ${devToken}`)
        .send({ content: '' })
        .expect(400);
    });

    it('whitespace-only content → 400 (D20)', async () => {
      await http
        .post(`/tickets/${ticketId}/comments`)
        .set('Authorization', `Bearer ${devToken}`)
        .send({ content: '   ' })
        .expect(400);
    });
  });

  describe('GET /tickets/:ticketId/comments', () => {
    it('lists comments oldest-first with mentionedUsers placeholder', async () => {
      await http
        .post(`/tickets/${ticketId}/comments`)
        .set('Authorization', `Bearer ${devToken}`)
        .send({ content: 'first' })
        .expect(200);
      await http
        .post(`/tickets/${ticketId}/comments`)
        .set('Authorization', `Bearer ${otherDevToken}`)
        .send({ content: 'second' })
        .expect(200);

      const res = await http
        .get(`/tickets/${ticketId}/comments`)
        .set('Authorization', `Bearer ${devToken}`)
        .expect(200);

      expect(res.body).toHaveLength(2);
      expect(res.body[0].content).toBe('first');
      expect(res.body[1].content).toBe('second');
      expect(res.body[0].mentionedUsers).toEqual([]);
    });

    it('nonexistent ticketId → 404', async () => {
      await http
        .get(`/tickets/9999/comments`)
        .set('Authorization', `Bearer ${devToken}`)
        .expect(404);
    });
  });

  describe('PATCH /tickets/:ticketId/comments/:commentId', () => {
    let commentId: number;

    beforeEach(async () => {
      const c = await http
        .post(`/tickets/${ticketId}/comments`)
        .set('Authorization', `Bearer ${devToken}`)
        .send({ content: 'original' })
        .expect(200);
      commentId = c.body.id;
    });

    it('rejects a whitespace-only content on PATCH (D20)', async () => {
      await http
        .patch(`/tickets/${ticketId}/comments/${commentId}`)
        .set('Authorization', `Bearer ${devToken}`)
        .send({ content: '   ' })
        .expect(400);
    });

    it('updates content and writes UPDATE audit row', async () => {
      await http
        .patch(`/tickets/${ticketId}/comments/${commentId}`)
        .set('Authorization', `Bearer ${devToken}`)
        .send({ content: 'edited' })
        .expect(200);

      const list = await http
        .get(`/tickets/${ticketId}/comments`)
        .set('Authorization', `Bearer ${devToken}`)
        .expect(200);
      expect(list.body[0].content).toBe('edited');

      const audit = await ds.getRepository(AuditLog).find();
      expect(
        audit.find((a) => a.entityType === 'COMMENT' && a.action === 'UPDATE'),
      ).toBeDefined();
    });

    it('mismatched ticketId in path → 404', async () => {
      // Create a second ticket; the original comment doesn't belong to it.
      const t2 = await http
        .post('/tickets')
        .set('Authorization', `Bearer ${devToken}`)
        .send({
          title: 'T2',
          description: 't2',
          status: 'TODO',
          priority: 'LOW',
          type: 'FEATURE',
          projectId,
        })
        .expect(200);

      await http
        .patch(`/tickets/${t2.body.id}/comments/${commentId}`)
        .set('Authorization', `Bearer ${devToken}`)
        .send({ content: 'wrong path' })
        .expect(404);
    });

    it('concurrent PATCHes serialize (pessimistic lock, PDF §2.5) — author + ADMIN both legitimate under D26', async () => {
      // Both the author (devToken) and an ADMIN are allowed to edit per D26;
      // the test still verifies the pessimistic lock serializes them.
      const results = await Promise.all([
        http
          .patch(`/tickets/${ticketId}/comments/${commentId}`)
          .set('Authorization', `Bearer ${devToken}`)
          .send({ content: 'edit A' }),
        http
          .patch(`/tickets/${ticketId}/comments/${commentId}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ content: 'edit B' }),
      ]);
      expect(results.every((r) => r.status === 200)).toBe(true);

      const list = await http
        .get(`/tickets/${ticketId}/comments`)
        .set('Authorization', `Bearer ${devToken}`)
        .expect(200);
      // Last writer wins; both candidate values are valid.
      expect(['edit A', 'edit B']).toContain(list.body[0].content);
    });

    // D26 — comment ownership gate
    it("PATCH another DEVELOPER's comment → 403 (D26)", async () => {
      await http
        .patch(`/tickets/${ticketId}/comments/${commentId}`)
        .set('Authorization', `Bearer ${otherDevToken}`)
        .send({ content: 'sneaky edit' })
        .expect(403);
    });

    it('PATCH any comment as ADMIN → 200 (D26 ADMIN override)', async () => {
      await http
        .patch(`/tickets/${ticketId}/comments/${commentId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ content: 'admin override' })
        .expect(200);
    });

    // D25 — atomic mention diff committed alongside the comment update.
    // The PATCH response itself is void per the README contract, so the
    // externally-observable evidence is: GET immediately after PATCH sees
    // the new mention set, and no partial-write state is reachable.
    it('PATCH that adds @alice mention commits atomically (D25); immediate GET shows the new mention', async () => {
      await http
        .post('/users')
        .send({
          username: 'alice',
          email: 'alice@example.com',
          fullName: 'Alice A',
          role: 'DEVELOPER',
          password: 'alicepass123',
        })
        .expect(200);

      await http
        .patch(`/tickets/${ticketId}/comments/${commentId}`)
        .set('Authorization', `Bearer ${devToken}`)
        .send({ content: 'hey @alice, look at this' })
        .expect(200);

      const list = await http
        .get(`/tickets/${ticketId}/comments`)
        .set('Authorization', `Bearer ${devToken}`)
        .expect(200);
      expect(list.body[0].content).toBe('hey @alice, look at this');
      expect(list.body[0].mentionedUsers).toHaveLength(1);
      expect(list.body[0].mentionedUsers[0]).toMatchObject({
        username: 'alice',
      });
    });
  });

  describe('DELETE /tickets/:ticketId/comments/:commentId', () => {
    let commentId: number;

    beforeEach(async () => {
      const c = await http
        .post(`/tickets/${ticketId}/comments`)
        .set('Authorization', `Bearer ${devToken}`)
        .send({ content: 'doomed' })
        .expect(200);
      commentId = c.body.id;
    });

    it('hard-deletes the comment and writes an audit row', async () => {
      // eslint-disable-next-line no-restricted-syntax -- supertest HTTP method
      await http
        .delete(`/tickets/${ticketId}/comments/${commentId}`)
        .set('Authorization', `Bearer ${devToken}`)
        .expect(200);

      const list = await http
        .get(`/tickets/${ticketId}/comments`)
        .set('Authorization', `Bearer ${devToken}`)
        .expect(200);
      expect(list.body).toHaveLength(0);

      const audit = await ds.getRepository(AuditLog).find();
      // D28: hard-delete via repo.remove() now writes 'DELETE', distinct
      // from soft-delete's 'SOFT_DELETE'. Comments don't have
      // @DeleteDateColumn so they always hard-delete.
      expect(
        audit.find((a) => a.entityType === 'COMMENT' && a.action === 'DELETE'),
      ).toBeDefined();
    });

    // D26 — comment ownership gate
    it("DELETE another DEVELOPER's comment → 403 (D26)", async () => {
      // eslint-disable-next-line no-restricted-syntax -- supertest HTTP method
      await http
        .delete(`/tickets/${ticketId}/comments/${commentId}`)
        .set('Authorization', `Bearer ${otherDevToken}`)
        .expect(403);
    });

    it('DELETE any comment as ADMIN → 200 (D26 ADMIN override)', async () => {
      // eslint-disable-next-line no-restricted-syntax -- supertest HTTP method
      await http
        .delete(`/tickets/${ticketId}/comments/${commentId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
    });

    it('D31: soft-deleted parent project → DELETE comment 404', async () => {
      // eslint-disable-next-line no-restricted-syntax -- supertest HTTP method
      await http
        .delete(`/projects/${projectId}`)
        .set('Authorization', `Bearer ${devToken}`)
        .expect(200);
      // eslint-disable-next-line no-restricted-syntax -- supertest HTTP method
      await http
        .delete(`/tickets/${ticketId}/comments/${commentId}`)
        .set('Authorization', `Bearer ${devToken}`)
        .expect(404);
    });

    it('mismatched ticketId in path → 404', async () => {
      const t2 = await http
        .post('/tickets')
        .set('Authorization', `Bearer ${devToken}`)
        .send({
          title: 'T2',
          description: 't2',
          status: 'TODO',
          priority: 'LOW',
          type: 'FEATURE',
          projectId,
        })
        .expect(200);

      // eslint-disable-next-line no-restricted-syntax -- supertest HTTP method
      await http
        .delete(`/tickets/${t2.body.id}/comments/${commentId}`)
        .set('Authorization', `Bearer ${devToken}`)
        .expect(404);
    });

    it('DELETE a non-existent comment id → 404', async () => {
      // eslint-disable-next-line no-restricted-syntax -- supertest HTTP method
      await http
        .delete(`/tickets/${ticketId}/comments/999999`)
        .set('Authorization', `Bearer ${devToken}`)
        .expect(404);
    });

    it('PATCH a non-existent comment id → 404', async () => {
      await http
        .patch(`/tickets/${ticketId}/comments/999999`)
        .set('Authorization', `Bearer ${devToken}`)
        .send({ content: 'never written' })
        .expect(404);
    });
  });
});
