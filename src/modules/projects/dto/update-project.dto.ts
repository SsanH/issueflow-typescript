import { IsOptional, IsString, MaxLength } from 'class-validator';
import { IsNonBlankString } from '../../../common/validators/is-non-blank-string.decorator';

// README contract: PATCH /projects/:projectId accepts { name?, description? }.
// ownerId is set at creation and not modifiable here.
export class UpdateProjectDto {
  // D20: identifier — non-blank when supplied.
  @IsNonBlankString({ min: 1, max: 256, optional: true })
  name?: string;

  // D20: description — may be empty string when supplied.
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  description?: string;
}
