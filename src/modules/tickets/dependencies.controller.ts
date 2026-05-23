import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';
import { DependenciesService, DependencyView } from './dependencies.service';
import { AddDependencyDto } from './dto/add-dependency.dto';

@Controller('tickets/:ticketId/dependencies')
export class DependenciesController {
  constructor(private readonly deps: DependenciesService) {}

  @Get()
  list(
    @Param('ticketId', ParseIntPipe) ticketId: number,
  ): Promise<DependencyView[]> {
    return this.deps.list(ticketId);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  async add(
    @Param('ticketId', ParseIntPipe) ticketId: number,
    @Body() dto: AddDependencyDto,
  ): Promise<void> {
    await this.deps.add(ticketId, dto.blockedBy);
  }

  @Delete(':blockerId')
  @HttpCode(HttpStatus.OK)
  async remove(
    @Param('ticketId', ParseIntPipe) ticketId: number,
    @Param('blockerId', ParseIntPipe) blockerId: number,
  ): Promise<void> {
    await this.deps.remove(ticketId, blockerId);
  }
}
