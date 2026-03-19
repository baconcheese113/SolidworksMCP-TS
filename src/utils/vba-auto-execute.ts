/**
 * Shared helper to wrap VBA tool handlers with autoExecute support.
 * When autoExecute is true, the generated VBA code is executed in SolidWorks
 * instead of being returned as a string.
 */

import { z } from 'zod';
import { executeVBA } from './vba-executor.js';
import { SolidWorksAPI } from '../solidworks/api.js';

/**
 * The autoExecute schema field to add to VBA tool input schemas.
 */
export const autoExecuteField = z.boolean().default(false).describe(
  'When true, execute the VBA code directly in SolidWorks instead of returning it'
);

/**
 * Wraps a VBA generation handler to support autoExecute.
 * The original handler must return a VBA code string.
 */
export function withAutoExecute(
  originalHandler: (args: any, swApi: SolidWorksAPI) => string | Promise<string>
): (args: any, swApi: SolidWorksAPI) => Promise<any> {
  return async (args: any, swApi: SolidWorksAPI) => {
    const vbaCode = await originalHandler(args, swApi);

    if (typeof vbaCode !== 'string') {
      return vbaCode;
    }

    if (!args.autoExecute) {
      return vbaCode;
    }

    const result = await executeVBA(swApi, vbaCode);

    if (result.success) {
      return {
        executed: true,
        method: result.method,
        procedure: result.procedureName,
        macroResult: result.macroResult,
        vbaCode
      };
    } else {
      return {
        executed: false,
        error: result.error,
        vbaCode,
        hint: 'Auto-execution failed. The VBA code is still returned above — you can paste it manually into the SolidWorks macro editor.'
      };
    }
  };
}
