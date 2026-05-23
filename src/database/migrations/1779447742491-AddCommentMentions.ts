import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCommentMentions1779447742491 implements MigrationInterface {
  name = 'AddCommentMentions1779447742491';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "comment_mentions" ("id" SERIAL NOT NULL, "comment_id" integer NOT NULL, "user_id" integer NOT NULL, CONSTRAINT "PK_96cd7c00d35e056fcebb7725e02" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_b8b27863e0146c27bd8c6962e1" ON "comment_mentions" ("comment_id", "user_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "comment_mentions" ADD CONSTRAINT "FK_9ac3fac766fa09176e5c53e4d3f" FOREIGN KEY ("comment_id") REFERENCES "comments"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "comment_mentions" ADD CONSTRAINT "FK_a29d739a2d28fb38b8b591f8152" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "comment_mentions" DROP CONSTRAINT "FK_a29d739a2d28fb38b8b591f8152"`,
    );
    await queryRunner.query(
      `ALTER TABLE "comment_mentions" DROP CONSTRAINT "FK_9ac3fac766fa09176e5c53e4d3f"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_b8b27863e0146c27bd8c6962e1"`,
    );
    await queryRunner.query(`DROP TABLE "comment_mentions"`);
  }
}
