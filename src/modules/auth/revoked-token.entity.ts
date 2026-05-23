import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { TIMESTAMPTZ_COLUMN_OPTS } from '../../database/column-opts';

// JWT logout denylist. The `jti` claim of a logged-out token is stored here
// until expiry, then reaped by DenylistCleanupService (Phase 6f).
// Not audited — RevokedToken is internal infrastructure.
@Entity('revoked_tokens')
export class RevokedToken {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  jti: string;

  @Index()
  @Column({ ...TIMESTAMPTZ_COLUMN_OPTS, name: 'expires_at' })
  expiresAt: Date;
}
