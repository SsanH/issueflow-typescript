import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module';
import { RevokedToken } from '../auth/revoked-token.entity';
import { Ticket } from '../tickets/ticket.entity';
import { DenylistCleanupService } from './denylist-cleanup.service';
import { EscalationService } from './escalation.service';

// D8: this module is registered in AppModule for the runtime but should
// not be imported in test modules — the runOnce() methods are called
// directly so test timing stays deterministic.
@Module({
  imports: [
    ScheduleModule.forRoot(),
    TypeOrmModule.forFeature([Ticket, RevokedToken]),
    AuditModule,
  ],
  providers: [EscalationService, DenylistCleanupService],
  exports: [EscalationService, DenylistCleanupService],
})
export class SchedulerModule {}
