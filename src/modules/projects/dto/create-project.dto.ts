import { IsInt, IsString, MaxLength, Min } from 'class-validator';
import { IsNonBlankString } from '../../../common/validators/is-non-blank-string.decorator';

export class CreateProjectDto {
  // D20: identifier — non-blank required.
  @IsNonBlankString({ min: 1, max: 256 })
  name: string;

  // D20: description-ish — empty string allowed (Jira semantics).
  @IsString()
  @MaxLength(4096)
  description: string;

  @IsInt()
  @Min(1)
  ownerId: number;
}
