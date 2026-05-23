import { Type } from 'class-transformer';
import {
  IsDate,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { IsNonBlankString } from '../../../common/validators/is-non-blank-string.decorator';
import {
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  TICKET_TYPES,
  TicketPriority,
  TicketStatus,
  TicketType,
} from '../ticket-enums';

export class CreateTicketDto {
  // D20: identifier — non-blank required.
  @IsNonBlankString({ min: 1, max: 256 })
  title: string;

  // D20: description-ish — empty string allowed (Jira semantics).
  @IsString()
  @MaxLength(4096)
  description: string;

  @IsIn(TICKET_STATUSES)
  status: TicketStatus;

  @IsIn(TICKET_PRIORITIES)
  priority: TicketPriority;

  @IsIn(TICKET_TYPES)
  type: TicketType;

  @IsInt()
  @Min(1)
  projectId: number;

  // D24 tri-state:
  //   undefined (key omitted) → auto-assign (Phase 6e WorkloadQuery)
  //   null (key present, value null) → explicit no-assignee, no auto-assign
  //   number → assign that user (any role; manual assignment isn't DEVELOPER-restricted)
  // @IsOptional() lets both undefined AND null skip the IsInt check.
  @IsOptional()
  @IsInt()
  @Min(1)
  assigneeId?: number | null;

  // ISO-8601 datetime → Date. class-transformer's @Type(() => Date) does the
  // conversion when global ValidationPipe runs with transform: true.
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  dueDate?: Date;
}
