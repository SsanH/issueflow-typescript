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
  TicketPriority,
  TicketStatus,
} from '../ticket-enums';

// README PATCH body: { title?, description?, status?, priority?, assigneeId?, dueDate? }.
// `type` and `projectId` are immutable post-create.
export class UpdateTicketDto {
  // D20: identifier — non-blank when supplied.
  @IsNonBlankString({ min: 1, max: 256, optional: true })
  title?: string;

  // D20: description-ish — may be empty when supplied.
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  description?: string;

  @IsOptional()
  @IsIn(TICKET_STATUSES)
  status?: TicketStatus;

  @IsOptional()
  @IsIn(TICKET_PRIORITIES)
  priority?: TicketPriority;

  // `null` is allowed → unassign.
  @IsOptional()
  @IsInt()
  @Min(1)
  assigneeId?: number | null;

  @IsOptional()
  @IsDate()
  @Type(() => Date)
  dueDate?: Date | null;
}
