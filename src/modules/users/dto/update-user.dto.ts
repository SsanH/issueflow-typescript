import { IsIn, IsOptional } from 'class-validator';
import { IsNonBlankString } from '../../../common/validators/is-non-blank-string.decorator';
import { USER_ROLES, UserRole } from '../user.entity';

// Contract (README line 64): POST /users/update/:userId with body
// { fullName, role }. Username and email are not updatable.
export class UpdateUserDto {
  // D20: non-blank when supplied; PATCH may omit it.
  @IsNonBlankString({ min: 1, max: 256, optional: true })
  fullName?: string;

  @IsOptional()
  @IsIn(USER_ROLES)
  role?: UserRole;
}
