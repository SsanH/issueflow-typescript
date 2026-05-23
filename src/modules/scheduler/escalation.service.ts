import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { CronJob } from 'cron';
import { ClsService } from 'nestjs-cls';
import { DataSource, IsNull, LessThan, Not, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import {
  PRIORITY_ORDER,
  TICKET_PRIORITIES,
  TicketPriority,
} from '../tickets/ticket-enums';
import { Ticket } from '../tickets/ticket.entity';

// Advisory lock key. Two app instances acquiring the same advisory key
// inside concurrent transactions will serialize — preventing duplicate
// escalations / duplicate audit rows.
const ADVISORY_LOCK_KEY = 0x1cebf101;
const DEFAULT_CRON = '*/5 * * * *'; // every 5 minutes

@Injectable()
export class EscalationService implements OnModuleInit {
  private readonly logger = new Logger(EscalationService.name);

  constructor(
    private readonly scheduler: SchedulerRegistry,
    private readonly config: ConfigService,
    private readonly cls: ClsService,
    private readonly audit: AuditService,
    @InjectRepository(Ticket) private readonly tickets: Repository<Ticket>,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  // D19: register the cron job at runtime, not via @Cron decorator. The
  // decorator argument is evaluated at module-parse time — before
  // ConfigModule populates process.env — so reading from env at decorator
  // time silently always uses the default. Runtime registration via
  // SchedulerRegistry reads ConfigService correctly.
  //
  // D27: in NODE_ENV=test, skip registration entirely. The service stays
  // injectable so escalation.e2e can call runOnce() directly per D8; we
  // just don't let node-cron timers leak past app.close() between spec
  // files (the cause of cross-suite e2e flakes).
  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') {
      this.logger.log('Escalation cron skipped (NODE_ENV=test, D27)');
      return;
    }
    const expr = this.config.get<string>('ESCALATION_CRON') || DEFAULT_CRON;
    const job = new CronJob(expr, () => {
      this.runOnce().catch((err: Error) => {
        this.logger.error(`Escalation pass failed: ${err.message}`, err.stack);
      });
    });
    this.scheduler.addCronJob('escalation', job);
    job.start();
    this.logger.log(`Escalation cron registered: ${expr}`);
  }

  // Exposed publicly so e2e tests can drive escalation deterministically
  // without depending on cron timing.
  async runOnce(): Promise<void> {
    await this.cls.run(async () => {
      this.cls.set('user', { role: 'SYSTEM' });
      await this.dataSource.transaction(async (manager) => {
        // Cross-instance serialization. Returns immediately if lock free;
        // blocks the second caller until this txn commits.
        await manager.query('SELECT pg_advisory_xact_lock($1)', [
          ADVISORY_LOCK_KEY,
        ]);

        // PDF §3.7: only tickets with dueDate set AND now > dueDate AND
        // not DONE. (Deleted rows excluded automatically by @DeleteDateColumn.)
        //
        // D33: pessimistic_write lock on the matched set so a concurrent
        // PATCH /tickets/:id can't race us into a lost update. The user's
        // PATCH waits for our commit (or we wait for theirs); either way,
        // escalation reads a fresh snapshot of each ticket and writes
        // atomically. SKIP LOCKED would be cleaner (non-blocking, skip and
        // pick up next pass) but requires raw SQL; the brief blocking
        // window of a 5-min cron is acceptable — documented production-
        // deferred.
        const overdue = await manager.find(Ticket, {
          where: {
            dueDate: LessThan(new Date()),
            status: Not(IsNull()), // any status, but we filter DONE below
          },
          lock: { mode: 'pessimistic_write' },
        });

        for (const t of overdue) {
          if (t.status === 'DONE') continue;
          if (t.dueDate === null) continue; // defensive

          const before: TicketPriority = t.priority;
          let promoted = false;
          if (PRIORITY_ORDER[t.priority] < PRIORITY_ORDER.CRITICAL) {
            const nextIdx = PRIORITY_ORDER[t.priority] + 1;
            t.priority = TICKET_PRIORITIES[nextIdx];
            promoted = true;
          } else if (!t.isOverdue) {
            // Already CRITICAL and still overdue → set is_overdue.
            t.isOverdue = true;
            promoted = true;
          }

          if (promoted) {
            // D6a: save(entity) so subscriber writes an UPDATE row too.
            await manager.save(t);
            // D33: pass `manager` so the PRIORITY_ESCALATED row is written
            // through the same transaction. If a later iteration throws
            // and the transaction rolls back, the audit row rolls back
            // with the ticket UPDATE — no orphan rows in audit_logs.
            await this.audit.recordSystemAction(
              'PRIORITY_ESCALATED',
              'Ticket',
              t.id,
              {
                from: before,
                to: t.priority,
                isOverdue: t.isOverdue,
              },
              manager,
            );
          }
        }
      });
    });
  }
}
