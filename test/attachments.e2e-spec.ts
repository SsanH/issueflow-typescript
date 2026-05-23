import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import * as request from 'supertest';
import { promises as fs } from 'fs';
import * as path from 'path';
import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { Attachment } from '../src/modules/attachments/attachment.entity';
import { truncateAll } from './db-helpers';

// 1x1 transparent PNG, valid magic-number (89 50 4E 47).
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000100' +
    '1d04270b0000000049454e44ae426082',
  'hex',
);

jest.retryTimes(2);

describe('Attachments (Phase 6b) e2e', () => {
  let app: INestApplication;
  let ds: DataSource;
  let http: ReturnType<typeof request>;

  let devToken: string;
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
    devToken = (
      await http
        .post('/auth/login')
        .send({ username: 'dev1', password: 'devpass12345' })
        .expect(200)
    ).body.accessToken;
    const project = await http
      .post('/projects')
      .set('Authorization', `Bearer ${devToken}`)
      .send({ name: 'P', description: 'p', ownerId: dev.body.id })
      .expect(200);
    const ticket = await http
      .post('/tickets')
      .set('Authorization', `Bearer ${devToken}`)
      .send({
        title: 'T',
        description: 'd',
        status: 'TODO',
        priority: 'LOW',
        type: 'BUG',
        projectId: project.body.id,
      })
      .expect(200);
    ticketId = ticket.body.id;
  });

  it('accepts a valid PNG; row written; file exists on disk', async () => {
    const res = await http
      .post(`/tickets/${ticketId}/attachments`)
      .set('Authorization', `Bearer ${devToken}`)
      .attach('file', TINY_PNG, {
        filename: 'pixel.png',
        contentType: 'image/png',
      })
      .expect(200);
    expect(res.body).toMatchObject({
      id: 1,
      ticketId,
      filename: 'pixel.png',
      contentType: 'image/png',
    });

    const row = await ds
      .getRepository(Attachment)
      .findOneByOrFail({ id: res.body.id });
    await expect(fs.access(row.storagePath)).resolves.toBeUndefined();
  });

  it('rejects an .exe disguised as image/png (magic-number sniff, D9)', async () => {
    const fakePng = Buffer.from('MZ\x90\x00fake-exe-bytes'); // PE header
    const res = await http
      .post(`/tickets/${ticketId}/attachments`)
      .set('Authorization', `Bearer ${devToken}`)
      .attach('file', fakePng, {
        filename: 'malware.png',
        contentType: 'image/png',
      })
      .expect(415);
    expect(res.body.message).toMatch(/declared MIME/i);
  });

  it('rejects an unsupported MIME type', async () => {
    await http
      .post(`/tickets/${ticketId}/attachments`)
      .set('Authorization', `Bearer ${devToken}`)
      .attach('file', Buffer.from('whatever'), {
        filename: 'a.bin',
        contentType: 'application/octet-stream',
      })
      .expect(415);
  });

  it('accepts text/plain when content is plain text', async () => {
    await http
      .post(`/tickets/${ticketId}/attachments`)
      .set('Authorization', `Bearer ${devToken}`)
      .attach('file', Buffer.from('hello world\n'), {
        filename: 'note.txt',
        contentType: 'text/plain',
      })
      .expect(200);
  });

  it('rejects text/plain when content has NUL bytes (likely binary)', async () => {
    await http
      .post(`/tickets/${ticketId}/attachments`)
      .set('Authorization', `Bearer ${devToken}`)
      .attach('file', Buffer.from([0x00, 0x01, 0x02, 0x03]), {
        filename: 'fake.txt',
        contentType: 'text/plain',
      })
      .expect(415);
  });

  it('DELETE removes row and unlinks file', async () => {
    const created = await http
      .post(`/tickets/${ticketId}/attachments`)
      .set('Authorization', `Bearer ${devToken}`)
      .attach('file', TINY_PNG, {
        filename: 'pixel.png',
        contentType: 'image/png',
      })
      .expect(200);
    const row = await ds
      .getRepository(Attachment)
      .findOneByOrFail({ id: created.body.id });

    // eslint-disable-next-line no-restricted-syntax -- supertest HTTP method
    await http
      .delete(`/tickets/${ticketId}/attachments/${created.body.id}`)
      .set('Authorization', `Bearer ${devToken}`)
      .expect(200);

    await expect(fs.access(row.storagePath)).rejects.toThrow();
  });

  // --- D31: parent project visibility ---

  it('D31: soft-deleted parent project → POST attachment 404', async () => {
    // eslint-disable-next-line no-restricted-syntax -- supertest HTTP method
    await http
      .delete(`/projects/1`)
      .set('Authorization', `Bearer ${devToken}`)
      .expect(200);
    await http
      .post(`/tickets/${ticketId}/attachments`)
      .set('Authorization', `Bearer ${devToken}`)
      .attach('file', TINY_PNG, {
        filename: 'pixel.png',
        contentType: 'image/png',
      })
      .expect(404);
  });

  // --- D30 hardening ---

  it('D30: rejects empty file (size === 0) with 400', async () => {
    await http
      .post(`/tickets/${ticketId}/attachments`)
      .set('Authorization', `Bearer ${devToken}`)
      .attach('file', Buffer.alloc(0), {
        filename: 'empty.txt',
        contentType: 'text/plain',
      })
      .expect(400);
  });

  it('D30: rejects UTF-16 text declared as text/plain (UTF-8 only)', async () => {
    // "Hello" in UTF-16 LE → every ASCII char has a 0x00 high byte. The
    // tightened range check rejects 0x00 → UnsupportedMediaType.
    const utf16 = Buffer.from('H\x00e\x00l\x00l\x00o\x00', 'binary');
    await http
      .post(`/tickets/${ticketId}/attachments`)
      .set('Authorization', `Bearer ${devToken}`)
      .attach('file', utf16, {
        filename: 'utf16.txt',
        contentType: 'text/plain',
      })
      .expect(415);
  });

  it('D30: rejects ZIP-like binary declared as text/plain (control-byte check)', async () => {
    // ZIP magic: 0x50 0x4B 0x03 0x04. 0x03 (ETX) trips the control-byte
    // guard even though there are no NULs in the prefix.
    const zipLike = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x08]);
    await http
      .post(`/tickets/${ticketId}/attachments`)
      .set('Authorization', `Bearer ${devToken}`)
      .attach('file', zipLike, {
        filename: 'evil.txt',
        contentType: 'text/plain',
      })
      .expect(415);
  });

  it('D30: on-disk filename uses MIME-derived extension, not the user-supplied one', async () => {
    // User uploads "innocent.exe" with valid PNG bytes and image/png MIME.
    // Even though the magic-number sniff passes, the on-disk file must
    // NOT carry the .exe extension — the canonical .png extension is
    // derived from the validated MIME.
    const res = await http
      .post(`/tickets/${ticketId}/attachments`)
      .set('Authorization', `Bearer ${devToken}`)
      .attach('file', TINY_PNG, {
        filename: 'innocent.exe',
        contentType: 'image/png',
      })
      .expect(200);

    const row = await ds
      .getRepository(Attachment)
      .findOneByOrFail({ id: res.body.id });
    // DB filename preserves the (sanitized) original for display.
    expect(row.filename).toBe('innocent.exe');
    // On-disk path ends in .png, NOT .exe — derived from validated MIME.
    expect(row.storagePath.endsWith('.png')).toBe(true);
    expect(row.storagePath.endsWith('.exe')).toBe(false);
  });

  it('D30: path-traversal filename is neutralized; on-disk path stays under ./uploads/<ticketId>/', async () => {
    const res = await http
      .post(`/tickets/${ticketId}/attachments`)
      .set('Authorization', `Bearer ${devToken}`)
      .attach('file', TINY_PNG, {
        filename: '../../etc/passwd',
        contentType: 'image/png',
      })
      .expect(200);

    const row = await ds
      .getRepository(Attachment)
      .findOneByOrFail({ id: res.body.id });
    // Original name in DB has separators stripped and ".."  collapsed.
    expect(row.filename).not.toContain('/');
    expect(row.filename).not.toContain('..');
    // On-disk path is rooted at ./uploads/<ticketId>/ — no escape.
    const expectedPrefix = path.join('uploads', String(ticketId)) + path.sep;
    expect(row.storagePath.endsWith('.png')).toBe(true);
    expect(row.storagePath.includes(expectedPrefix)).toBe(true);
    expect(row.storagePath.includes('..')).toBe(false);
    expect(row.storagePath.includes('etc')).toBe(false);
  });

  it('DELETE a non-existent attachment id → 404', async () => {
    // eslint-disable-next-line no-restricted-syntax -- supertest HTTP method
    await http
      .delete(`/tickets/${ticketId}/attachments/999999`)
      .set('Authorization', `Bearer ${devToken}`)
      .expect(404);
  });

  it('DELETE an attachment via the wrong parent ticket → 404 (mismatch guard)', async () => {
    // Need projectId of the existing ticket to create a sibling. The
    // beforeEach only exposes ticketId/devToken, so fetch it.
    const original = await http
      .get(`/tickets/${ticketId}`)
      .set('Authorization', `Bearer ${devToken}`)
      .expect(200);
    const projectId: number = original.body.projectId;
    const otherTicket = await http
      .post('/tickets')
      .set('Authorization', `Bearer ${devToken}`)
      .send({
        title: 'other',
        description: 'other',
        status: 'TODO',
        priority: 'LOW',
        type: 'BUG',
        projectId,
      })
      .expect(200);
    // Attach a PNG to the original ticket.
    const att = await http
      .post(`/tickets/${ticketId}/attachments`)
      .set('Authorization', `Bearer ${devToken}`)
      .attach('file', TINY_PNG, { filename: 'a.png', contentType: 'image/png' })
      .expect(200);
    // DELETE under the other ticket's path → 404; attachment row remains.
    // eslint-disable-next-line no-restricted-syntax -- supertest HTTP method
    await http
      .delete(`/tickets/${otherTicket.body.id}/attachments/${att.body.id}`)
      .set('Authorization', `Bearer ${devToken}`)
      .expect(404);
    const survives = await ds
      .getRepository(Attachment)
      .findOne({ where: { id: att.body.id } });
    expect(survives).not.toBeNull();
  });
});
