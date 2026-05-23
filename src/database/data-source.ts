import 'reflect-metadata';
import { config as dotenvConfig } from 'dotenv';
import { DataSource } from 'typeorm';
import { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';
import { AuditSubscriber } from './subscribers/audit.subscriber';

// Load .env so the TypeORM CLI (migration:generate/run/revert) sees the same
// values the app sees. Nest's ConfigModule handles this at runtime; the CLI
// runs outside Nest, so we load explicitly here.
dotenvConfig();

export const dataSourceOptions: PostgresConnectionOptions = {
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USERNAME ?? 'issueflow',
  password: process.env.DB_PASSWORD ?? 'issueflow',
  database: process.env.DB_DATABASE ?? 'issueflow',
  // D7: schema is managed by migrations only.
  synchronize: false,
  // Glob picks up entities in both ts-node (dev/CLI) and compiled js (prod) runs.
  entities: [__dirname + '/../**/*.entity{.ts,.js}'],
  migrations: [__dirname + '/migrations/*{.ts,.js}'],
  subscribers: [AuditSubscriber],
};

// Used by typeorm-ts-node-commonjs for migration:generate / migration:run.
export default new DataSource(dataSourceOptions);
