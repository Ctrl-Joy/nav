// Workspace usage for one month (JSON or CSV). Estimates only: NAV does not bill.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest } from '../../lib/core.ts';
import { currentMonth, monthRange, usageCsv, usageReport } from '../../lib/usage.ts';
import { workspaceRole } from '../auth.ts';

export async function usageRoutes(app: FastifyInstance) {
  app.get('/workspaces/:ws/usage', async (req, reply) => {
    const { ws } = req.params as { ws: string };
    await workspaceRole(req, ws, 'developer');
    const query = z.object({ month: z.string().optional(), format: z.enum(['json', 'csv']).default('json') }).parse(req.query);
    const month = query.month ?? currentMonth();
    if (!monthRange(month)) throw badRequest('month must be YYYY-MM');
    const report = await usageReport(ws, month);
    if (query.format === 'csv') {
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="nav-usage-${month}.csv"`)
        .send(usageCsv(report));
    }
    return report;
  });
}
