import { IsInt, IsOptional, Min } from 'class-validator';
import { IsNonBlankString } from '../../../common/validators/is-non-blank-string.decorator';

export class CreateCommentDto {
  // D20: comment body is the whole point of the resource — non-blank required.
  @IsNonBlankString({ min: 1, max: 4096 })
  content: string;

  // README contract includes authorId in the body. D4: we take authorId from
  // the JWT. If the body supplies a value, it MUST match req.user.id — 400
  // on mismatch. Omitting authorId is allowed (we just use JWT).
  @IsOptional()
  @IsInt()
  @Min(1)
  authorId?: number;
}
