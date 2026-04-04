/**
 * VBA Execution Bridge
 *
 * Primary method: Convert VBA to VBScript and run via cscript.exe.
 * VBScript connects to the running SolidWorks instance via GetObject.
 * Fallback: .swb and .swp approaches via RunMacro.
 */

import { SolidWorksAPI } from '../solidworks/api.js';
import { logger } from './logger.js';
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';

/**
 * Extract the Sub/Function procedure name from VBA code.
 */
export function extractProcedureName(vbaCode: string): string {
  const match = vbaCode.match(/(?:Sub|Function)\s+(\w+)\s*\(/m);
  if (!match) {
    throw new Error('Could not find a Sub or Function in the VBA code');
  }
  return match[1];
}

function tempPath(ext: string): string {
  const id = `swmcp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return join(tmpdir(), `${id}.${ext}`);
}

export interface VBAExecutionResult {
  success: boolean;
  method: 'vbs' | 'swb' | 'swp' | 'none';
  procedureName: string;
  error?: string;
  output?: string;
  macroResult?: any;
}

/**
 * Convert VBA code to VBScript that connects to running SolidWorks.
 *
 * Transforms:
 *  - `Dim x As Type` → `Dim x`
 *  - `Application.SldWorks` → `swAppGlobal` (set via GetObject)
 *  - `Debug.Print` → `WScript.Echo`
 *  - Strips `Option Explicit`
 *  - Adds GetObject preamble + calls the entry Sub
 */
function vbaToVBScript(vbaCode: string, procedureName: string): string {
  let vbs = vbaCode;

  // Remove Option Explicit
  vbs = vbs.replace(/^\s*Option\s+Explicit\s*$/gim, '');

  // Strip type declarations: `Dim x As Object` → `Dim x`
  vbs = vbs.replace(/(\bDim\s+\w+)\s+As\s+\w+/gi, '$1');

  // Strip type from function/sub params: `(x As Long)` → `(x)`
  vbs = vbs.replace(/(\(\s*\w+)\s+As\s+\w+/gi, '$1');

  // Replace `Application.SldWorks` with the global variable
  vbs = vbs.replace(/Application\.SldWorks/g, 'swAppGlobal');

  // Replace `Debug.Print` with `WScript.Echo`
  vbs = vbs.replace(/Debug\.Print\s/g, 'WScript.Echo ');

  // Replace CreateObject with GetObject for SolidWorks
  vbs = vbs.replace(/CreateObject\("SldWorks\.Application"\)/g, 'GetObject(, "SldWorks.Application")');

  // Replace Nothing used as function argument with Empty (VBScript-safe)
  // VBScript's Nothing marshals as VT_NULL which causes type mismatch in COM calls
  vbs = vbs.replace(/,\s*Nothing\s*,/g, ', Empty,');
  vbs = vbs.replace(/,\s*Nothing\s*\)/g, ', Empty)');

  // Detect if the code creates sketch entities — if so, inject AddToDB = True
  const needsAddToDB = /SketchManager\.(Create|AddToDB)/i.test(vbs);
  const addToDBBlock = needsAddToDB ? `
Dim swModelGlobal
Set swModelGlobal = swAppGlobal.ActiveDoc
If Not swModelGlobal Is Nothing Then
    swModelGlobal.SketchManager.AddToDB = True
End If
` : '';

  return `On Error Resume Next

Dim swAppGlobal
Set swAppGlobal = GetObject(, "SldWorks.Application")
If swAppGlobal Is Nothing Then
    WScript.Echo "ERROR: Cannot connect to SolidWorks. Is it running?"
    WScript.Quit 1
End If

On Error GoTo 0
${addToDBBlock}
${vbs}
${needsAddToDB ? `
' Reset AddToDB
If Not swModelGlobal Is Nothing Then
    swModelGlobal.SketchManager.AddToDB = False
End If
` : ''}
' Call the entry point
On Error Resume Next
${procedureName}
If Err.Number <> 0 Then
    WScript.Echo "ERROR: VBS runtime error " & Err.Number & ": " & Err.Description
End If
`;
}

/**
 * Execute VBA code in SolidWorks.
 *
 * Method 1 (primary): Convert to VBScript, run via cscript.exe
 * Method 2 (fallback): Write .swb file, run via RunMacro
 * Method 3 (fallback): Record .swp, inject code, run via RunMacro
 */
export function executeVBA(
  swApi: SolidWorksAPI,
  vbaCode: string,
  procedureName?: string
): VBAExecutionResult {
  const procName = procedureName || extractProcedureName(vbaCode);

  // --- Method 1: cscript.exe + VBScript (most reliable) ---
  const vbsPath = tempPath('vbs');
  try {
    const vbsCode = vbaToVBScript(vbaCode, procName);
    writeFileSync(vbsPath, vbsCode, 'utf-8');
    logger.info(`VBA executor: wrote VBScript to ${vbsPath}`);

    const output = execSync(`cscript //NoLogo "${vbsPath}"`, {
      timeout: 30000,
      encoding: 'utf-8',
      windowsHide: true,
    });

    const trimmed = output.trim();
    logger.info(`VBA executor: cscript output: ${trimmed}`);

    // Check for error markers in the output
    if (trimmed.includes('ERROR:')) {
      return {
        success: false,
        method: 'vbs',
        procedureName: procName,
        output: trimmed,
        error: trimmed,
      };
    }

    return {
      success: true,
      method: 'vbs',
      procedureName: procName,
      output: trimmed,
    };
  } catch (vbsError: any) {
    const stderr = vbsError.stderr || '';
    const stdout = vbsError.stdout || '';
    const msg = `cscript failed: ${stderr || stdout || vbsError.message}`;
    logger.warn(`VBA executor: ${msg}`);
  } finally {
    cleanup(vbsPath);
  }

  // --- Method 2: .swb plain text file via RunMacro ---
  const swbPath = tempPath('swb');
  try {
    writeFileSync(swbPath, vbaCode, 'utf-8');
    logger.info(`VBA executor: trying .swb at ${swbPath}`);
    const result = swApi.runMacro(swbPath, 'Module1', procName);
    return {
      success: true,
      method: 'swb',
      procedureName: procName,
      macroResult: result,
    };
  } catch (swbError) {
    logger.warn(`VBA executor: .swb method failed: ${swbError}`);
  } finally {
    cleanup(swbPath);
  }

  // --- Method 3: .swp record/inject via RunMacro ---
  try {
    const app = swApi.getApp();
    if (!app) throw new Error('No SolidWorks connection');

    const swpPath = tempPath('swp');
    app.RecordMacro(swpPath);
    app.StopMacroRecording();

    let injected = false;
    try {
      app.EditMacro(swpPath);
      const vbProject = app.GetRunningMacro();
      if (vbProject) {
        const vbModule = vbProject.VBComponents('Module1');
        if (vbModule && vbModule.CodeModule) {
          const codeModule = vbModule.CodeModule;
          if (codeModule.CountOfLines > 0) {
            codeModule.DeleteLines(1, codeModule.CountOfLines);
          }
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
      throw new Error('VBA code injection into .swp failed');
    }

    const result = swApi.runMacro(swpPath, 'Module1', procName);
    cleanup(swpPath);

    return {
      success: true,
      method: 'swp',
      procedureName: procName,
      macroResult: result,
    };
  } catch (swpError) {
    logger.error(`VBA executor: all methods failed. Last error: ${swpError}`);
    return {
      success: false,
      method: 'none',
      procedureName: procName,
      error: 'All execution methods failed (cscript, .swb, .swp). Ensure SolidWorks is running and macros are enabled.',
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

/**
 * Execute VBA code as a .swb macro inside SolidWorks via RunMacro.
 *
 * Unlike executeVBA/executeRawVBScript (which use cscript.exe), this runs
 * INSIDE the SolidWorks process with full VBA type support:
 * - Transform2 read/write works
 * - GetComponents() SafeArray indexing works
 * - AddMate5 ByRef params work
 * - Set keyword for COM object properties works
 *
 * Since RunMacro doesn't return stdout, the VBA code must write its output
 * to the log file at the path provided by LOG_PATH_PLACEHOLDER in the code.
 * This function replaces LOG_PATH_PLACEHOLDER with an actual temp path,
 * runs the macro, and returns the log file contents.
 *
 * VBA code requirements:
 * - Must have a Sub main() entry point (or specify procedureName)
 * - Must write output to LOG_PATH_PLACEHOLDER:
 *     Dim fNum As Integer: fNum = FreeFile
 *     Open LOG_PATH_PLACEHOLDER For Output As #fNum
 *     Print #fNum, myOutput
 *     Close #fNum
 */
export function runVBAMacro(
  swApi: SolidWorksAPI,
  vbaCode: string,
  procedureName: string = 'main',
  timeoutMs: number = 30000
): { success: boolean; output?: string; error?: string } {
  const id = `swmcp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const swbPath = join(tmpdir(), `${id}.swb`);
  const logPath = join(tmpdir(), `${id}_log.txt`);

  // Replace log path placeholder in VBA code
  const finalCode = vbaCode.replace(/LOG_PATH_PLACEHOLDER/g, logPath.replace(/\\/g, '\\\\'));

  try {
    writeFileSync(swbPath, finalCode, 'utf-8');
    logger.info(`runVBAMacro: wrote .swb to ${swbPath}`);

    swApi.runMacro(swbPath, '', procedureName, []);

    // Read the log file for output
    let output = '';
    try {
      if (existsSync(logPath)) {
        output = readFileSync(logPath, 'utf-8').trim();
      }
    } catch {
      // No log = macro didn't write output
    }

    if (output.startsWith('ERROR:')) {
      return { success: false, output, error: output };
    }

    return { success: true, output };
  } catch (e: any) {
    return { success: false, error: e?.message || String(e) };
  } finally {
    cleanup(swbPath);
    cleanup(logPath);
  }
}

/**
 * Execute raw VBScript code via cscript.exe with SolidWorks GetObject preamble.
 * Unlike executeVBA, this does NOT convert VBA syntax — the code must be valid VBScript.
 */
export function executeRawVBScript(
  code: string,
  timeout: number = 60000
): { success: boolean; output?: string; error?: string } {
  const vbsPath = tempPath('vbs');
  const wrapper = `On Error Resume Next
Dim swApp
Set swApp = GetObject(, "SldWorks.Application")
If swApp Is Nothing Then
    WScript.Echo "ERROR: Cannot connect to SolidWorks"
    WScript.Quit 1
End If
On Error GoTo 0

${code}

If Err.Number <> 0 Then
    WScript.Echo "ERROR: VBS runtime error " & Err.Number & ": " & Err.Description
End If
`;

  try {
    writeFileSync(vbsPath, wrapper, 'utf-8');
    const output = execSync(`cscript //NoLogo "${vbsPath}"`, {
      timeout,
      encoding: 'utf-8',
      windowsHide: true,
    });
    const trimmed = output.trim();

    if (trimmed.includes('ERROR:')) {
      return { success: false, output: trimmed, error: trimmed };
    }
    return { success: true, output: trimmed };
  } catch (e: any) {
    const stderr = e.stderr || '';
    const stdout = e.stdout || '';
    return { success: false, error: stderr || stdout || e.message };
  } finally {
    cleanup(vbsPath);
  }
}
