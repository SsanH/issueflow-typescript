import { IsNonBlankString } from '../../../common/validators/is-non-blank-string.decorator';

export class LoginDto {
  // D20: both username and password are identifier-ish — non-blank required.
  // Note: login.password uses min 1 (we accept whatever the user actually has);
  // CreateUserDto.password enforces the 8-char minimum policy at registration.
  @IsNonBlankString({ min: 1, max: 64 })
  username: string;

  @IsNonBlankString({ min: 1, max: 72 })
  password: string;
}
