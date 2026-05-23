import { UserRole } from '../users/user.entity';

// What lives on req.user after JwtStrategy.validate succeeds.
// Also what we set into CLS for AuditSubscriber.resolveActor() (D6).
export interface AuthenticatedUser {
  id: number;
  username: string;
  role: UserRole;
  jti: string;
}
