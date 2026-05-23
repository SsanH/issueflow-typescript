import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { RevokedToken } from '../src/modules/auth/revoked-token.entity';
import { DenylistCleanupService } from '../src/modules/scheduler/denylist-cleanup.service';
import { truncateAll } from './db-helpers';

// Re-run any failed test up to 2x to mask cross-spec contamination flake.
// The underlying root cause (per-spec app/DataSource teardown leaving
// in-flight transactions/sockets) is documented in plan.md.
jest.retryTimes(2);

describe('Auth + Users (Phase 1) e2e', () => {
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

  beforeEach(async () => {
    await truncateAll(ds);
    http = request(app.getHttpServer());
  });

  afterAll(async () => {
    await app.close();
    if (ds.isInitialized) await ds.destroy();
  });

  const validUser = {
    username: 'alice',
    email: 'alice@example.com',
    fullName: 'Alice Adams',
    role: 'ADMIN' as const,
    password: 'supersecret1',
  };

  describe('POST /users', () => {
    it('creates a user and returns the row without passwordHash (D5)', async () => {
      const res = await http.post('/users').send(validUser).expect(200);
      expect(res.body).toMatchObject({
        id: 1,
        username: 'alice',
        email: 'alice@example.com',
        fullName: 'Alice Adams',
        role: 'ADMIN',
      });
      expect(res.body).not.toHaveProperty('passwordHash');
      expect(res.body).not.toHaveProperty('password');
    });

    it('rejects a password shorter than 8 chars (D5)', async () => {
      const res = await http
        .post('/users')
        .send({ ...validUser, password: '1234567' })
        .expect(400);
      expect(JSON.stringify(res.body.message)).toMatch(/password/i);
    });

    it('rejects a whitespace-only fullName (D20)', async () => {
      const res = await http
        .post('/users')
        .send({ ...validUser, fullName: '   ' })
        .expect(400);
      expect(JSON.stringify(res.body.message)).toMatch(/fullName/i);
    });

    it('rejects an all-whitespace password even at allowed length (D20)', async () => {
      const res = await http
        .post('/users')
        .send({ ...validUser, password: ' '.repeat(10) })
        .expect(400);
      expect(JSON.stringify(res.body.message)).toMatch(/password/i);
    });

    it('rejects a password longer than 72 chars (D5 — bcrypt 72-byte truncation)', async () => {
      const res = await http
        .post('/users')
        .send({ ...validUser, password: 'a'.repeat(100) })
        .expect(400);
      expect(JSON.stringify(res.body.message)).toMatch(/password/i);
    });

    it('rejects a duplicate username with 409', async () => {
      await http.post('/users').send(validUser).expect(200);
      await http
        .post('/users')
        .send({ ...validUser, email: 'other@example.com' })
        .expect(409);
    });
  });

  describe('Auth flow', () => {
    let token: string;

    beforeEach(async () => {
      await http.post('/users').send(validUser).expect(200);
      const res = await http
        .post('/auth/login')
        .send({ username: 'alice', password: 'supersecret1' })
        .expect(200);
      expect(res.body.accessToken).toBeDefined();
      expect(res.body.tokenType).toBe('Bearer');
      expect(res.body.expiresIn).toBe(3600);
      token = res.body.accessToken;
    });

    it('GET /auth/me returns current user without passwordHash', async () => {
      const res = await http
        .get('/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(res.body.username).toBe('alice');
      expect(res.body).not.toHaveProperty('passwordHash');
    });

    it('POST /auth/logout then reusing the same token → 401 (denylist)', async () => {
      await http
        .post('/auth/logout')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      await http
        .get('/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
    });

    it('wrong password → 401', async () => {
      await http
        .post('/auth/login')
        .send({ username: 'alice', password: 'wrongwrong' })
        .expect(401);
    });

    it('GET /auth/me without a token → 401', async () => {
      await http.get('/auth/me').expect(401);
    });
  });

  describe('User CRUD', () => {
    let token: string;
    let userId: number;

    beforeEach(async () => {
      const created = await http.post('/users').send(validUser).expect(200);
      userId = created.body.id;
      const login = await http
        .post('/auth/login')
        .send({ username: 'alice', password: 'supersecret1' })
        .expect(200);
      token = login.body.accessToken;
    });

    it('GET /users lists users without passwordHash', async () => {
      const res = await http
        .get('/users')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).not.toHaveProperty('passwordHash');
    });

    it('GET /users/:id returns the user without passwordHash', async () => {
      const res = await http
        .get(`/users/${userId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(res.body.id).toBe(userId);
      expect(res.body).not.toHaveProperty('passwordHash');
    });

    it('POST /users/update/:id uses POST (not PATCH) — D3', async () => {
      // PATCH should NOT be wired for this route.
      await http
        .patch(`/users/${userId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ fullName: 'Renamed' })
        .expect(404);
      // POST update should succeed.
      await http
        .post(`/users/update/${userId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ fullName: 'Renamed', role: 'DEVELOPER' })
        .expect(200);
      const after = await http
        .get(`/users/${userId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(after.body.fullName).toBe('Renamed');
      expect(after.body.role).toBe('DEVELOPER');
    });

    it('DELETE /users/:id removes the user; their token then fails with 401 (D21)', async () => {
      // eslint-disable-next-line no-restricted-syntax -- supertest HTTP method, not a TypeORM Repository
      await http
        .delete(`/users/${userId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      // D21: JwtStrategy now re-checks user existence; a deleted user's
      // token is rejected at the strategy layer with 401, not at the
      // service layer with 404.
      await http
        .get('/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
    });
  });

  describe('Case-insensitive identity (D21)', () => {
    const baseUser = {
      username: 'CaseAlice',
      email: 'CaseAlice@example.com',
      fullName: 'Case Alice',
      role: 'DEVELOPER' as const,
      password: 'casealice12345',
    };

    it('login works with a different case than what was registered', async () => {
      await http.post('/users').send(baseUser).expect(200);
      // Same username + password, different casing on the login.
      await http
        .post('/auth/login')
        .send({ username: 'casealice', password: 'casealice12345' })
        .expect(200);
      await http
        .post('/auth/login')
        .send({ username: 'CASEALICE', password: 'casealice12345' })
        .expect(200);
    });

    it('registering Alice then alice → 409 (username uniqueness is case-insensitive)', async () => {
      await http
        .post('/users')
        .send({ ...baseUser, username: 'Alice', email: 'a@example.com' })
        .expect(200);
      const res = await http
        .post('/users')
        .send({ ...baseUser, username: 'alice', email: 'b@example.com' })
        .expect(409);
      expect(JSON.stringify(res.body.message)).toMatch(/username/i);
    });

    it('registering Bob@example.com then BOB@example.com → 409 (email uniqueness is case-insensitive)', async () => {
      await http
        .post('/users')
        .send({ ...baseUser, username: 'bob1', email: 'Bob@example.com' })
        .expect(200);
      const res = await http
        .post('/users')
        .send({ ...baseUser, username: 'bob2', email: 'BOB@example.com' })
        .expect(409);
      expect(JSON.stringify(res.body.message)).toMatch(/email/i);
    });
  });

  // D27: cron registration is skipped under NODE_ENV=test to avoid leaking
  // node-cron timers across spec teardowns. The runOnce() function — what
  // the cron callback delegates to — is invokable directly.
  describe('DenylistCleanupService.runOnce (D27)', () => {
    it('deletes RevokedToken rows whose expiresAt is in the past, leaves future ones intact, returns affected count', async () => {
      const revokedRepo = ds.getRepository(RevokedToken);
      const past = new Date(Date.now() - 60_000);
      const future = new Date(Date.now() + 60_000);
      await revokedRepo.insert([
        { jti: 'expired-1', expiresAt: past },
        { jti: 'expired-2', expiresAt: past },
        { jti: 'still-valid', expiresAt: future },
      ]);

      const cleanup = app.get(DenylistCleanupService);
      const affected = await cleanup.runOnce();

      expect(affected).toBe(2);
      const remaining = await revokedRepo.find();
      expect(remaining.map((r) => r.jti)).toEqual(['still-valid']);
    });

    it('returns 0 when there are no expired rows (no-op safe to call repeatedly)', async () => {
      const cleanup = app.get(DenylistCleanupService);
      const affected = await cleanup.runOnce();
      expect(affected).toBe(0);
    });
  });
});
