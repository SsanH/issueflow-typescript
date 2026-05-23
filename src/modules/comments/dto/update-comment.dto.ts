import { IsNonBlankString } from '../../../common/validators/is-non-blank-string.decorator';

// README PATCH body: { content }.
export class UpdateCommentDto {
  // D20: non-blank required on update — a whitespace-only edit is nonsense.
  @IsNonBlankString({ min: 1, max: 4096 })
  content: string;
}
