import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { extractMentions } from '../src/modules/comments/mentions';
import { truncateAll } from './db-helpers';

jest.retryTimes(2);

describe('@mentions (Phase 6d)', () => {
  describe('regex (PDF §3.6 + G3)', () => {
    it('matches a simple @username', () => {
      expect(extractMentions('hello @jdoe')).toEqual(['jdoe']);
    });

    it('is case-insensitive (lowercased for comparison)', () => {
      expect(extractMentions('@JDoe @JDOE @jdoe')).toEqual(['jdoe']);
    });

    it('does NOT match @example inside an email address (negative lookbehind)', () => {
      expect(extractMentions('email me at jdoe@example.com')).toEqual([]);
    });

    it('captures multiple distinct usernames', () => {
      expect(extractMentions('hi @alice cc @bob @alice').sort()).toEqual([
        'alice',
        'bob',
      ]);
    });
  });

  describe('e2e', () => {
    let app: INestApplication;
    let ds: DataSource;
    let http: ReturnType<typeof request>;
    let aliceId: number;
    let bobId: number;
    let aliceToken: string;
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

      const alice = await http
        .post('/users')
        .send({
          username: 'alice',
          email: 'alice@example.com',
          fullName: 'Alice A',
          role: 'DEVELOPER',
          password: 'alicepass123',
        })
        .expect(200);
      aliceId = alice.body.id;
      const bob = await http
        .post('/users')
        .send({
          username: 'bob',
          email: 'bob@example.com',
          fullName: 'Bob B',
          role: 'DEVELOPER',
          password: 'bobpass1234',
        })
        .expect(200);
      bobId = bob.body.id;

      aliceToken = (
        await http
          .post('/auth/login')
          .send({ username: 'alice', password: 'alicepass123' })
          .expect(200)
      ).body.accessToken;

      projectId = (
        await http
          .post('/projects')
          .set('Authorization', `Bearer ${aliceToken}`)
          .send({ name: 'P', description: 'p', ownerId: aliceId })
          .expect(200)
      ).body.id;
      ticketId = (
        await http
          .post('/tickets')
          .set('Authorization', `Bearer ${aliceToken}`)
          .send({
            title: 'T',
            description: 't',
            status: 'TODO',
            priority: 'LOW',
            type: 'BUG',
            projectId,
          })
          .expect(200)
      ).body.id;
    });

    it('POST comment with @bob populates mentionedUsers; jdoe@example.com NOT mistakenly mentioned', async () => {
      const res = await http
        .post(`/tickets/${ticketId}/comments`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ content: 'hey @bob ping me at alice@example.com' })
        .expect(200);
      expect(res.body.mentionedUsers).toHaveLength(1);
      expect(res.body.mentionedUsers[0]).toMatchObject({
        id: bobId,
        username: 'bob',
        fullName: 'Bob B',
      });
    });

    it('PATCH re-evaluates mentions: removed mention is deleted, added mention is created', async () => {
      const c = await http
        .post(`/tickets/${ticketId}/comments`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ content: 'cc @bob' })
        .expect(200);

      await http
        .patch(`/tickets/${ticketId}/comments/${c.body.id}`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ content: 'cc @alice now' })
        .expect(200);

      const list = await http
        .get(`/tickets/${ticketId}/comments`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect(200);
      expect(list.body[0].mentionedUsers).toHaveLength(1);
      expect(list.body[0].mentionedUsers[0].username).toBe('alice');
    });

    it('GET /users/:id/mentions returns paginated comments newest-first', async () => {
      await http
        .post(`/tickets/${ticketId}/comments`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ content: 'first @bob' })
        .expect(200);
      // Tiny delay so the second comment has a strictly newer timestamp.
      await new Promise((r) => setTimeout(r, 10));
      await http
        .post(`/tickets/${ticketId}/comments`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ content: 'second @bob' })
        .expect(200);

      const res = await http
        .get(`/users/${bobId}/mentions`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect(200);
      // D32: response shape matches the README example verbatim — three
      // fields, no pageSize echoed.
      expect(res.body).toMatchObject({
        total: 2,
        page: 1,
      });
      expect(res.body).not.toHaveProperty('pageSize');
      expect(Object.keys(res.body).sort()).toEqual(['data', 'page', 'total']);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.data[0].content).toBe('second @bob');
      expect(res.body.data[1].content).toBe('first @bob');
    });

    it('D35: GET /users/:id/mentions?page=abc → 400 (NaN-safe via parsePositiveInt)', async () => {
      const res = await http
        .get(`/users/${bobId}/mentions?page=abc`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect(400);
      expect(JSON.stringify(res.body.message)).toMatch(/page/i);
    });

    it('D35: GET /users/:id/mentions?pageSize=abc → 400', async () => {
      await http
        .get(`/users/${bobId}/mentions?pageSize=abc`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect(400);
    });

    it('unresolvable @ghost is silently ignored (does not error)', async () => {
      const res = await http
        .post(`/tickets/${ticketId}/comments`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ content: 'who is @ghost?' })
        .expect(200);
      expect(res.body.mentionedUsers).toEqual([]);
    });

    it('GET /users/:id/mentions for unknown user → 404', async () => {
      await http
        .get('/users/9999/mentions')
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect(404);
    });
  });
});
