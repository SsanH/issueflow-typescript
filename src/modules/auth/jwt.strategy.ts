import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ClsService } from 'nestjs-cls';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User, UserRole } from '../users/user.entity';
import { AuthenticatedUser } from './authenticated-user';
import { RevokedToken } from './revoked-token.entity';

interface JwtPayload {
  sub: number;
  username: string;
  role: UserRole;
  jti: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    @InjectRepository(RevokedToken)
    private readonly revoked: Repository<RevokedToken>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    private readonly cls: ClsService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_SECRET', 'change-me'),
    });
  }

  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    // Denylist check — logout writes jti into RevokedToken.
    const banned = await this.revoked.findOne({ where: { jti: payload.jti } });
    if (banned) throw new UnauthorizedException('Token has been revoked');

    // D21: verify the user still exists. Without this, a hard-deleted user's
    // token stays valid until JWT expiry, and the audit subscriber would
    // attribute writes to a performedBy row that no longer exists.
    const user = await this.users.findOne({ where: { id: payload.sub } });
    if (!user) throw new UnauthorizedException('User no longer exists');

    const authed: AuthenticatedUser = {
      id: user.id,
      // Use the freshest values from the DB, not the JWT payload, so role
      // changes don't require a re-login to take effect on subsequent
      // requests (RolesGuard reads from req.user.role).
      username: user.username,
      role: user.role,
      jti: payload.jti,
    };

    // D6: CLS is populated HERE (not in middleware — middleware runs before
    // guards, so req.user would be undefined at that point). AuditSubscriber
    // reads `cls.get('user')` to resolve the actor for every audit row.
    this.cls.set('user', authed);

    return authed;
  }
}
