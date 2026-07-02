import { execFile } from 'child_process';
import { promisify } from 'util';
import { logger } from './logger';

const execFilePromise = promisify(execFile);

export interface ExecuteResult {
  stdout: string;
  stderr: string;
}

/**
 * Safely executes a system binary with arguments.
 * Prevents command injection as it does not spawn a shell.
 */
export async function executeBinary(
  binaryPath: string,
  args: string[],
  options: Record<string, any> = {}
): Promise<ExecuteResult> {
  logger.debug({ binaryPath, args }, 'Executing system binary');
  
  try {
    // Set a default timeout of 60 seconds to prevent processes from hanging forever
    const { stdout, stderr } = await execFilePromise(binaryPath, args, {
      timeout: 60000,
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer
      ...options,
    });
    
    return { stdout, stderr };
  } catch (err: any) {
    logger.error(
      { binaryPath, err: err.message, code: err.code, stderr: err.stderr },
      'Binary execution failed'
    );
    throw new Error(err.stderr?.trim() || err.message || `Execution of ${binaryPath} failed`);
  }
}
