import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTickets1779446588102 implements MigrationInterface {
  name = 'AddTickets1779446588102';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "tickets" ("id" SERIAL NOT NULL, "title" character varying(256) NOT NULL, "description" text NOT NULL, "status" character varying(16) NOT NULL, "priority" character varying(16) NOT NULL, "type" character varying(16) NOT NULL, "project_id" integer NOT NULL, "assignee_id" integer, "due_date" TIMESTAMP WITH TIME ZONE, "is_overdue" boolean NOT NULL DEFAULT false, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_343bc942ae261cf7a1377f48fd0" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_ad2a415688c613c9897f7975ef" ON "tickets" ("project_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_dff6e2b44c9b5e177114588772" ON "tickets" ("assignee_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "tickets" ADD CONSTRAINT "FK_ad2a415688c613c9897f7975efd" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "tickets" ADD CONSTRAINT "FK_dff6e2b44c9b5e177114588772f" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "tickets" DROP CONSTRAINT "FK_dff6e2b44c9b5e177114588772f"`,
    );
    await queryRunner.query(
      `ALTER TABLE "tickets" DROP CONSTRAINT "FK_ad2a415688c613c9897f7975efd"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_dff6e2b44c9b5e177114588772"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_ad2a415688c613c9897f7975ef"`,
    );
    await queryRunner.query(`DROP TABLE "tickets"`);
  }
}
