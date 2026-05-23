import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { Project } from './project.entity';
import { ProjectsService } from './projects.service';

@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  // ADMIN-only routes MUST come before the catch-all /:projectId route or
  // Nest matches `/deleted` to the `:projectId` param and tries to parse it
  // as an int → 400.
  @Get('deleted')
  @Roles('ADMIN')
  listDeleted(): Promise<Project[]> {
    return this.projects.listDeleted();
  }

  // D31: README contract shows empty response body for restore. Mirror the
  // soft-delete pattern: await the service, return void. Body stays empty.
  @Post(':projectId/restore')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.OK)
  async restore(
    @Param('projectId', ParseIntPipe) projectId: number,
  ): Promise<void> {
    await this.projects.restore(projectId);
  }

  @Get()
  findAll(): Promise<Project[]> {
    return this.projects.findAll();
  }

  @Get(':projectId')
  findOne(
    @Param('projectId', ParseIntPipe) projectId: number,
  ): Promise<Project> {
    return this.projects.findById(projectId);
  }

  // README contract uses 200 OK for create (matches POST /users pattern).
  @Post()
  @HttpCode(HttpStatus.OK)
  create(@Body() dto: CreateProjectDto): Promise<Project> {
    return this.projects.create(dto);
  }

  @Patch(':projectId')
  @HttpCode(HttpStatus.OK)
  async update(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Body() dto: UpdateProjectDto,
  ): Promise<void> {
    // eslint-disable-next-line no-restricted-syntax -- service.update wraps repo.save(entity); subscriber fires
    await this.projects.update(projectId, dto);
  }

  // Soft-delete per PDF §3.5.
  @Delete(':projectId')
  @HttpCode(HttpStatus.OK)
  async remove(
    @Param('projectId', ParseIntPipe) projectId: number,
  ): Promise<void> {
    // eslint-disable-next-line no-restricted-syntax -- ProjectsService.softDelete wraps repo.softRemove(entity); subscriber fires
    await this.projects.softDelete(projectId);
  }
}
