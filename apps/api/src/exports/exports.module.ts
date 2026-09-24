import { Module } from '@nestjs/common';
import { CustomersController } from './customers.controller';
import { ExportsController } from './exports.controller';
import { ExportsService } from './exports.service';

/**
 * Customer list and export tasks.
 *
 * Two controllers, one service: the customer page and the export queue read the
 * same two tables from the same angle, and splitting the service would mean two
 * places deciding what a customer row is.
 *
 * No storage-mode branch. `ExportsService` talks to PostgreSQL through the
 * global `DatabaseService` on purpose — the aggregate over a tenant's
 * conversations and the job queue handed to another process are both facts the
 * in-process fixture store does not have. See the service's header.
 */
@Module({
  controllers: [CustomersController, ExportsController],
  providers: [ExportsService],
})
export class ExportsModule {}
