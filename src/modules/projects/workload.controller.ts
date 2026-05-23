import { Controller, Get, Param, ParseIntPipe } from '@nestjs/common';
import { ProjectsService } from './projects.service';
import { WorkloadQuery, WorkloadRow } from './workload-query';

@Controller('projects/:projectId/workload')
export class WorkloadController {
  constructor(
    private readonly workload: WorkloadQuery,
    private readonly projects: ProjectsService,
  ) {}

  // D13: any authenticated user (no @Roles guard).
  // D31: verify the project is visible (not soft-deleted) before running
  // the raw workload query — otherwise unknown / soft-deleted projects
  // silently returned `[{ developers with 0 counts }]`.
  @Get()
  async list(
    @Param('projectId', ParseIntPipe) projectId: number,
  ): Promise<WorkloadRow[]> {
    await this.projects.findById(projectId);
    return this.workload.forProject(projectId);
  }
}
