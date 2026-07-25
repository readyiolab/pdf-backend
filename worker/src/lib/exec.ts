import { execFile } from 'child_process';
import path from 'path';
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
    
    // Treat known soft-failures: tesseract can exit 0 while only writing .txt
    // when the pdf config is missing from tessdata.
    if (typeof stderr === 'string' && /Can't open pdf/i.test(stderr)) {
      throw new Error(
        stderr.trim() ||
          'Tesseract could not open the pdf config. Install tesseract-ocr (system tessdata) or unset TESSDATA_DIR if it points at an incomplete folder.'
      );
    }

    return { stdout, stderr };
  } catch (err: any) {
    logger.error(
      { binaryPath, err: err.message, code: err.code, stderr: err.stderr },
      'Binary execution failed'
    );

    if (err.code === 'ENOENT') {
      const name = path.basename(binaryPath).replace(/\.exe$/i, '');
      throw new Error(
        `${name} was not found (ENOENT). Install it and ensure it is on PATH, ` +
          `or set ${name === 'pdftoppm' ? 'PDFTOPPM_PATH' : name === 'tesseract' ? 'TESSERACT_PATH' : 'the binary path'} ` +
          `in the worker .env. Tried: ${binaryPath}`
      );
    }

    throw new Error(err.stderr?.trim() || err.message || `Execution of ${binaryPath} failed`);
  }
}
