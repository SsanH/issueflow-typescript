import {
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Attachment } from './attachment.entity';
import { AttachmentsService } from './attachments.service';

interface AttachmentResponse {
  id: number;
  ticketId: number;
  filename: string;
  contentType: string;
}

function toResponse(a: Attachment): AttachmentResponse {
  return {
    id: a.id,
    ticketId: a.ticketId,
    filename: a.filename,
    contentType: a.contentType,
  };
}

@Controller('tickets/:ticketId/attachments')
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  // D9: memoryStorage — hold the buffer in RAM, sniff before writing to disk.
  // No partial-file race window. 10 MB cap enforced at Multer level AND in
  // the service (defense in depth).
  @Post()
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 10 * 1024 * 1024 },
    }),
  )
  async upload(
    @Param('ticketId', ParseIntPipe) ticketId: number,
    @UploadedFile() file: Express.Multer.File,
  ): Promise<AttachmentResponse> {
    const saved = await this.attachments.upload(ticketId, file);
    return toResponse(saved);
  }

  @Delete(':attachmentId')
  @HttpCode(HttpStatus.OK)
  async remove(
    @Param('ticketId', ParseIntPipe) ticketId: number,
    @Param('attachmentId', ParseIntPipe) attachmentId: number,
  ): Promise<void> {
    await this.attachments.remove(ticketId, attachmentId);
  }
}
