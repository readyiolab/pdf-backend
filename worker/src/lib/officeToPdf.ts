import fs from 'fs';
import path from 'path';
import { executeBinary } from './exec';

/**
 * Converts a local Office file (.docx, etc.) to PDF via LibreOffice headless.
 * Returns the path to the generated PDF in the same temp directory.
 */
export async function convertOfficeFileToPdf(localInputPath: string): Promise<string> {
  const tempDir = path.dirname(localInputPath);
  const inputBasename = path.basename(localInputPath, path.extname(localInputPath));
  const convertedLocalPath = path.join(tempDir, `${inputBasename}.pdf`);

  const loBinary = process.platform === 'win32' ? 'soffice' : 'libreoffice';
  const args = ['--headless', '--convert-to', 'pdf', '--outdir', tempDir, localInputPath];

  try {
    await executeBinary(loBinary, args);
  } catch (loErr: any) {
    if (process.platform === 'win32' && loErr.message.includes('ENOENT')) {
      await executeBinary('libreoffice', args);
    } else {
      throw loErr;
    }
  }

  if (!fs.existsSync(convertedLocalPath) || fs.statSync(convertedLocalPath).size === 0) {
    throw new Error('LibreOffice failed to generate converted PDF');
  }

  return convertedLocalPath;
}
