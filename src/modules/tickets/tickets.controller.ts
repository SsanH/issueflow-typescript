import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Response } from 'express';
import { Roles } from '../../common/decorators/roles.decorator';
import { CsvService, ImportResult } from './csv.service';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { UpdateTicketDto } from './dto/update-ticket.dto';
import { Ticket } from './ticket.entity';
import { TicketsService } from './tickets.service';

@Controller('tickets')
export class TicketsController {
  constructor(
    private readonly tickets: TicketsService,
    private readonly csv: CsvService,
  ) {}

  // Literal-path routes MUST come before parametric ones so Nest does not
  // try to parse "deleted" as a :ticketId.
  @Get('deleted')
  @Roles('ADMIN')
  listDeleted(
    @Query('projectId', ParseIntPipe) projectId: number,
  ): Promise<Ticket[]> {
    return this.tickets.listDeleted(projectId);
  }

  @Get('export')
  @Header('Content-Type', 'text/csv')
  async export(
    @Query('projectId', ParseIntPipe) projectId: number,
    @Res() res: Response,
  ): Promise<void> {
    const csv = await this.csv.export(projectId);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="tickets-${projectId}.csv"`,
    );
    res.send(csv);
  }

  // G2: projectId comes from the multipart form field, not from the CSV.
  @Post('import')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 10 * 1024 * 1024 },
    }),
  )
  importCsv(
    @UploadedFile() file: Express.Multer.File,
    @Body('projectId') projectId?: string,
  ): Promise<ImportResult> {
    if (!file) {
      throw new BadRequestException('file is required');
    }
    if (!projectId) {
      throw new BadRequestException('projectId form field is required');
    }
    const id = Number(projectId);
    if (!Number.isInteger(id) || id < 1) {
      throw new BadRequestException('projectId must be a positive integer');
    }
    return this.csv.import(id, file.buffer);
  }

  // D31: README contract shows empty response body for restore. Mirror the
  // soft-delete pattern: await the service, return void. Body stays empty.
  @Post(':ticketId/restore')
  @Roles('ADMIN')
  @HttpCode(HttpStatus.OK)
  async restore(
    @Param('ticketId', ParseIntPipe) ticketId: number,
  ): Promise<void> {
    await this.tickets.restore(ticketId);
  }

  @Get()
  findByProject(@Query('projectId') projectId?: string): Promise<Ticket[]> {
    if (!projectId) {
      throw new BadRequestException('projectId query param is required');
    }
    const id = Number(projectId);
    if (!Number.isInteger(id) || id < 1) {
      throw new BadRequestException('projectId must be a positive integer');
    }
    return this.tickets.findByProject(id);
  }

  @Get(':ticketId')
  findOne(@Param('ticketId', ParseIntPipe) ticketId: number): Promise<Ticket> {
    return this.tickets.findById(ticketId);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  create(@Body() dto: CreateTicketDto): Promise<Ticket> {
    return this.tickets.create(dto);
  }

  @Patch(':ticketId')
  @HttpCode(HttpStatus.OK)
  async update(
    @Param('ticketId', ParseIntPipe) ticketId: number,
    @Body() dto: UpdateTicketDto,
  ): Promise<void> {
    // eslint-disable-next-line no-restricted-syntax -- service.update wraps repo.save(entity) inside a transaction; subscriber fires
    await this.tickets.update(ticketId, dto);
  }

  // PDF §3.5: soft-delete only.
  @Delete(':ticketId')
  @HttpCode(HttpStatus.OK)
  async remove(
    @Param('ticketId', ParseIntPipe) ticketId: number,
  ): Promise<void> {
    // eslint-disable-next-line no-restricted-syntax -- service.softDelete wraps repo.softRemove(entity); subscriber fires
    await this.tickets.softDelete(ticketId);
  }
}
