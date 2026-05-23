import {
  IsEmail,
  IsIn,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { IsNonBlankString } from '../../../common/validators/is-non-blank-string.decorator';
import { USER_ROLES, UserRole } from '../user.entity';

export class CreateUserDto {
  @IsString()
  @MinLength(3)
  @MaxLength(64)
  // Allow alphanumeric + underscore so @mention regex /(?<![\w@])@([a-zA-Z0-9_]+)/
  // can match unambiguously. The charset already forbids whitespace.
  @Matches(/^[a-zA-Z0-9_]+$/)
  username: string;

  @IsEmail()
  @MaxLength(256)
  email: string;

  // D20: non-blank identifier field.
  @IsNonBlankString({ min: 1, max: 256 })
  fullName: string;

  @IsIn(USER_ROLES)
  role: UserRole;

  // D5 + D20: password is REQUIRED on POST /users. Min 8, max 72 (bcrypt
  // truncates input at 72 bytes). Non-blank guard rejects 8 spaces.
  @IsNonBlankString({ min: 8, max: 72 })
  password: string;
}
