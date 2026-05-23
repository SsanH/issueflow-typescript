import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../src/database/data-source';

// D8: every e2e run gets a fresh Postgres in a real container. globalSetup
// boots it once, runs migrations, leaves the connection details on
// process.env for the test workers to pick up via ConfigModule.
module.exports = async function globalSetup(): Promise<void> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    'postgres:16-alpine',
  )
    .withDatabase('issueflow_test')
    .withUsername('issueflow')
    .withPassword('issueflow')
    .start();

  process.env.DB_HOST = container.getHost();
  process.env.DB_PORT = String(container.getMappedPort(5432));
  process.env.DB_USERNAME = container.getUsername();
  process.env.DB_PASSWORD = container.getPassword();
  process.env.DB_DATABASE = container.getDatabase();
  process.env.JWT_SECRET = 'e2e-test-secret-very-long-please';
  process.env.JWT_EXPIRES_IN = '3600';
  // D27: explicit even though Jest sets it by default — makes the
  // schedulers' env-gate contract visible at the test entry point.
  process.env.NODE_ENV = 'test';

  // Run migrations against the fresh container.
  const ds = new DataSource({
    ...dataSourceOptions,
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    username: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
  });
  await ds.initialize();
  await ds.runMigrations();
  await ds.destroy();

  // Force-release locks held by abandoned transactions after 30s. Without
  // this, a pessimistic SELECT FOR UPDATE in a spec that times out keeps
  // its row locked indefinitely, and the next spec's lock attempt on the
  // same row hangs forever. ALTER DATABASE must run from a connection
  // that's NOT connected to the target database, so use the admin db.
  const adminDs = new DataSource({
    ...dataSourceOptions,
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    username: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: 'postgres',
  });
  await adminDs.initialize();
  await adminDs.query(
    `ALTER DATABASE "${process.env.DB_DATABASE}" SET idle_in_transaction_session_timeout = '30s'`,
  );
  await adminDs.destroy();

  // Stash the container handle so teardown can stop it.
  (globalThis as Record<string, unknown>).__PG_CONTAINER__ = container;
};
