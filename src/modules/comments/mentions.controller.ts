import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { parsePositiveInt } from '../../common/util/parse-positive-int';
import { MentionsPage, MentionsService } from './mentions.service';

@Controller('users/:userId/mentions')
export class MentionsController {
  constructor(private readonly mentions: MentionsService) {}

  // D35: route through parsePositiveInt so `?page=abc` returns 400, not 500
  // from a NaN propagating into the raw SQL `LIMIT NaN OFFSET NaN`.
  // Same helper used by AuditController (D28 + D35).
  @Get()
  list(
    @Param('userId', ParseIntPipe) userId: number,
    @Query('page') pageRaw?: string,
    @Query('pageSize') pageSizeRaw?: string,
  ): Promise<MentionsPage> {
    return this.mentions.listForUser(
      userId,
      parsePositiveInt(pageRaw, 'page'),
      parsePositiveInt(pageSizeRaw, 'pageSize'),
    );
  }
}
