import type { IDatabaseProvider } from '../../interfaces/database-provider.interface.js';
import { query, transaction } from '../../../db/postgres.js';

export class PostgresDatabaseProvider implements IDatabaseProvider {
  query = query;
  transaction = transaction;
}

export const postgresDatabaseProvider = new PostgresDatabaseProvider();
