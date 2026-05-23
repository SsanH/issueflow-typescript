import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { truncateAll } from './db-helpers';

jest.retryTimes(2);

describe('Ticket CSV export/import (Phase 6c) e2e', () => {
  let app: INestApplication;
  let ds: DataSource;
  let http: ReturnType<typeof request>;

  let devToken: string;
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
    devToken = (
      await http
        .post('/auth/login')
        .send({ username: 'dev1', password: 'devpass12345' })
        .expect(200)
    ).body.accessToken;
    projectId = (
      await http
        .post('/projects')
        .set('Authorization', `Bearer ${devToken}`)
        .send({ name: 'P', description: 'p', ownerId: dev.body.id })
        .expect(200)
    ).body.id;
  });

  it('GET /tickets/export returns CSV with 7-column header', async () => {
    await http
      .post('/tickets')
      .set('Authorization', `Bearer ${devToken}`)
      .send({
        title: 'A',
        description: 'a',
        status: 'TODO',
        priority: 'LOW',
        type: 'BUG',
        projectId,
      })
      .expect(200);
    const res = await http
      .get(`/tickets/export?projectId=${projectId}`)
      .set('Authorization', `Bearer ${devToken}`)
      .expect(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text.split('\n')[0]).toBe(
      'id,title,description,status,priority,type,assigneeId',
    );
  });

  it('CSV correctly quotes a description containing commas', async () => {
    await http
      .post('/tickets')
      .set('Authorization', `Bearer ${devToken}`)
      .send({
        title: 'T',
        description: 'a, b, "c"',
        status: 'TODO',
        priority: 'LOW',
        type: 'BUG',
        projectId,
      })
      .expect(200);
    const res = await http
      .get(`/tickets/export?projectId=${projectId}`)
      .set('Authorization', `Bearer ${devToken}`)
      .expect(200);
    // csv-stringify quotes the field and escapes the internal quote.
    expect(res.text).toContain('"a, b, ""c"""');
  });

  it('POST /tickets/import requires projectId form field', async () => {
    await http
      .post('/tickets/import')
      .set('Authorization', `Bearer ${devToken}`)
      .attach('file', Buffer.from('id,title\n'), 'x.csv')
      .expect(400);
  });

  it('round-trip: export then re-import yields the same set of fields', async () => {
    await http
      .post('/tickets')
      .set('Authorization', `Bearer ${devToken}`)
      .send({
        title: 'A',
        description: 'a',
        status: 'TODO',
        priority: 'LOW',
        type: 'BUG',
        projectId,
      })
      .expect(200);
    await http
      .post('/tickets')
      .set('Authorization', `Bearer ${devToken}`)
      .send({
        title: 'B',
        description: 'b',
        status: 'IN_REVIEW',
        priority: 'HIGH',
        type: 'FEATURE',
        projectId,
      })
      .expect(200);

    const csv = (
      await http
        .get(`/tickets/export?projectId=${projectId}`)
        .set('Authorization', `Bearer ${devToken}`)
        .expect(200)
    ).text;

    const importRes = await http
      .post('/tickets/import')
      .set('Authorization', `Bearer ${devToken}`)
      .field('projectId', String(projectId))
      .attach('file', Buffer.from(csv), 'export.csv')
      .expect(200);
    expect(importRes.body).toEqual({ created: 2, failed: 0, errors: [] });

    const list = await http
      .get(`/tickets?projectId=${projectId}`)
      .set('Authorization', `Bearer ${devToken}`)
      .expect(200);
    // 2 originals + 2 imports = 4
    expect(list.body).toHaveLength(4);
  });

  it('per-row partial success: bad enum row counted in failed', async () => {
    const csv =
      'title,description,status,priority,type\n' +
      'good,desc,TODO,LOW,BUG\n' +
      'bad,desc,WAT,LOW,BUG\n';
    const res = await http
      .post('/tickets/import')
      .set('Authorization', `Bearer ${devToken}`)
      .field('projectId', String(projectId))
      .attach('file', Buffer.from(csv), 'in.csv')
      .expect(200);
    expect(res.body.created).toBe(1);
    expect(res.body.failed).toBe(1);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].line).toBe(3);
  });

  it('rejects a row with whitespace-only title; counted in failed (D20)', async () => {
    const csv =
      'title,description,status,priority,type\n' + '   ,desc,TODO,LOW,BUG\n';
    const res = await http
      .post('/tickets/import')
      .set('Authorization', `Bearer ${devToken}`)
      .field('projectId', String(projectId))
      .attach('file', Buffer.from(csv), 'blank-title.csv')
      .expect(200);
    expect(res.body.created).toBe(0);
    expect(res.body.failed).toBe(1);
    expect(JSON.stringify(res.body.errors)).toMatch(/title/);
  });

  it('accepts a row with empty description (D20 — Jira semantics)', async () => {
    const csv =
      'title,description,status,priority,type\n' + 'real-title,,TODO,LOW,BUG\n';
    const res = await http
      .post('/tickets/import')
      .set('Authorization', `Bearer ${devToken}`)
      .field('projectId', String(projectId))
      .attach('file', Buffer.from(csv), 'empty-desc.csv')
      .expect(200);
    expect(res.body.created).toBe(1);
    expect(res.body.failed).toBe(0);
  });

  it('import row with nonexistent assigneeId → counted in failed with a clear "user not found" reason', async () => {
    const csv =
      'title,description,status,priority,type,assigneeId\n' +
      'good,desc,TODO,LOW,BUG,9999\n';
    const res = await http
      .post('/tickets/import')
      .set('Authorization', `Bearer ${devToken}`)
      .field('projectId', String(projectId))
      .attach('file', Buffer.from(csv), 'bad-assignee.csv')
      .expect(200);
    expect(res.body.created).toBe(0);
    expect(res.body.failed).toBe(1);
    expect(res.body.errors).toHaveLength(1);
    // Clean per-row message — NOT a raw FK-constraint string.
    expect(res.body.errors[0].reason).toMatch(/user.*9999.*not found/i);
    expect(res.body.errors[0].reason).not.toMatch(/foreign key/i);
  });

  it('D35: CSV injection — formula-prefixed title is escaped on export', async () => {
    // The reviewer's exploit payload: =cmd|'/c calc.exe'!A1 in Excel
    // executes the calculator. The escape prefixes a `'` so it stays
    // visible-as-text and is not evaluated.
    const malicious = "=cmd|'/c calc.exe'!A1";
    await http
      .post('/tickets')
      .set('Authorization', `Bearer ${devToken}`)
      .send({
        title: malicious,
        description: 'd',
        status: 'TODO',
        priority: 'LOW',
        type: 'BUG',
        projectId,
      })
      .expect(200);

    const res = await http
      .get(`/tickets/export?projectId=${projectId}`)
      .set('Authorization', `Bearer ${devToken}`)
      .expect(200);
    // The exported CSV must contain the escaped form (leading apostrophe),
    // NOT the raw formula prefix at the start of the cell.
    expect(res.text).toContain(`'${malicious}`);
    // Sanity: no line starts with `=cmd` (would mean Excel-executable).
    const lines = res.text.split('\n');
    for (const line of lines) {
      // CSV cells are comma-separated; the title cell will be quoted if it
      // contains the comma in the payload. Strip leading quotes and check.
      expect(line).not.toMatch(/(^|,)"?=cmd/);
    }
  });

  it('D35: CSV injection — @ + - prefixes are also escaped', async () => {
    for (const payload of ['@SUM(A1)', '+1+2', '-1-2']) {
      await http
        .post('/tickets')
        .set('Authorization', `Bearer ${devToken}`)
        .send({
          title: payload,
          description: 'd',
          status: 'TODO',
          priority: 'LOW',
          type: 'BUG',
          projectId,
        })
        .expect(200);
    }
    const res = await http
      .get(`/tickets/export?projectId=${projectId}`)
      .set('Authorization', `Bearer ${devToken}`)
      .expect(200);
    for (const payload of ['@SUM(A1)', '+1+2', '-1-2']) {
      expect(res.text).toContain(`'${payload}`);
    }
  });

  it('D35: CSV injection — numeric fields (id, assigneeId) are NOT prefixed', async () => {
    await http
      .post('/tickets')
      .set('Authorization', `Bearer ${devToken}`)
      .send({
        title: 'safe-title',
        description: 'safe-desc',
        status: 'TODO',
        priority: 'LOW',
        type: 'BUG',
        projectId,
      })
      .expect(200);
    const res = await http
      .get(`/tickets/export?projectId=${projectId}`)
      .set('Authorization', `Bearer ${devToken}`)
      .expect(200);
    // The data row starts with `1,safe-title,...` — id stays a bare number.
    const dataLine = res.text.split('\n')[1];
    expect(dataLine).toMatch(/^1,/); // first cell is `1`, not `'1`
    expect(dataLine).not.toMatch(/^'/);
  });

  it('extra columns are silently ignored (D14)', async () => {
    const csv =
      'title,description,status,priority,type,dueDate,extra\n' +
      'a,b,TODO,LOW,BUG,2030-01-01,foo\n';
    const res = await http
      .post('/tickets/import')
      .set('Authorization', `Bearer ${devToken}`)
      .field('projectId', String(projectId))
      .attach('file', Buffer.from(csv), 'extras.csv')
      .expect(200);
    expect(res.body.created).toBe(1);
    expect(res.body.failed).toBe(0);
  });

  it('POST /tickets/import without a file → 400', async () => {
    await http
      .post('/tickets/import')
      .set('Authorization', `Bearer ${devToken}`)
      .field('projectId', String(projectId))
      .expect(400);
  });

  it('POST /tickets/import with non-integer projectId → 400', async () => {
    await http
      .post('/tickets/import')
      .set('Authorization', `Bearer ${devToken}`)
      .field('projectId', 'abc')
      .attach('file', Buffer.from('title\n'), 'x.csv')
      .expect(400);
  });

  it('POST /tickets/import with projectId=0 → 400 (must be positive)', async () => {
    await http
      .post('/tickets/import')
      .set('Authorization', `Bearer ${devToken}`)
      .field('projectId', '0')
      .attach('file', Buffer.from('title\n'), 'x.csv')
      .expect(400);
  });

  it('malformed CSV (unbalanced quote) → result with parse-error reason at line 0', async () => {
    // csv-parse throws on an unterminated quoted field. The service catches
    // that, returns a single-row error result with line 0 — proving the
    // parse-error path is wired (not surfaced as a 500).
    const broken = 'title,description\n"unterminated,still going\n';
    const res = await http
      .post('/tickets/import')
      .set('Authorization', `Bearer ${devToken}`)
      .field('projectId', String(projectId))
      .attach('file', Buffer.from(broken), 'broken.csv')
      .expect(200);
    expect(res.body.created).toBe(0);
    expect(res.body.failed).toBe(0);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].line).toBe(0);
    expect(res.body.errors[0].reason).toMatch(/CSV parse error/);
  });

  it('header-only CSV (zero rows) → { created: 0, failed: 0, errors: [] }', async () => {
    const headerOnly = 'id,title,description,status,priority,type,assigneeId\n';
    const res = await http
      .post('/tickets/import')
      .set('Authorization', `Bearer ${devToken}`)
      .field('projectId', String(projectId))
      .attach('file', Buffer.from(headerOnly), 'empty.csv')
      .expect(200);
    expect(res.body).toEqual({ created: 0, failed: 0, errors: [] });
  });
});
