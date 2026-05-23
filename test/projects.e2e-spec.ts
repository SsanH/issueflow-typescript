import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { AuditLog } from '../src/modules/audit/audit-log.entity';
import { truncateAll } from './db-helpers';

jest.retryTimes(2);

describe('Projects (Phase 2) e2e', () => {
  let app: INestApplication;
  let ds: DataSource;
  let http: ReturnType<typeof request>;

  // Helpers — created in beforeEach so every test starts from a clean DB.
  let adminToken: string;
  let devToken: string;
  let adminId: number;
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

  beforeEach(async () => {
    await truncateAll(ds);
    http = request(app.getHttpServer());

    // Create an ADMIN and a DEVELOPER, log them both in.
    const admin = await http
      .post('/users')
      .send({
        username: 'admin1',
        email: 'admin@example.com',
        fullName: 'Admin One',
        role: 'ADMIN',
        password: 'admin12345',
      })
      .expect(200);
    adminId = admin.body.id;

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

    const adminLogin = await http
      .post('/auth/login')
      .send({ username: 'admin1', password: 'admin12345' })
      .expect(200);
    adminToken = adminLogin.body.accessToken;

    const devLogin = await http
      .post('/auth/login')
      .send({ username: 'dev1', password: 'devpass12345' })
      .expect(200);
    devToken = devLogin.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
    if (ds.isInitialized) await ds.destroy();
  });

  describe('POST /projects', () => {
    it('creates a project and writes a CREATE audit row (D6)', async () => {
      const res = await http
        .post('/projects')
        .set('Authorization', `Bearer ${devToken}`)
        .send({
          name: 'IssueFlow',
          description: 'Ticket tracking',
          ownerId: devId,
        })
        .expect(200);
      expect(res.body).toMatchObject({
        id: 1,
        name: 'IssueFlow',
        description: 'Ticket tracking',
        ownerId: devId,
      });

      const audit = await ds.getRepository(AuditLog).find();
      const projectCreate = audit.find(
        (a) => a.entityType === 'PROJECT' && a.action === 'CREATE',
      );
      expect(projectCreate).toBeDefined();
      expect(projectCreate?.entityId).toBe(1);
      expect(projectCreate?.actor).toBe('USER');
      expect(projectCreate?.performedBy).toBe(devId);
    });

    it('rejects a nonexistent ownerId with 404', async () => {
      await http
        .post('/projects')
        .set('Authorization', `Bearer ${devToken}`)
        .send({ name: 'X', description: 'Y', ownerId: 9999 })
        .expect(404);
    });

    it('rejects missing fields with 400 (global ValidationPipe)', async () => {
      await http
        .post('/projects')
        .set('Authorization', `Bearer ${devToken}`)
        .send({ name: 'Only name' })
        .expect(400);
    });

    it('rejects a whitespace-only name (D20)', async () => {
      const res = await http
        .post('/projects')
        .set('Authorization', `Bearer ${devToken}`)
        .send({ name: '   ', description: 'd', ownerId: devId })
        .expect(400);
      expect(JSON.stringify(res.body.message)).toMatch(/name/i);
    });

    it('accepts an empty description (D20 — Jira semantics)', async () => {
      await http
        .post('/projects')
        .set('Authorization', `Bearer ${devToken}`)
        .send({ name: 'P', description: '', ownerId: devId })
        .expect(200);
    });
  });

  describe('GET /projects + GET /projects/:id', () => {
    it('lists projects and fetches by id', async () => {
      await http
        .post('/projects')
        .set('Authorization', `Bearer ${devToken}`)
        .send({ name: 'A', description: 'a', ownerId: devId })
        .expect(200);
      await http
        .post('/projects')
        .set('Authorization', `Bearer ${devToken}`)
        .send({ name: 'B', description: 'b', ownerId: adminId })
        .expect(200);

      const list = await http
        .get('/projects')
        .set('Authorization', `Bearer ${devToken}`)
        .expect(200);
      expect(list.body).toHaveLength(2);

      const one = await http
        .get('/projects/1')
        .set('Authorization', `Bearer ${devToken}`)
        .expect(200);
      expect(one.body.name).toBe('A');
    });

    it('GET unknown id → 404', async () => {
      await http
        .get('/projects/9999')
        .set('Authorization', `Bearer ${devToken}`)
        .expect(404);
    });
  });

  describe('updatedAt (D23)', () => {
    it('GET /projects/:id includes an updatedAt timestamp', async () => {
      await http
        .post('/projects')
        .set('Authorization', `Bearer ${devToken}`)
        .send({ name: 'A', description: 'a', ownerId: devId })
        .expect(200);

      const res = await http
        .get('/projects/1')
        .set('Authorization', `Bearer ${devToken}`)
        .expect(200);
      expect(res.body.updatedAt).toBeDefined();
      expect(Number.isFinite(Date.parse(res.body.updatedAt))).toBe(true);
    });

    it('PATCH /projects/:id advances updatedAt', async () => {
      await http
        .post('/projects')
        .set('Authorization', `Bearer ${devToken}`)
        .send({ name: 'A', description: 'a', ownerId: devId })
        .expect(200);
      const before = (
        await http
          .get('/projects/1')
          .set('Authorization', `Bearer ${devToken}`)
          .expect(200)
      ).body.updatedAt;

      await new Promise((r) => setTimeout(r, 10));
      await http
        .patch('/projects/1')
        .set('Authorization', `Bearer ${devToken}`)
        .send({ name: 'B' })
        .expect(200);

      const after = (
        await http
          .get('/projects/1')
          .set('Authorization', `Bearer ${devToken}`)
          .expect(200)
      ).body.updatedAt;
      expect(Date.parse(after)).toBeGreaterThan(Date.parse(before));
    });
  });

  describe('PATCH /projects/:id', () => {
    it('rejects a whitespace-only name on PATCH (D20)', async () => {
      await http
        .post('/projects')
        .set('Authorization', `Bearer ${devToken}`)
        .send({ name: 'Old', description: 'd', ownerId: devId })
        .expect(200);
      await http
        .patch('/projects/1')
        .set('Authorization', `Bearer ${devToken}`)
        .send({ name: '   ' })
        .expect(400);
    });

    it('updates name+description and writes UPDATE audit row', async () => {
      await http
        .post('/projects')
        .set('Authorization', `Bearer ${devToken}`)
        .send({ name: 'Old', description: 'old', ownerId: devId })
        .expect(200);

      await http
        .patch('/projects/1')
        .set('Authorization', `Bearer ${devToken}`)
        .send({ name: 'New', description: 'new' })
        .expect(200);

      const after = await http
        .get('/projects/1')
        .set('Authorization', `Bearer ${devToken}`)
        .expect(200);
      expect(after.body.name).toBe('New');
      expect(after.body.description).toBe('new');

      const audit = await ds.getRepository(AuditLog).find();
      expect(
        audit.find((a) => a.entityType === 'PROJECT' && a.action === 'UPDATE'),
      ).toBeDefined();
    });
  });

  describe('DELETE /projects/:id (soft-delete)', () => {
    it('hides project from list and writes SOFT_DELETE audit row', async () => {
      await http
        .post('/projects')
        .set('Authorization', `Bearer ${devToken}`)
        .send({ name: 'A', description: 'a', ownerId: devId })
        .expect(200);

      // eslint-disable-next-line no-restricted-syntax -- supertest HTTP method
      await http
        .delete('/projects/1')
        .set('Authorization', `Bearer ${devToken}`)
        .expect(200);

      const list = await http
        .get('/projects')
        .set('Authorization', `Bearer ${devToken}`)
        .expect(200);
      expect(list.body).toHaveLength(0);

      // GET by id also hides soft-deleted rows.
      await http
        .get('/projects/1')
        .set('Authorization', `Bearer ${devToken}`)
        .expect(404);

      const audit = await ds.getRepository(AuditLog).find();
      expect(
        audit.find(
          (a) => a.entityType === 'PROJECT' && a.action === 'SOFT_DELETE',
        ),
      ).toBeDefined();
    });
  });

  describe('GET /projects/deleted (ADMIN only, D13)', () => {
    beforeEach(async () => {
      await http
        .post('/projects')
        .set('Authorization', `Bearer ${devToken}`)
        .send({ name: 'A', description: 'a', ownerId: devId })
        .expect(200);
      // eslint-disable-next-line no-restricted-syntax -- supertest HTTP method
      await http
        .delete('/projects/1')
        .set('Authorization', `Bearer ${devToken}`)
        .expect(200);
    });

    it('DEVELOPER → 403', async () => {
      await http
        .get('/projects/deleted')
        .set('Authorization', `Bearer ${devToken}`)
        .expect(403);
    });

    it('ADMIN → 200 with only the soft-deleted rows', async () => {
      const res = await http
        .get('/projects/deleted')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].deletedAt).toBeTruthy();
    });
  });

  describe('POST /projects/:id/restore (ADMIN only, D13)', () => {
    beforeEach(async () => {
      await http
        .post('/projects')
        .set('Authorization', `Bearer ${devToken}`)
        .send({ name: 'A', description: 'a', ownerId: devId })
        .expect(200);
      // eslint-disable-next-line no-restricted-syntax -- supertest HTTP method
      await http
        .delete('/projects/1')
        .set('Authorization', `Bearer ${devToken}`)
        .expect(200);
    });

    it('DEVELOPER → 403', async () => {
      await http
        .post('/projects/1/restore')
        .set('Authorization', `Bearer ${devToken}`)
        .expect(403);
    });

    it('D31: restore response body is empty (README contract)', async () => {
      const res = await http
        .post('/projects/1/restore')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(res.body).toEqual({});
    });

    it('ADMIN → 200, project visible again, RESTORE audit row written', async () => {
      await http
        .post('/projects/1/restore')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const list = await http
        .get('/projects')
        .set('Authorization', `Bearer ${devToken}`)
        .expect(200);
      expect(list.body).toHaveLength(1);

      const audit = await ds.getRepository(AuditLog).find();
      expect(
        audit.find((a) => a.entityType === 'PROJECT' && a.action === 'RESTORE'),
      ).toBeDefined();
    });

    it('restoring a non-deleted project → 400', async () => {
      // First restore puts it back, second one should 400.
      await http
        .post('/projects/1/restore')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      await http
        .post('/projects/1/restore')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);
    });
  });
});
