import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { UsersService } from '../users/users.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { Project } from './project.entity';

@Injectable()
export class ProjectsService {
  constructor(
    @InjectRepository(Project) private readonly projects: Repository<Project>,
    private readonly users: UsersService,
  ) {}

  findAll(): Promise<Project[]> {
    // @DeleteDateColumn makes find() automatically exclude soft-deleted rows.
    return this.projects.find();
  }

  async findById(id: number): Promise<Project> {
    const project = await this.projects.findOne({ where: { id } });
    if (!project) throw new NotFoundException(`Project ${id} not found`);
    return project;
  }

  async create(dto: CreateProjectDto): Promise<Project> {
    // Verify ownerId exists. UsersService.findById throws 404 if not.
    await this.users.findById(dto.ownerId);
    const entity = this.projects.create({
      name: dto.name,
      description: dto.description,
      ownerId: dto.ownerId,
    });
    // D6a: save(entity) so AuditSubscriber fires (afterInsert → CREATE).
    return this.projects.save(entity);
  }

  async update(id: number, dto: UpdateProjectDto): Promise<Project> {
    const project = await this.findById(id);
    if (dto.name !== undefined) project.name = dto.name;
    if (dto.description !== undefined) project.description = dto.description;
    // D6a + D11a: save(entity); zero-diff updates are filtered by subscriber.
    return this.projects.save(project);
  }

  async softDelete(id: number): Promise<void> {
    const project = await this.findById(id);
    // D6a: softRemove(entity) so AuditSubscriber fires (afterSoftRemove).
    await this.projects.softRemove(project);
  }

  // ADMIN-only per D13.
  listDeleted(): Promise<Project[]> {
    return this.projects.find({
      withDeleted: true,
      where: { deletedAt: Not(IsNull()) },
    });
  }

  // ADMIN-only per D13.
  async restore(id: number): Promise<Project> {
    const project = await this.projects.findOne({
      where: { id },
      withDeleted: true,
    });
    if (!project) throw new NotFoundException(`Project ${id} not found`);
    if (!project.deletedAt) {
      throw new BadRequestException(`Project ${id} is not deleted`);
    }
    // D6a: recover(entity) so AuditSubscriber fires (afterRecover → RESTORE).
    return this.projects.recover(project);
  }
}
