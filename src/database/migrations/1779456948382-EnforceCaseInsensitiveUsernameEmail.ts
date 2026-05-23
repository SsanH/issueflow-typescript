import { MigrationInterface, QueryRunner } from 'typeorm';

// D21: race-safe case-insensitive uniqueness via expression unique indexes.
//
// Why hand-written: TypeORM 0.3.x's @Index decorator doesn't support
// expression indexes. The application-layer LOWER() check in UsersService.create
// gives a clean 409 message, but two concurrent registrations of `Alice` and
// `alice` could both pass that check; the expression unique index closes the
// race at the DB layer.
//
// The pre-existing raw unique indexes on username/email are kept (they're
// generated from the entity's @Index({ unique: true }) decorators and remain
// in sync with TypeORM metadata). The expression indexes are an additional,
// stricter constraint. Redundant but harmless.
export class EnforceCaseInsensitiveUsernameEmail1779456948382 implements MigrationInterface {
  name = 'EnforceCaseInsensitiveUsernameEmail1779456948382';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE UNIQUE INDEX "users_username_lower_idx" ON "users" (LOWER("username"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "users_email_lower_idx" ON "users" (LOWER("email"))`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "users_email_lower_idx"`);
    await queryRunner.query(`DROP INDEX "users_username_lower_idx"`);
  }
}
