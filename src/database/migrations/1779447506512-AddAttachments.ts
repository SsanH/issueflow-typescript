import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAttachments1779447506512 implements MigrationInterface {
  name = 'AddAttachments1779447506512';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "attachments" ("id" SERIAL NOT NULL, "ticket_id" integer NOT NULL, "filename" character varying(256) NOT NULL, "content_type" character varying(64) NOT NULL, "size_bytes" integer NOT NULL, "storage_path" character varying(512) NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_5e1f050bcff31e3084a1d662412" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_73d871f247ffebda5dc3f0df8a" ON "attachments" ("ticket_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "attachments" ADD CONSTRAINT "FK_73d871f247ffebda5dc3f0df8a4" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "attachments" DROP CONSTRAINT "FK_73d871f247ffebda5dc3f0df8a4"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_73d871f247ffebda5dc3f0df8a"`,
    );
    await queryRunner.query(`DROP TABLE "attachments"`);
  }
}
