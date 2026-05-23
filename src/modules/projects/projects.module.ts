import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Ticket } from '../tickets/ticket.entity';
import { User } from '../users/user.entity';
import { UsersModule } from '../users/users.module';
import { Project } from './project.entity';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { WorkloadController } from './workload.controller';
import { WorkloadQuery } from './workload-query';

@Module({
  imports: [TypeOrmModule.forFeature([Project, User, Ticket]), UsersModule],
  controllers: [ProjectsController, WorkloadController],
  providers: [ProjectsService, WorkloadQuery],
  exports: [ProjectsService, WorkloadQuery],
})
export class ProjectsModule {}
