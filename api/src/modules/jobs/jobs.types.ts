import { z } from 'zod';
import { SUPPORTED_TOOLS } from '@shared/constants';

export const createJobSchema = z.object({
  body: z.object({
    tool: z.enum(SUPPORTED_TOOLS as [string, ...string[]], {
      errorMap: () => ({ message: `Invalid tool name. Must be one of: ${SUPPORTED_TOOLS.join(', ')}` }),
    }),
    inputFiles: z.array(z.string().min(1, 'File key cannot be empty')).min(1, 'At least one input file is required'),
    options: z.record(z.any()).default({}),
  }),
});

export type CreateJobInput = z.infer<typeof createJobSchema>['body'];
