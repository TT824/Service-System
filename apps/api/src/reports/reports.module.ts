import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

/**
 * Reports module.
 *
 * Provides aggregate tenant summaries, retention counts and the audit trail used
 * by the dashboard and compliance views.
 */
@Module({
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
