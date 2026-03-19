/**
 * VBA Auto-Execute Bridge
 *
 * Writes VBA code to a temporary .swb file and executes it via RunMacro2().
 * Falls back to the .swp record/edit/inject pattern if .swb doesn't work.
 */

import { SolidWorksAPI } from '../solidworks/api.js';
import { logger } from './logger.js';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Extract the Sub/Function procedure name from VBA code.
 * Looks for the first `Sub <name>()` or `Function <name>(` line.
 */
export function extractProcedureName(vbaCode: string): string {
  const match = vbaCode.match(/(?:Sub|Function)\s+(\w+)\s*\(/m);
  if (!match) {
    throw new Error('Could not find a Sub or Function in the VBA code');
  }
  return match[1];
}

/**
 * Generate a temp file path with a unique name.
 */
function tempMacroPath(ext: string): string {
  const id = `swmcp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return join(tmpdir(), `${id}.${ext}`);
}

export interface VBAExecutionResult {
  success: boolean;
  method: 'swb' | 'swp' | 'none';
  procedureName: string;
  error?: string;
  macroResult?: any;
}

/**
 * Write VBA code to a temp .swb file and execute it in SolidWorks via RunMacro2.
 *
 * .swb files are plain-text BASIC files that SolidWorks can run directly.
 * If that fails, falls back to the .swp approach.
 */
export function executeVBA(
  swApi: SolidWorksAPI,
  vbaCode: string,
  procedureName?: string
): VBAExecutionResult {
  const procName = procedureName || extractProcedureName(vbaCode);

  // --- Method 1: .swb plain text file ---
  const swbPath = tempMacroPath('swb');
  try {
    writeFileSync(swbPath, vbaCode, 'utf-8');
    logger.info(`VBA executor: wrote .swb to ${swbPath}`);

    const result = swApi.runMacro(swbPath, 'Module1', procName);

    return {
      success: true,
      method: 'swb',
      procedureName: procName,
      macroResult: result
    };
  } catch (swbError) {
    logger.warn(`VBA executor: .swb method failed: ${swbError}`);
  } finally {
    cleanup(swbPath);
  }

  // --- Method 2: Try with empty module name (some SW versions) ---
  const swbPath2 = tempMacroPath('swb');
  try {
    writeFileSync(swbPath2, vbaCode, 'utf-8');

    const result = swApi.runMacro(swbPath2, '', procName);

    return {
      success: true,
      method: 'swb',
      procedureName: procName,
      macroResult: result
    };
  } catch (swbError2) {
    logger.warn(`VBA executor: .swb method (empty module) failed: ${swbError2}`);
  } finally {
    cleanup(swbPath2);
  }

  // --- Method 3: .swp via record/inject pattern ---
  try {
    const app = swApi.getApp();
    if (!app) throw new Error('No SolidWorks connection');

    const swpPath = tempMacroPath('swp');

    // Record a minimal macro to create the .swp container
    app.RecordMacro(swpPath);
    app.StopMacroRecording();

    // Now edit and inject our code
    let injected = false;
    try {
      // Open the macro editor
      app.EditMacro(swpPath);

      // Get the VBA project and replace module code
      // This uses the SolidWorks VBA IDE COM interface
      const vbProject = app.GetRunningMacro();
      if (vbProject) {
        const vbModule = vbProject.VBComponents('Module1');
        if (vbModule && vbModule.CodeModule) {
          const codeModule = vbModule.CodeModule;
          // Clear existing code
          if (codeModule.CountOfLines > 0) {
            codeModule.DeleteLines(1, codeModule.CountOfLines);
          }
          // Insert our code
          codeModule.AddFromString(vbaCode);
          injected = true;
        }
        vbProject.Save();
      }
    } catch (editError) {
      logger.warn(`VBA executor: macro edit/inject failed: ${editError}`);
    }

    if (!injected) {
      cleanup(swpPath);
      throw new Error('VBA code injection into .swp failed — cannot run empty macro');
    }

    const result = swApi.runMacro(swpPath, 'Module1', procName);

    cleanup(swpPath);

    return {
      success: true,
      method: 'swp',
      procedureName: procName,
      macroResult: result
    };
  } catch (swpError) {
    logger.error(`VBA executor: all methods failed. Last error: ${swpError}`);

    return {
      success: false,
      method: 'none',
      procedureName: procName,
      error: `All execution methods failed. .swb and .swp approaches both failed. Ensure SolidWorks is running and macros are enabled.`
    };
  }
}

function cleanup(filePath: string): void {
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  } catch {
    // Best-effort cleanup
  }
}
