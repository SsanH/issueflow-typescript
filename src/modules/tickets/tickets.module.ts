import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module';
import { ProjectsModule } from '../projects/projects.module';
import { UsersModule } from '../users/users.module';
import { CsvService } from './csv.service';
import { DependenciesController } from './dependencies.controller';
import { DependenciesService } from './dependencies.service';
import { TicketDependency } from './ticket-dependency.entity';
import { Ticket } from './ticket.entity';
import { TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Ticket, TicketDependency]),
    ProjectsModule,
    UsersModule,
    AuditModule,
  ],
  controllers: [TicketsController, DependenciesController],
  providers: [TicketsService, DependenciesService, CsvService],
  exports: [TicketsService, DependenciesService],
})
export class TicketsModule {}
