import { Controller, Get, Query } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { parsePositiveInt } from '../../common/util/parse-positive-int';
import { AuditPage, AuditService } from './audit.service';

@Controller('audit-logs')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  // ADMIN only per D13. README is silent on shape; we return a paginated
  // envelope so the endpoint behaves under high audit volume.
  //
  // D28 + D35: explicit numeric validation via parsePositiveInt so
  // `?entityId=abc` returns 400, not 500 from a NaN comparison. The helper
  // lives in common/util so MentionsController uses the same shape.
  @Get()
  @Roles('ADMIN')
  list(
    @Query('entityType') entityType?: string,
    @Query('entityId') entityIdRaw?: string,
    @Query('action') action?: string,
    @Query('actor') actor?: string,
    @Query('page') pageRaw?: string,
    @Query('pageSize') pageSizeRaw?: string,
  ): Promise<AuditPage> {
    return this.audit.list({
      entityType: entityType?.toUpperCase(),
      entityId: parsePositiveInt(entityIdRaw, 'entityId'),
      action: action?.toUpperCase(),
      actor: actor?.toUpperCase(),
      page: parsePositiveInt(pageRaw, 'page'),
      pageSize: parsePositiveInt(pageSizeRaw, 'pageSize'),
    });
  }
}
