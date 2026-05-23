import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { UsersService } from '../users/users.service';
import { LoginDto } from './dto/login.dto';
import { RevokedToken } from './revoked-token.entity';

export interface LoginResponse {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}

@Injectable()
export class AuthService {
  private readonly expiresInSeconds: number;

  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    @InjectRepository(RevokedToken)
    private readonly revoked: Repository<RevokedToken>,
  ) {
    this.expiresInSeconds = Number(this.config.get('JWT_EXPIRES_IN', 3600));
  }

  async login(dto: LoginDto): Promise<LoginResponse> {
    const user = await this.users.findByUsernameWithPassword(dto.username);
    if (!user) throw new UnauthorizedException('Invalid credentials');

    const ok = await bcrypt.compare(dto.password, user.passwordHash);
    if (!ok) throw new UnauthorizedException('Invalid credentials');

    const jti = uuidv4();
    const accessToken = await this.jwt.signAsync(
      {
        sub: user.id,
        username: user.username,
        role: user.role,
        jti,
      },
      { expiresIn: this.expiresInSeconds },
    );

    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: this.expiresInSeconds,
    };
  }

  async logout(jti: string): Promise<void> {
    const expiresAt = new Date(Date.now() + this.expiresInSeconds * 1000);
    // Idempotent: if same jti hits logout twice, first call wins, second is a no-op.
    // RevokedToken is NOT audited (internal denylist infra).
    // eslint-disable-next-line no-restricted-syntax -- upsert on internal denylist; not audited
    await this.revoked.upsert({ jti, expiresAt }, ['jti']);
  }
}
