import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTicketDependencies1779447379897 implements MigrationInterface {
  name = 'AddTicketDependencies1779447379897';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "ticket_dependencies" ("ticket_id" integer NOT NULL, "blocker_id" integer NOT NULL, CONSTRAINT "PK_f35b561505a343467295d5de8e0" PRIMARY KEY ("ticket_id", "blocker_id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "ticket_dependencies" ADD CONSTRAINT "FK_222bed849efafde249116110190" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "ticket_dependencies" ADD CONSTRAINT "FK_a4af8b0b4aa32e5aec0b1a8ad5b" FOREIGN KEY ("blocker_id") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "ticket_dependencies" DROP CONSTRAINT "FK_a4af8b0b4aa32e5aec0b1a8ad5b"`,
    );
    await queryRunner.query(
      `ALTER TABLE "ticket_dependencies" DROP CONSTRAINT "FK_222bed849efafde249116110190"`,
    );
    await queryRunner.query(`DROP TABLE "ticket_dependencies"`);
  }
}
