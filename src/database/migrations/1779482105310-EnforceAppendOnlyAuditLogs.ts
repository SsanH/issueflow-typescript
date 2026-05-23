import { MigrationInterface, QueryRunner } from 'typeorm';

// D28: PDF §3.1 demands the audit log be "persistent, append-only." The
// application layer honors this (no service ever UPDATEs or DELETEs an
// audit_logs row), but the app's DB role has full DML privileges, so a
// bug or SQL injection could still mutate the log. This migration adds
// DB-level enforcement: a BEFORE UPDATE OR DELETE trigger that raises an
// exception. INSERT remains permitted (that's how the subscriber writes
// rows in the first place).
export class EnforceAppendOnlyAuditLogs1779482105310 implements MigrationInterface {
  name = 'EnforceAppendOnlyAuditLogs1779482105310';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION audit_logs_append_only()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'audit_logs is append-only (D28); % is not permitted', TG_OP
          USING ERRCODE = 'restrict_violation';
      END;
      $$ LANGUAGE plpgsql;
    `);
    await queryRunner.query(`
      CREATE TRIGGER audit_logs_no_update_or_delete
      BEFORE UPDATE OR DELETE ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only();
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS audit_logs_no_update_or_delete ON audit_logs`,
    );
    await queryRunner.query(`DROP FUNCTION IF EXISTS audit_logs_append_only()`);
  }
}
