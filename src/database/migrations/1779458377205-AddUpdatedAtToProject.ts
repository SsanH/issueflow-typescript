import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUpdatedAtToProject1779458377205 implements MigrationInterface {
  name = 'AddUpdatedAtToProject1779458377205';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "projects" ADD "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "projects" DROP COLUMN "updated_at"`);
  }
}
