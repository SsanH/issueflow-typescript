import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddComments1779446942298 implements MigrationInterface {
  name = 'AddComments1779446942298';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "comments" ("id" SERIAL NOT NULL, "ticket_id" integer NOT NULL, "author_id" integer NOT NULL, "content" text NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_8bf68bc960f2b69e818bdb90dcb" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_be8180d9b44a05e449b85f5b77" ON "comments" ("ticket_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_e6d38899c31997c45d128a8973" ON "comments" ("author_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "comments" ADD CONSTRAINT "FK_be8180d9b44a05e449b85f5b773" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "comments" ADD CONSTRAINT "FK_e6d38899c31997c45d128a8973b" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "comments" DROP CONSTRAINT "FK_e6d38899c31997c45d128a8973b"`,
    );
    await queryRunner.query(
      `ALTER TABLE "comments" DROP CONSTRAINT "FK_be8180d9b44a05e449b85f5b773"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_e6d38899c31997c45d128a8973"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_be8180d9b44a05e449b85f5b77"`,
    );
    await queryRunner.query(`DROP TABLE "comments"`);
  }
}
