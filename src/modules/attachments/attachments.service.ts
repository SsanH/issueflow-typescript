import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { fromBuffer } from 'file-type';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { TicketsService } from '../tickets/tickets.service';
import { Attachment } from './attachment.entity';

// D9 + D30: validation pipeline + canonical-extension storage.
const MAX_BYTES = 10 * 1024 * 1024;

// D30: canonical extension per validated MIME. Single source of truth — the
// on-disk filename uses this extension regardless of what the client sent.
const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
};
const ALLOWED_MIME = new Set(Object.keys(MIME_TO_EXT));

// D30: tightened text/plain check. Accept ASCII + UTF-8 only. Reject any
// definitely-binary control character (NUL through ETX, vertical tab, form
// feed, etc.). Allow TAB / LF / CR / printable ASCII (0x20-0x7E) / high-bit
// bytes (0x80-0xFF, which cover UTF-8 multi-byte sequences).
//
// Documented exclusions: UTF-16 (every ASCII char has a 0x00 high byte —
// rejected); files with embedded control bytes like BEL/ESC.
// Residual: a PNG declared text/plain passes this range check (PNG magic
// bytes all fall in the allowed range). Closing that would require
// libmagic — documented production-deferred (D30).
function looksLikePlainTextStrict(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(1024, buf.length));
  for (const b of sample) {
    if (b === 0x09 || b === 0x0a || b === 0x0d) continue; // TAB, LF, CR
    if (b >= 0x20) continue; // printable ASCII + high-bit
    return false; // any other control byte (NUL through 0x1F) → not text
  }
  return true;
}

// Strip path separators and control chars. Keep alphanumerics, dots, dashes,
// underscores, spaces. Truncate to a safe length. The result is what we
// store in the DB `filename` column — purely for display. The on-disk file
// name is unrelated.
function sanitizeFilename(name: string): string {
  return (
    name
      .replace(/[\\/\x00-\x1f]/g, '_')
      .replace(/\.{2,}/g, '.') // collapse "../.." traversal sequences
      .slice(0, 200) || 'unnamed'
  );
}

@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger(AttachmentsService.name);
  private readonly uploadDir: string;

  constructor(
    @InjectRepository(Attachment)
    private readonly attachments: Repository<Attachment>,
    private readonly tickets: TicketsService,
    config: ConfigService,
  ) {
    this.uploadDir = config.get<string>('UPLOAD_DIR', './uploads');
  }

  async upload(
    ticketId: number,
    file: Express.Multer.File,
  ): Promise<Attachment> {
    await this.tickets.findById(ticketId);

    // D30: explicit ordering — empty check first, then size, then MIME,
    // then content sniff, then canonical-extension write.
    if (!file) throw new BadRequestException('file is required');
    if (file.size === 0) {
      throw new BadRequestException('Empty file is not accepted');
    }
    if (file.size > MAX_BYTES) {
      throw new PayloadTooLargeException(
        `File exceeds 10 MB limit (got ${file.size} bytes)`,
      );
    }
    const declaredMime = file.mimetype;
    if (!ALLOWED_MIME.has(declaredMime)) {
      throw new UnsupportedMediaTypeException(
        `MIME type not allowed: ${declaredMime}`,
      );
    }

    // D9 + D30: content sniffing. For text/plain, run the tightened ASCII/
    // UTF-8 range check. For binary MIMEs, use file-type magic-number sniff.
    if (declaredMime === 'text/plain') {
      if (!looksLikePlainTextStrict(file.buffer)) {
        throw new UnsupportedMediaTypeException(
          'File content is not valid ASCII/UTF-8 text/plain (UTF-16 not supported, see D30)',
        );
      }
    } else {
      const detected = await fromBuffer(file.buffer);
      if (!detected || detected.mime !== declaredMime) {
        throw new UnsupportedMediaTypeException(
          `File content does not match declared MIME (declared=${declaredMime}, detected=${detected?.mime ?? 'unknown'})`,
        );
      }
    }

    // D30: on-disk file uses a canonical extension derived from the
    // validated MIME — never the user-supplied extension. The sanitized
    // original name lives in the DB column for display.
    const canonicalExt = MIME_TO_EXT[declaredMime];
    const dir = path.join(this.uploadDir, String(ticketId));
    await fs.mkdir(dir, { recursive: true });
    const safeOriginal = sanitizeFilename(file.originalname);
    const onDiskName = `${uuidv4()}.${canonicalExt}`;
    const storagePath = path.join(dir, onDiskName);
    await fs.writeFile(storagePath, file.buffer);

    const entity = this.attachments.create({
      ticketId,
      filename: safeOriginal,
      contentType: declaredMime,
      sizeBytes: file.size,
      storagePath,
    });
    // D6a: save(entity) so subscriber fires.
    return this.attachments.save(entity);
  }

  async remove(ticketId: number, attachmentId: number): Promise<void> {
    // D31: parent-ticket-visibility gate (also catches soft-deleted project).
    await this.tickets.findById(ticketId);
    const att = await this.attachments.findOne({
      where: { id: attachmentId },
    });
    if (!att) {
      throw new NotFoundException(`Attachment ${attachmentId} not found`);
    }
    if (att.ticketId !== ticketId) {
      throw new NotFoundException(
        `Attachment ${attachmentId} does not belong to ticket ${ticketId}`,
      );
    }
    // D6a: remove(entity) so subscriber fires.
    await this.attachments.remove(att);
    // Best-effort unlink; orphan file is logged, not surfaced.
    try {
      await fs.unlink(att.storagePath);
    } catch (err) {
      this.logger.warn(
        `Failed to unlink ${att.storagePath}: ${(err as Error).message}`,
      );
    }
  }
}
