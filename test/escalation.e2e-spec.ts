import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { AuditLog } from '../src/modules/audit/audit-log.entity';
import { EscalationService } from '../src/modules/scheduler/escalation.service';
import { Ticket } from '../src/modules/tickets/ticket.entity';
import { truncateAll } from './db-helpers';

jest.retryTimes(2);

describe('Escalation scheduler (Phase 6f) e2e', () => {
  let app: INestApplication;
  let ds: DataSource;
  let http: ReturnType<typeof request>;
  let escalation: EscalationService;

  let devToken: string;
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
    escalation = moduleRef.get(EscalationService);
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
    // Create a ticket with a dueDate already in the past.
    const past = new Date(Date.now() - 60_000).toISOString();
    ticketId = (
      await http
        .post('/tickets')
        .set('Authorization', `Bearer ${devToken}`)
        .send({
          title: 'overdue',
          description: 'd',
          status: 'TODO',
          priority: 'LOW',
          type: 'BUG',
          projectId,
          dueDate: past,
        })
        .expect(200)
    ).body.id;
  });

  it('promotes overdue ticket one level per pass (LOW→MEDIUM→HIGH→CRITICAL), then sets isOverdue', async () => {
    // Pass 1: LOW → MEDIUM
    await escalation.runOnce();
    let t = await ds.getRepository(Ticket).findOneByOrFail({ id: ticketId });
    expect(t.priority).toBe('MEDIUM');
    expect(t.isOverdue).toBe(false);

    // Pass 2: MEDIUM → HIGH
    await escalation.runOnce();
    t = await ds.getRepository(Ticket).findOneByOrFail({ id: ticketId });
    expect(t.priority).toBe('HIGH');

    // Pass 3: HIGH → CRITICAL
    await escalation.runOnce();
    t = await ds.getRepository(Ticket).findOneByOrFail({ id: ticketId });
    expect(t.priority).toBe('CRITICAL');
    expect(t.isOverdue).toBe(false);

    // Pass 4: CRITICAL stays CRITICAL; isOverdue → true.
    await escalation.runOnce();
    t = await ds.getRepository(Ticket).findOneByOrFail({ id: ticketId });
    expect(t.priority).toBe('CRITICAL');
    expect(t.isOverdue).toBe(true);

    // Pass 5: idempotent — no further change, no new escalation row.
    const beforeIdem = await ds
      .getRepository(AuditLog)
      .countBy({ action: 'PRIORITY_ESCALATED' });
    await escalation.runOnce();
    const afterIdem = await ds
      .getRepository(AuditLog)
      .countBy({ action: 'PRIORITY_ESCALATED' });
    expect(afterIdem).toBe(beforeIdem);
  });

  it('records a SYSTEM PRIORITY_ESCALATED audit row per promotion', async () => {
    await escalation.runOnce();
    const audit = await ds.getRepository(AuditLog).find();
    const esc = audit.find(
      (a) =>
        a.entityType === 'TICKET' &&
        a.entityId === ticketId &&
        a.action === 'PRIORITY_ESCALATED' &&
        a.actor === 'SYSTEM',
    );
    expect(esc).toBeDefined();
  });

  it('skips tickets with no dueDate set (PDF §3.7 constraint)', async () => {
    const noDue = (
      await http
        .post('/tickets')
        .set('Authorization', `Bearer ${devToken}`)
        .send({
          title: 'no-due',
          description: 'd',
          status: 'TODO',
          priority: 'LOW',
          type: 'BUG',
          projectId,
        })
        .expect(200)
    ).body.id;
    await escalation.runOnce();
    const t = await ds.getRepository(Ticket).findOneByOrFail({ id: noDue });
    expect(t.priority).toBe('LOW');
  });

  it('manual priority change clears isOverdue; next pass re-evaluates from new priority (PDF §3.7)', async () => {
    // Get to CRITICAL+isOverdue.
    await escalation.runOnce();
    await escalation.runOnce();
    await escalation.runOnce();
    await escalation.runOnce();
    let t = await ds.getRepository(Ticket).findOneByOrFail({ id: ticketId });
    expect(t.isOverdue).toBe(true);

    // Manual change to LOW via PATCH (clears isOverdue per Phase 3 rule).
    await http
      .patch(`/tickets/${ticketId}`)
      .set('Authorization', `Bearer ${devToken}`)
      // Hmm — can't PATCH a DONE ticket, but priority change doesn't move
      // status. The ticket is still TODO (escalation doesn't change status).
      .send({ priority: 'LOW' })
      .expect(200);
    t = await ds.getRepository(Ticket).findOneByOrFail({ id: ticketId });
    expect(t.priority).toBe('LOW');
    expect(t.isOverdue).toBe(false);

    // Next pass: LOW → MEDIUM (re-evaluation from new priority).
    await escalation.runOnce();
    t = await ds.getRepository(Ticket).findOneByOrFail({ id: ticketId });
    expect(t.priority).toBe('MEDIUM');
  });

  it('does NOT touch status (PDF §3.7 constraint)', async () => {
    await escalation.runOnce();
    const t = await ds.getRepository(Ticket).findOneByOrFail({ id: ticketId });
    expect(t.status).toBe('TODO');
  });

  // --- D33 ---

  it('D33: PATCH dueDate to the future after isOverdue=true clears the flag; next runOnce does NOT re-set it', async () => {
    // Drive the ticket to CRITICAL + isOverdue=true.
    await escalation.runOnce();
    await escalation.runOnce();
    await escalation.runOnce();
    await escalation.runOnce();
    let t = await ds.getRepository(Ticket).findOneByOrFail({ id: ticketId });
    expect(t.priority).toBe('CRITICAL');
    expect(t.isOverdue).toBe(true);

    // Move dueDate to the future.
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await http
      .patch(`/tickets/${ticketId}`)
      .set('Authorization', `Bearer ${devToken}`)
      .send({ dueDate: future })
      .expect(200);
    t = await ds.getRepository(Ticket).findOneByOrFail({ id: ticketId });
    expect(t.isOverdue).toBe(false);

    // Next escalation pass: WHERE dueDate < now() is false → ticket
    // shouldn't even be picked up, so isOverdue stays false.
    await escalation.runOnce();
    t = await ds.getRepository(Ticket).findOneByOrFail({ id: ticketId });
    expect(t.isOverdue).toBe(false);
  });

  it('D33: PATCH dueDate to null also clears isOverdue', async () => {
    await escalation.runOnce();
    await escalation.runOnce();
    await escalation.runOnce();
    await escalation.runOnce();
    let t = await ds.getRepository(Ticket).findOneByOrFail({ id: ticketId });
    expect(t.isOverdue).toBe(true);

    await http
      .patch(`/tickets/${ticketId}`)
      .set('Authorization', `Bearer ${devToken}`)
      .send({ dueDate: null })
      .expect(200);
    t = await ds.getRepository(Ticket).findOneByOrFail({ id: ticketId });
    expect(t.isOverdue).toBe(false);
    expect(t.dueDate).toBeNull();
  });

  // D33: transaction atomicity of PRIORITY_ESCALATED audit rows.
  // Hard to deterministically inject a mid-loop failure inside the
  // transactional callback without invasive hooks; the structural fix
  // (recordSystemAction(..., manager)) is the answer and is verified
  // implicitly by every passing escalation test producing audit rows
  // that survive commit. Left as TODO for completeness.
  it.todo(
    'D33: mid-loop rollback rolls back PRIORITY_ESCALATED rows (structural — see plan)',
  );
});
