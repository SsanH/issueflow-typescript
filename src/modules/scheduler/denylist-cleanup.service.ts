import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { CronJob } from 'cron';
import { LessThan, Repository } from 'typeorm';
import { RevokedToken } from '../auth/revoked-token.entity';

// Hourly purge of expired denylist rows so the table stays bounded.
@Injectable()
export class DenylistCleanupService implements OnModuleInit {
  private readonly logger = new Logger(DenylistCleanupService.name);

  constructor(
    private readonly scheduler: SchedulerRegistry,
    @InjectRepository(RevokedToken)
    private readonly revoked: Repository<RevokedToken>,
  ) {}

  onModuleInit(): void {
    // D27: in NODE_ENV=test, skip cron registration to avoid leaking
    // node-cron timers across spec teardowns. The service stays
    // injectable; tests that need cleanup behavior call runOnce() directly.
    if (process.env.NODE_ENV === 'test') {
      this.logger.log('Denylist cleanup cron skipped (NODE_ENV=test, D27)');
      return;
    }
    // Every hour at minute 0.
    const job = new CronJob('0 * * * *', () => {
      this.runOnce().catch((err: Error) => {
        this.logger.error(`Denylist cleanup failed: ${err.message}`);
      });
    });
    this.scheduler.addCronJob('denylist-cleanup', job);
    job.start();
  }

  async runOnce(): Promise<number> {
    // RevokedToken is internal infra, not audited.
    // eslint-disable-next-line no-restricted-syntax -- RevokedToken is not audited
    const result = await this.revoked.delete({
      expiresAt: LessThan(new Date()),
    });
    return result.affected ?? 0;
  }
}
