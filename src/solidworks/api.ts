import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import { executeVBA, runVBAMacro } from '../utils/vba-executor.js';
import type { SolidWorksFeature, SolidWorksModel } from './types.js';

// Conditionally load winax (Windows-only COM bridge)
let winax: any = null;
try {
  // @ts-ignore
  winax = (await import('winax')).default;
} catch {
  logger.warn('winax not available - SolidWorks COM operations will not work (expected on non-Windows platforms)');
}

export class SolidWorksAPI {
  private swApp: any;
  private currentModel: any;

  constructor() {
    this.swApp = null;
    this.currentModel = null;
  }

  connect(): void {
    try {
      // Create or get running instance of SolidWorks
      // @ts-ignore
      this.swApp = new winax.Object('SldWorks.Application');
      this.swApp.Visible = true;
      logger.info('Connected to SolidWorks');
    } catch (_error) {
      // Try alternative connection method
      try {
        // @ts-ignore
        this.swApp = winax.Object('SldWorks.Application');
        this.swApp.Visible = true;
        logger.info('Connected to SolidWorks (alternative method)');
      } catch (error2) {
        logger.error('Failed to connect to SolidWorks', error2);
        throw new Error(`Failed to connect to SolidWorks: ${error2}`);
      }
    }
  }

  disconnect(): void {
    if (this.currentModel) {
      this.currentModel = null;
    }
    if (this.swApp) {
      // Don't close SolidWorks, just disconnect
      this.swApp = null;
    }
  }

  isConnected(): boolean {
    return this.swApp !== null;
  }

  // Model operations
  openModel(filePath: string): SolidWorksModel {
    if (!this.swApp) throw new Error('Not connected to SolidWorks');

    // Determine file type from extension
    const ext = filePath.toLowerCase().split('.').pop();
    let docType = 1; // swDocPART (also works for STEP/IGES/Parasolid imports)
    if (ext === 'sldasm') docType = 2; // swDocASSEMBLY
    if (ext === 'slddrw') docType = 3; // swDocDRAWING
    // STEP, IGES, Parasolid, SAT all import as parts (docType=1) via OpenDoc6

    // OpenDoc6 has ByRef Long params (errors, warnings) that cause type mismatch in winax.
    // Use VBA macro fallback for reliable opening.
    const escapedPath = filePath.replace(/\\/g, '\\\\');
    const vba = `
Dim swApp As SldWorks.SldWorks

Sub main()
    On Error Resume Next
    Set swApp = Application.SldWorks
    Dim errs As Long
    Dim warns As Long
    Dim swDoc As ModelDoc2
    Set swDoc = swApp.OpenDoc6("${escapedPath}", ${docType}, 1, "", errs, warns)
    If swDoc Is Nothing Then
        Set swDoc = swApp.ActiveDoc
    End If
    If swDoc Is Nothing Then
        WriteLog "{""error"": ""OpenDoc6 failed"", ""errCode"": " & errs & ", ""warnCode"": " & warns & "}"
    Else
        ' Activate the opened document so it becomes ActiveDoc
        Dim activateErrs As Long
        swApp.ActivateDoc3 swDoc.GetTitle, False, 0, activateErrs
        WriteLog "{""success"": true, ""name"": """ & swDoc.GetTitle & """, ""type"": " & swDoc.GetType & "}"
    End If
End Sub

Sub WriteLog(msg As String)
    Dim fNum As Integer: fNum = FreeFile
    Open "LOG_PATH_PLACEHOLDER" For Output As #fNum
    Print #fNum, msg
    Close #fNum
End Sub
`;
    const result = runVBAMacro(this, vba);
    if (!result.success) {
      throw new Error(`Failed to open model: ${result.error}`);
    }

    let parsed: any;
    try { parsed = JSON.parse(result.output || '{}'); } catch { parsed = {}; }
    if (parsed.error) {
      throw new Error(`Failed to open model: ${parsed.error} (err=${parsed.errCode})`);
    }

    // Refresh currentModel reference after VBA opened the file
    this.currentModel = this.swApp.ActiveDoc;

    if (!this.currentModel) {
      throw new Error(`Failed to open model: ${filePath}`);
    }

    const typeName = (['Part', 'Assembly', 'Drawing'][docType - 1] as 'Part' | 'Assembly' | 'Drawing');

    return {
      path: filePath,
      name: parsed.name || this.currentModel.GetTitle(),
      type: typeName,
      isActive: true,
    };
  }

  closeModel(save: boolean = false): void {
    this.ensureCurrentModel();
    if (!this.currentModel) return;

    let modelTitle = '';
    try {
      // Safely get the title
      if (this.currentModel.GetTitle) {
        modelTitle = this.currentModel.GetTitle();
      } else if (this.currentModel.GetPathName) {
        modelTitle = this.currentModel.GetPathName();
      }
    } catch (_e) {
      // If we can't get the title, continue anyway
      modelTitle = 'Unknown';
    }

    if (save) {
      try {
        // Save3 has ByRef Long params that cause type mismatch in winax
        this.currentModel.Save();
      } catch (e) {
        // Continue even if save fails (doc may be new with no path)
      }
    }

    // Close using app method if title is available
    if (modelTitle && modelTitle !== 'Unknown' && this.swApp) {
      try {
        this.swApp.CloseDoc(modelTitle);
      } catch (_e) {
        // Fallback: just clear the reference
      }
    }

    this.currentModel = null;
  }

  createPart(): SolidWorksModel {
    if (!this.swApp) throw new Error('Not connected to SolidWorks');

    // Create new part document - use NewPart() which works better
    this.currentModel = this.swApp.NewPart();

    if (!this.currentModel) {
      // Fallback to NewDocument if NewPart fails
      const template = this.swApp.GetUserPreferenceStringValue(8) || '';
      if (template) {
        this.currentModel = this.swApp.NewDocument(template, 0, 0, 0);
      } else {
        throw new Error('Failed to create new part - no template available');
      }
    }

    return {
      path: '',
      name: this.currentModel.GetTitle,
      type: 'Part',
      isActive: true,
    };
  }

  // Macro support methods
  createSketch(params: any): any {
    this.ensureCurrentModel();
    if (!this.currentModel) throw new Error('No active model');

    const { plane = 'Front' } = params;
    const planeRef = this.currentModel.FeatureManager.GetPlane(plane);

    if (planeRef) {
      this.currentModel.SketchManager.InsertSketch(true);
      const sketchName = this.currentModel.SketchManager.ActiveSketch.Name;
      return { success: true, sketchId: sketchName };
    }

    return { success: false, error: 'Failed to create sketch' };
  }

  addLine(params: any): any {
    this.ensureCurrentModel();
    if (!this.currentModel) throw new Error('No active model');

    const { x1 = 0, y1 = 0, z1 = 0, x2 = 100, y2 = 0, z2 = 0 } = params;

    const line = this.currentModel.SketchManager.CreateLine(
      x1 / 1000,
      y1 / 1000,
      z1 / 1000, // Convert mm to m
      x2 / 1000,
      y2 / 1000,
      z2 / 1000
    );

    if (line) {
      return { success: true, lineId: `line_${Date.now()}` };
    }

    return { success: false, error: 'Failed to create line' };
  }

  extrude(params: any): any {
    this.ensureCurrentModel();
    if (!this.currentModel) throw new Error('No active model');

    const { depth = 25, reverse = false, draft = 0 } = params;

    const feature = this.createExtrude(depth, draft, reverse);

    if (feature) {
      return { success: true, featureId: feature.name };
    }

    return { success: false, error: 'Failed to create extrusion' };
  }

  // Feature operations
  createExtrude(
    depth: number,
    draft: number = 0,
    reverse: boolean = false
  ): SolidWorksFeature {
    this.ensureCurrentModel();
    if (!this.currentModel) throw new Error('No model open');

    const depthInMeters = depth / 1000;
    const draftRad = (draft * Math.PI / 180).toFixed(10);
    const depthStr = depthInMeters.toFixed(10);
    const flipStr = reverse ? 'True' : 'False';
    const draftEnabled = draft !== 0 ? 'True' : 'False';

    // Use runVBAMacro (.swb) — FeatureExtrusion3 fails through cscript/VBScript
    // but works reliably in VBA macros run inside SolidWorks process.
    const vba = `
Dim swApp As SldWorks.SldWorks

Sub main()
    On Error Resume Next
    Set swApp = Application.SldWorks
    Dim swModel As ModelDoc2
    Set swModel = swApp.ActiveDoc
    If swModel Is Nothing Then
        WriteLog "{""error"": ""No active document""}"
        Exit Sub
    End If

    ' Walk feature tree to find the last sketch
    Dim swFeat As Feature
    Set swFeat = swModel.FirstFeature
    Dim lastSketch As Feature
    Do While Not swFeat Is Nothing
        If swFeat.GetTypeName2 = "ProfileFeature" Then Set lastSketch = swFeat
        Set swFeat = swFeat.GetNextFeature
        If Err.Number <> 0 Then Err.Clear: Set swFeat = Nothing
    Loop

    If lastSketch Is Nothing Then
        WriteLog "{""error"": ""No sketch found to extrude""}"
        Exit Sub
    End If

    Dim skName As String: skName = lastSketch.Name

    ' Activation dance: select, edit, exit, reselect
    swModel.ClearSelection2 True
    swModel.Extension.SelectByID2 skName, "SKETCH", 0, 0, 0, False, 0, Nothing, 0
    swModel.EditSketch
    swModel.InsertSketch2 True
    swModel.ClearSelection2 True
    swModel.Extension.SelectByID2 skName, "SKETCH", 0, 0, 0, False, 0, Nothing, 0

    ' FeatureExtrusion3: 23 params via late-bound Object
    Dim fm As Object
    Set fm = swModel.FeatureManager
    Dim extFeat As Object
    Set extFeat = fm.FeatureExtrusion3( _
        True, ${flipStr}, False, _
        CLng(0), CLng(0), _
        CDbl(${depthStr}), CDbl(${depthStr}), _
        ${draftEnabled}, False, False, False, _
        CDbl(${draftRad}), CDbl(0), _
        False, False, False, False, _
        True, False, True, _
        CLng(0), CDbl(0), False)
    If Err.Number <> 0 Then Err.Clear

    swModel.ClearSelection2 True
    swModel.EditRebuild3

    If Not extFeat Is Nothing Then
        WriteLog "{""success"": true, ""name"": """ & extFeat.Name & """}"
    Else
        WriteLog "{""error"": ""FeatureExtrusion3 returned Nothing for sketch '"" & skName & ""'""}"
    End If
End Sub

Sub WriteLog(msg As String)
    Dim fNum As Integer: fNum = FreeFile
    Open "LOG_PATH_PLACEHOLDER" For Output As #fNum
    Print #fNum, msg
    Close #fNum
End Sub
`;

    const result = runVBAMacro(this, vba);
    if (!result.success) {
      throw new Error(`Extrusion macro failed: ${result.error || 'unknown error'}`);
    }

    let parsed: any;
    try { parsed = JSON.parse(result.output || ''); } catch { parsed = null; }

    if (parsed?.error) {
      throw new Error(`Extrusion failed: ${parsed.error}`);
    }
    if (parsed?.name) {
      return { name: parsed.name, type: 'Extrusion', suppressed: false };
    }

    // Fallback: verify via feature tree
    let featureName = '';
    try {
      for (let i = 0; i < 3; i++) {
        const feat = this.currentModel.FeatureByPositionReverse(i);
        if (feat) {
          const typeName = feat.GetTypeName2();
          if (typeName === 'Extrusion' || typeName === 'ICE' ||
              typeName === 'Boss-Extrude' || typeName === 'MemberExtrusion') {
            featureName = feat.Name || feat.GetName() || 'Boss-Extrude';
            break;
          }
        }
      }
    } catch (e) {
      logger.warn(`Could not verify extrusion feature: ${e}`);
    }

    if (!featureName) {
      throw new Error(`Extrusion macro ran but no feature created. Raw output: ${result.output || 'none'}. The sketch may be invalid.`);
    }

    return {
      name: featureName,
      type: 'Extrusion',
      suppressed: false,
    };
  }

  /**
   * Execute extrusion via VBA macro - bypasses winax COM parameter limit.
   * Used as fallback when direct COM calls fail with type mismatch errors.
   */
  private executeExtrusionViaMacro(depthInMeters: number, reverse: boolean): any {
    const macroDir = join(tmpdir(), 'solidworks-mcp-macros');
    const macroPath = join(macroDir, `extrusion_${Date.now()}.swp`);

    try {
      mkdirSync(macroDir, { recursive: true });
    } catch (_e) {
      // Directory may already exist
    }

    // Generate a silent VBA macro (no MsgBox — automation-safe)
    const vbaCode = `Attribute VB_Name = "Module1"
Option Explicit

Sub CreateExtrusion()
    Dim swApp As Object
    Dim swModel As Object
    Dim swFeatureMgr As Object
    Dim swFeature As Object

    On Error GoTo ErrorHandler

    Set swApp = Application.SldWorks
    Set swModel = swApp.ActiveDoc

    If swModel Is Nothing Then Exit Sub

    Set swFeatureMgr = swModel.FeatureManager

    ' The sketch should already be selected by the caller.
    ' Create a simple blind extrusion using FeatureExtrusion3
    Set swFeature = swFeatureMgr.FeatureExtrusion3( _
        True, _              ' Sd  (single direction)
        ${reverse ? 'True' : 'False'}, _             ' Flip
        False, _             ' Dir (both directions)
        0, _                 ' T1  (blind end condition)
        0, _                 ' T2
        ${depthInMeters}, _  ' D1  (depth in meters)
        0, _                 ' D2
        False, _             ' Dchk1 (draft while extruding)
        False, _             ' Dchk2
        False, _             ' Ddir1 (draft outward)
        False, _             ' Ddir2
        0, _                 ' Dang1 (draft angle)
        0, _                 ' Dang2
        False, _             ' OffsetReverse1
        False, _             ' OffsetReverse2
        False, _             ' TranslateSurface1
        False, _             ' TranslateSurface2
        True, _              ' Merge
        False, _             ' FlipSideToCut
        True, _              ' UseFeatScope
        0, _                 ' StartCondition
        0, _                 ' StartOffset
        False _              ' FlipStartOffset
    )

    ' Rebuild the model
    swModel.EditRebuild3

    Exit Sub

ErrorHandler:
    ' Silent fail — caller checks for feature creation
    Debug.Print "Extrusion macro error: " & Err.Description
End Sub
`;

    try {
      writeFileSync(macroPath, vbaCode, 'utf-8');
      logger.info(`Wrote extrusion macro to ${macroPath}`);

      // Execute the macro via SolidWorks RunMacro2
      const runResult = this.swApp.RunMacro2(
        macroPath,
        'Module1',
        'CreateExtrusion',
        1, // swRunMacroOption_e.swRunMacroUnloadAfterRun
        0 // error out param
      );
      logger.info(`RunMacro2 returned: ${runResult}`);

      // Retrieve the newly created feature (should be the most recent)
      const feature = this.currentModel.FeatureByPositionReverse(0);
      if (feature) {
        const typeName = feature.GetTypeName2?.() || '';
        if (typeName.toLowerCase().includes('extrusion') || typeName.toLowerCase().includes('boss')) {
          logger.info(`VBA macro extrusion succeeded: ${feature.Name || feature.GetName?.()}`);
          return feature;
        }
      }

      throw new Error('VBA macro executed but no extrusion feature found');
    } catch (macroError) {
      logger.error(`VBA macro extrusion failed: ${macroError}`);
      throw new Error(`Extrusion failed: all direct COM methods and VBA macro fallback failed. Details: ${macroError}`);
    } finally {
      // Clean up temp macro file
      try {
        unlinkSync(macroPath);
      } catch (_e) {
        // Ignore cleanup errors
      }
    }
  }

  // Dimension operations
  getDimension(name: string): number {
    this.ensureCurrentModel();
    if (!this.currentModel) throw new Error('No model open');

    let dimension = null;

    // Method 1: Try Parameter method
    try {
      dimension = this.currentModel.Parameter(name);
    } catch (_e) {
      // Parameter might not work
    }

    // Method 2: Try GetParameter
    if (!dimension) {
      try {
        dimension = this.currentModel.GetParameter(name);
      } catch (_e) {
        // GetParameter might not work
      }
    }

    // Method 3: Try Extension.GetParameter
    if (!dimension) {
      try {
        const ext = this.currentModel.Extension;
        if (ext) {
          dimension = ext.GetParameter(name);
        }
      } catch (_e) {
        // Extension method might not work
      }
    }

    // Method 4: Try SelectByID and get dimension
    if (!dimension) {
      try {
        const selected = this.currentModel.Extension.SelectByID2(name, 'DIMENSION', 0, 0, 0, false, 0, undefined, 0);
        if (selected) {
          const selMgr = this.currentModel.SelectionManager;
          if (selMgr && selMgr.GetSelectedObjectCount() > 0) {
            const obj = selMgr.GetSelectedObject6(1, -1);
            if (obj) {
              dimension = obj;
            }
          }
          this.currentModel.ClearSelection2(true);
        }
      } catch (_e) {
        // Selection method failed
      }
    }

    if (!dimension) {
      throw new Error(`Dimension "${name}" not found. Try format like "D1@Sketch1" or "D1@Boss-Extrude1"`);
    }

    // Get the value - try different properties
    let value = 0;
    try {
      if (dimension.SystemValue !== undefined) {
        value = dimension.SystemValue * 1000; // Convert m to mm
      } else if (dimension.Value !== undefined) {
        value = dimension.Value * 1000;
      } else if (dimension.GetSystemValue) {
        value = dimension.GetSystemValue() * 1000;
      } else {
        throw new Error('Cannot read dimension value');
      }
    } catch (_e) {
      throw new Error(`Cannot read value of dimension "${name}"`);
    }

    return value;
  }

  setDimension(name: string, value: number): void {
    this.ensureCurrentModel();
    if (!this.currentModel) throw new Error('No model open');

    let dimension = null;

    // Method 1: Try Parameter method
    try {
      dimension = this.currentModel.Parameter(name);
    } catch (_e) {
      // Parameter might not work
    }

    // Method 2: Try GetParameter
    if (!dimension) {
      try {
        dimension = this.currentModel.GetParameter(name);
      } catch (_e) {
        // GetParameter might not work
      }
    }

    // Method 3: Try Extension.GetParameter
    if (!dimension) {
      try {
        const ext = this.currentModel.Extension;
        if (ext) {
          dimension = ext.GetParameter(name);
        }
      } catch (_e) {
        // Extension method might not work
      }
    }

    // Method 4: Try SelectByID and get dimension
    if (!dimension) {
      try {
        const selected = this.currentModel.Extension.SelectByID2(name, 'DIMENSION', 0, 0, 0, false, 0, undefined, 0);
        if (selected) {
          const selMgr = this.currentModel.SelectionManager;
          if (selMgr && selMgr.GetSelectedObjectCount() > 0) {
            const obj = selMgr.GetSelectedObject6(1, -1);
            if (obj) {
              dimension = obj;
            }
          }
          // Don't clear selection yet - might need it for setting
        }
      } catch (_e) {
        // Selection method failed
      }
    }

    if (!dimension) {
      throw new Error(`Dimension "${name}" not found. Try format like "D1@Sketch1" or "D1@Boss-Extrude1"`);
    }

    // Set the value - try different methods
    const newValue = value / 1000; // Convert mm to m
    let success = false;

    try {
      if (dimension.SystemValue !== undefined) {
        dimension.SystemValue = newValue;
        success = true;
      } else if (dimension.Value !== undefined) {
        dimension.Value = newValue;
        success = true;
      } else if (dimension.SetSystemValue) {
        success = dimension.SetSystemValue(newValue);
      } else if (dimension.SetValue) {
        success = dimension.SetValue(newValue);
      }
    } catch (_e) {
      // Try equation manager
      try {
        const eqMgr = this.currentModel.GetEquationMgr();
        if (eqMgr) {
          const count = eqMgr.GetCount();
          for (let i = 0; i < count; i++) {
            const eq = eqMgr.Equation[i];
            if (eq?.includes(name)) {
              eqMgr.Equation[i] = `"${name}" = ${value}`;
              success = true;
              break;
            }
          }
        }
      } catch (_e2) {
        // Equation manager failed
      }
    }

    // Clear selection if we used it
    try {
      this.currentModel.ClearSelection2(true);
    } catch (_e) {
      // Ignore clear selection errors
    }

    if (!success) {
      throw new Error(`Failed to set dimension "${name}" to ${value}mm`);
    }

    this.currentModel.EditRebuild3();
  }

  // Export operations
  exportFile(filePath: string, format: string): void {
    this.ensureCurrentModel();
    if (!this.currentModel) throw new Error('No model open');

    try {
      // Ensure the model is saved first
      const currentPath = this.currentModel.GetPathName();
      if (!currentPath || currentPath === '') {
        const docType = this.currentModel.GetType();
        const ext = docType === 1 ? '.SLDPRT' : docType === 2 ? '.SLDASM' : '.SLDDRW';
        const tempPath = filePath.replace(/\.[^.]+$/, ext);
        this.currentModel.SaveAs(tempPath);
      }

      const ext = format.toLowerCase();

      if (ext === 'pdf') {
        const docType = this.currentModel.GetType();
        if (docType !== 3) {
          throw new Error('PDF export requires a drawing document');
        }
      }

      const supported = ['step', 'stp', 'iges', 'igs', 'stl', 'pdf', 'dxf', 'dwg'];
      if (!supported.includes(ext)) {
        throw new Error(`Unsupported export format: ${format}`);
      }

      // SaveAs (simple variant) determines format from file extension.
      // SaveAs3/SaveAs4/Extension.SaveAs all have ByRef Long params that
      // cause "Type mismatch" through winax COM bridge.
      const success = this.currentModel.SaveAs(filePath);
      if (!success) {
        throw new Error(`Failed to export to ${format.toUpperCase()}: SaveAs returned false`);
      }
    } catch (error) {
      throw new Error(`Export failed: ${error}`);
    }
  }

  // VBA operations
  runMacro(macroPath: string, moduleName: string, procedureName: string, _args: any[] = []): any {
    if (!this.swApp) throw new Error('Not connected to SolidWorks');

    const moduleNames = [moduleName];
    if (moduleName && moduleName !== '') moduleNames.push('');
    if (moduleName !== 'Module1') moduleNames.push('Module1');

    const errors: string[] = [];

    // Try RunMacro2 with different ByRef error param marshaling
    const errorParamVariants = [[0], 0, undefined];
    for (const modName of moduleNames) {
      for (const errParam of errorParamVariants) {
        try {
          const result = this.swApp.RunMacro2(macroPath, modName, procedureName, 0, errParam);
          logger.info(`RunMacro2 succeeded for ${macroPath} module="${modName}"`);
          return result;
        } catch (e: any) {
          errors.push(`RunMacro2 module="${modName}" err=${JSON.stringify(errParam)}: ${e?.message || e}`);
        }
      }
    }

    // Fallback: RunMacro v1 (works with .swp files)
    for (const modName of moduleNames) {
      try {
        const result = this.swApp.RunMacro(macroPath, modName, procedureName);
        logger.info(`RunMacro v1 succeeded for ${macroPath} module="${modName}"`);
        return result;
      } catch (e: any) {
        errors.push(`RunMacro v1 module="${modName}": ${e?.message || e}`);
      }
    }

    throw new Error(`All RunMacro methods failed for ${macroPath}. Errors: ${errors.join(' | ')}`);
  }

  // Mass properties
  getMassProperties(): any {
    this.ensureCurrentModel();
    if (!this.currentModel) throw new Error('No model open');

    // Check document type - mass properties only work for parts and assemblies
    const docType = this.currentModel.GetType();
    if (docType !== 1 && docType !== 2) {
      // 1=Part, 2=Assembly
      throw new Error('Mass properties only available for parts and assemblies');
    }

    try {
      // Get the modeler extension
      const modeler = this.currentModel.Extension;
      if (!modeler) {
        throw new Error('Cannot access model extension');
      }

      // Create mass property object
      let massProps = null;

      try {
        // Method 1: Try CreateMassProperty
        massProps = modeler.CreateMassProperty();
      } catch (_e) {
        // Method 2: Try CreateMassProperty2
        try {
          massProps = modeler.CreateMassProperty2();
        } catch (_e2) {
          // Method 3: Try getting it from the model directly
          massProps = this.currentModel.GetMassProperties();
        }
      }

      if (!massProps) {
        throw new Error('Failed to create mass property object');
      }

      // Update mass properties if method exists
      try {
        if (massProps.Update) {
          const success = massProps.Update();
          if (!success) {
            // Try recalculate
            if (massProps.Recalculate) {
              massProps.Recalculate();
            }
          }
        }
      } catch (_e) {
        // Update might not be needed
      }

      // Get the values with error handling
      const result: any = {};

      try {
        result.mass = massProps.Mass;
      } catch (_e) {
        result.mass = 0;
      }

      try {
        result.volume = massProps.Volume;
      } catch (_e) {
        result.volume = 0;
      }

      try {
        result.surfaceArea = massProps.SurfaceArea;
      } catch (_e) {
        result.surfaceArea = 0;
      }

      try {
        const com = massProps.CenterOfMass;
        if (com && Array.isArray(com) && com.length >= 3) {
          result.centerOfMass = {
            x: com[0] * 1000, // Convert to mm
            y: com[1] * 1000,
            z: com[2] * 1000,
          };
        } else {
          result.centerOfMass = { x: 0, y: 0, z: 0 };
        }
      } catch (_e) {
        result.centerOfMass = { x: 0, y: 0, z: 0 };
      }

      try {
        result.density = massProps.Density;
      } catch (_e) {
        result.density = 0;
      }

      try {
        const moi = massProps.MomentOfInertia;
        if (moi && Array.isArray(moi) && moi.length >= 9) {
          result.momentsOfInertia = {
            Ixx: moi[0],
            Ixy: moi[1],
            Ixz: moi[2],
            Iyx: moi[3],
            Iyy: moi[4],
            Iyz: moi[5],
            Izx: moi[6],
            Izy: moi[7],
            Izz: moi[8],
          };
        }
      } catch (_e) {
        // Moments of inertia might not be available
      }

      return result;
    } catch (error) {
      throw new Error(`Failed to get mass properties: ${error}`);
    }
  }

  // Helper to ensure current model is set
  private ensureCurrentModel(): void {
    if (!this.swApp) return;

    // Always try to sync with the active document
    try {
      const activeDoc = this.swApp.ActiveDoc;
      if (activeDoc) {
        // Check if the active doc has changed
        if (!this.currentModel || this.currentModel !== activeDoc) {
          this.currentModel = activeDoc;
        }
      } else if (!this.currentModel) {
        // No active doc and no current model - try to get any open doc
        try {
          const docCount = this.swApp.GetDocumentCount();
          if (docCount > 0) {
            // Get the first document
            const docs = this.swApp.GetDocuments();
            if (docs && docs.length > 0) {
              this.currentModel = docs[0];
            }
          }
        } catch (_e2) {
          // GetDocumentCount might not be available
        }
      }
    } catch (_e) {
      // ActiveDoc might throw if no documents are open
      // Keep the current model if we have one
      if (!this.currentModel) {
        // Try alternative methods to get a document
        try {
          const frame = this.swApp.Frame();
          if (frame) {
            const modelWindow = frame.ModelWindow();
            if (modelWindow) {
              this.currentModel = modelWindow.ModelDoc;
            }
          }
        } catch (_e3) {
          // Frame method might not work
        }
      }
    }
  }

  // Helper to get current model
  getCurrentModel(): any {
    this.ensureCurrentModel();
    return this.currentModel;
  }

  // Helper to get SolidWorks app
  getApp(): any {
    return this.swApp;
  }

  // Create a new assembly document
  createAssembly(templatePath?: string, savePath?: string): SolidWorksModel {
    if (!this.swApp) throw new Error('Not connected to SolidWorks');

    const saveBlock = savePath ? `
    ' Save to specified path (simple SaveAs — SaveAs3 has ByRef issues in VBScript)
    Dim bSaveRet As Boolean
    bSaveRet = swModel.SaveAs("${savePath.replace(/\\/g, '\\\\')}")
    If Not bSaveRet Then
        Debug.Print "WARN: SaveAs failed"
    End If
    ` : '';

    const vbaCode = `
Dim swApp As Object
Sub CreateAssembly()
    Set swApp = Application.SldWorks

    ' Try user-specified template first
    Dim tmpl As String
    ${templatePath ? `tmpl = "${templatePath.replace(/\\/g, '\\\\')}"` : `
    tmpl = swApp.GetUserPreferenceStringValue(23)
    If tmpl = "" Then tmpl = "C:\\ProgramData\\SolidWorks\\SOLIDWORKS 2024\\templates\\Assembly.asmdot"
    `}

    Dim swModel As Object
    Set swModel = swApp.NewDocument(tmpl, 0, 0, 0)

    If swModel Is Nothing Then
        Debug.Print "ERROR: Failed to create assembly from template: " & tmpl
    Else
        Set swModel = swApp.ActiveDoc
        ${saveBlock}
        Debug.Print "SUCCESS: " & swModel.GetTitle
    End If
End Sub
`;

    const result = executeVBA(this, vbaCode, 'CreateAssembly');
    if (!result.success) {
      throw new Error(`Assembly creation failed: ${result.error || result.output}`);
    }

    // Update currentModel reference
    try {
      this.currentModel = this.swApp.ActiveDoc;
    } catch {
      // Will be picked up by ensureCurrentModel
    }

    const title = result.output?.match(/SUCCESS:\s*(.+)/)?.[1]?.trim() || 'Assembly';
    return {
      path: savePath || '',
      name: title,
      type: 'Assembly',
      isActive: true,
    };
  }

  // Save or SaveAs the active document
  saveModel(path?: string): string {
    this.ensureCurrentModel();
    if (!this.currentModel) throw new Error('No model open');

    const targetPath = path || String(this.currentModel.GetPathName() || '');

    // PDM sandbox files often have read-only attributes. Strip before saving.
    if (targetPath) {
      try {
        const { statSync, chmodSync } = require('fs');
        const stats = statSync(targetPath);
        if (!(stats.mode & 0o200)) {
          chmodSync(targetPath, stats.mode | 0o200);
        }
      } catch {
        // File may not exist yet (new Save As) — that's fine
      }
    }

    // Use direct COM — VBScript Save2/SaveAs have ByRef issues
    if (path) {
      const result = this.currentModel.SaveAs(path);
      if (!result) {
        throw new Error(`SaveAs failed for: ${path}`);
      }
      return String(this.currentModel.GetPathName()) || path;
    } else {
      this.currentModel.Save();
      return String(this.currentModel.GetPathName()) || 'saved';
    }
  }

  // Position a component in an assembly using direct COM (winax).
  // VBScript can't read/write Transform2 (COM object property type mismatch).
  positionComponent(componentName: string, x: number, y: number, z: number, rotationAxis?: string, rotationAngleDeg?: number): string {
    // Ensure connection — VBScript tools bypass the API, so swApp may not be set
    if (!this.swApp) this.connect();
    this.ensureCurrentModel();
    if (!this.currentModel) throw new Error('No model open');

    // Walk feature tree to find the component (avoids SafeArray from GetComponents)
    let comp: any = null;
    let feat = this.currentModel.FirstFeature;
    while (feat) {
      try {
        if (String(feat.GetTypeName2()) === 'Reference') {
          const c = feat.GetSpecificFeature2();
          if (c && String(c.Name2).toLowerCase().includes(componentName.toLowerCase())) {
            comp = c;
            break;
          }
        }
        feat = feat.GetNextFeature();
      } catch {
        break;
      }
    }
    if (!comp) throw new Error(`Component '${componentName}' not found`);

    // Float if fixed
    try {
      if (comp.IsFixed) {
        // Use SelectByID on the model to select & unfix
        this.currentModel.SelectByID(componentName, 'COMPONENT', 0, 0, 0);
        this.currentModel.UnfixComponent();
        this.currentModel.ClearSelection2(true);
      }
    } catch { /* ignore - may already be floated */ }

    // Build transform as a 16-element array:
    // [r00,r01,r02, r10,r11,r12, r20,r21,r22, tx,ty,tz, scale, 0,0,0]
    const xm = x / 1000;
    const ym = y / 1000;
    const zm = z / 1000;

    let r00 = 1, r01 = 0, r02 = 0;
    let r10 = 0, r11 = 1, r12 = 0;
    let r20 = 0, r21 = 0, r22 = 1;

    if (rotationAxis && rotationAngleDeg) {
      const rad = (rotationAngleDeg * Math.PI) / 180;
      const c = Math.cos(rad);
      const s = Math.sin(rad);
      if (rotationAxis === 'x') {
        r11 = c; r12 = -s; r21 = s; r22 = c;
      } else if (rotationAxis === 'y') {
        r00 = c; r02 = s; r20 = -s; r22 = c;
      } else if (rotationAxis === 'z') {
        r00 = c; r01 = -s; r10 = s; r11 = c;
      }
    }

    const xformData = [
      r00, r01, r02,
      r10, r11, r12,
      r20, r21, r22,
      xm, ym, zm,
      1, // scale
      0, 0, 0
    ];

    // VBScript can't set Transform2 (type mismatch on COM object property).
    // Winax comp.Transform2 = transform creates a JS shadow property, not a COM set.
    // Solution: Write a .swb VBA macro and run it via RunMacro — runs inside
    // SolidWorks process with full VBA type support.
    const macroPath = join('C:\\Eng Vault\\Sandbox\\JYannessa', '_position_component.swb');

    // Get the assembly title for component name qualification
    const assyTitle = String(this.currentModel.GetTitle()).replace(/\.[^.]+$/, '');

    const vbaCode = `
Dim swApp As SldWorks.SldWorks
Dim logMsg As String
Sub main()
    Set swApp = Application.SldWorks
    Dim swModel As ModelDoc2
    Set swModel = swApp.ActiveDoc
    If swModel Is Nothing Then
        logMsg = "ERROR: No active doc"
        Exit Sub
    End If

    Dim swAssy As AssemblyDoc
    Set swAssy = swModel

    ' Get component directly from assembly using GetComponents
    Dim vComps As Variant
    vComps = swAssy.GetComponents(False)
    If IsEmpty(vComps) Then
        logMsg = "ERROR: GetComponents returned empty"
        Exit Sub
    End If

    Dim swComp As Component2
    Set swComp = Nothing
    Dim i As Long
    For i = 0 To UBound(vComps)
        Dim testComp As Component2
        Set testComp = vComps(i)
        If InStr(1, testComp.Name2, "${componentName}", vbTextCompare) > 0 Then
            Set swComp = testComp
            Exit For
        End If
    Next i

    If swComp Is Nothing Then
        logMsg = "ERROR: Component not found"
        Exit Sub
    End If

    logMsg = "Found: " & swComp.Name2

    ' Float if fixed
    If swComp.IsFixed Then
        swComp.Select4 False, Nothing, False
        swModel.UnfixComponent
        swModel.ClearSelection2 True
        logMsg = logMsg & " | Unfixed"
    End If

    ' Build transform
    Dim swMathUtil As MathUtility
    Set swMathUtil = swApp.GetMathUtility

    Dim xformData(15) As Double
    xformData(0) = ${r00}: xformData(1) = ${r01}: xformData(2) = ${r02}
    xformData(3) = ${r10}: xformData(4) = ${r11}: xformData(5) = ${r12}
    xformData(6) = ${r20}: xformData(7) = ${r21}: xformData(8) = ${r22}
    xformData(9) = ${xm}: xformData(10) = ${ym}: xformData(11) = ${zm}
    xformData(12) = 1#
    xformData(13) = 0#: xformData(14) = 0#: xformData(15) = 0#

    Dim swTransform As MathTransform
    Set swTransform = swMathUtil.CreateTransform(xformData)

    If swTransform Is Nothing Then
        logMsg = logMsg & " | ERROR: CreateTransform returned Nothing"
        Exit Sub
    End If

    logMsg = logMsg & " | Transform created"

    ' Set transform - use property Let (not Set) for Transform2
    swComp.Transform2 = swTransform
    logMsg = logMsg & " | Transform applied"

    swModel.EditRebuild3
    logMsg = logMsg & " | Rebuilt"

    ' Read back to verify
    Dim xfBack As MathTransform
    Set xfBack = swComp.Transform2
    If Not xfBack Is Nothing Then
        Dim dBack As Variant
        dBack = xfBack.ArrayData
        logMsg = logMsg & " | Pos=(" & Round(dBack(9) * 1000, 1) & "," & Round(dBack(10) * 1000, 1) & "," & Round(dBack(11) * 1000, 1) & ")"
    End If

    ' Write log to file for debugging
    Dim fNum As Integer
    fNum = FreeFile
    Open "C:\\Eng Vault\\Sandbox\\JYannessa\\_macro_log.txt" For Output As #fNum
    Print #fNum, logMsg
    Close #fNum
End Sub
`;

    // Write macro file
    writeFileSync(macroPath, vbaCode, 'utf8');

    // Run it via winax — RunMacro has 3 params (no ByRef), should work
    let runResult: any = false;
    try {
      runResult = this.swApp.RunMacro(macroPath, '', 'main');
      if (!runResult) {
        logger.warn('RunMacro returned false — macro may have failed');
      }
    } finally {
      // Clean up macro file
      try { unlinkSync(macroPath); } catch { /* ignore */ }
    }

    // Read macro log for debug info
    const logPath = join('C:\\Eng Vault\\Sandbox\\JYannessa', '_macro_log.txt');
    let macroLog = '';
    try {
      macroLog = readFileSync(logPath, 'utf8').trim();
      try { unlinkSync(logPath); } catch { /* ignore */ }
    } catch { /* no log file = macro didn't run or didn't reach log write */ }

    return macroLog
      ? `${macroLog}`
      : `RunMacro returned ${runResult} — no log output (macro may not have executed)`;
  }

  // Read component transforms using direct COM (VBScript can't read Transform2).
  // Returns a map of componentName -> { position, rotation }
  getComponentTransforms(): Record<string, { position: { x: number; y: number; z: number }; rotation: number[] }> {
    if (!this.swApp) this.connect();
    this.ensureCurrentModel();
    if (!this.currentModel) return {};

    const result: Record<string, { position: { x: number; y: number; z: number }; rotation: number[] }> = {};

    try {
      let feat = this.currentModel.FirstFeature;
      while (feat) {
        try {
          if (String(feat.GetTypeName2()) === 'Reference') {
            const comp = feat.GetSpecificFeature2();
            if (comp) {
              const name = String(comp.Name2);
              try {
                const xf = comp.Transform2;
                if (xf) {
                  const d = xf.ArrayData;
                  result[name] = {
                    position: {
                      x: Math.round(d[9] * 1000 * 1000) / 1000,
                      y: Math.round(d[10] * 1000 * 1000) / 1000,
                      z: Math.round(d[11] * 1000 * 1000) / 1000
                    },
                    rotation: [d[0], d[1], d[2], d[3], d[4], d[5], d[6], d[7], d[8]]
                  };
                }
              } catch {
                // Transform read failed for this component
              }
            }
          }
          feat = feat.GetNextFeature();
        } catch {
          break;
        }
      }
    } catch {
      // Feature tree walk failed
    }

    return result;
  }

  // Cut-extrude from the most recent sketch
  // Uses runVBAMacro (.swb) instead of VBScript because FeatureCut4 has
  // ByRef params that cause type mismatch errors in VBScript/cscript.exe.
  // Key lesson: singleDir=True + flip for direction control works reliably;
  // bothDir=True often returns Nothing even when the sketch is valid.
  createCutExtrude(
    depth: number,
    throughAll: boolean = false,
    reverse: boolean = false,
    draft: number = 0,
    flipSide: boolean = false
  ): SolidWorksFeature {
    if (!this.currentModel) throw new Error('No model open');

    const depthM = (depth / 1000).toFixed(10);
    const draftRad = (draft * Math.PI / 180).toFixed(10);
    const draftEnabled = draft !== 0 ? 'True' : 'False';
    const flipStr = reverse ? 'True' : 'False';
    const flipSideStr = flipSide ? 'True' : 'False';
    // Through-all: use singleDir + endCond=1; blind: singleDir + endCond=0
    const endCond = throughAll ? 'CLng(1)' : 'CLng(0)';

    const vba = `
Dim swApp As SldWorks.SldWorks

Sub main()
    On Error Resume Next
    Set swApp = Application.SldWorks
    Dim swModel As ModelDoc2
    Set swModel = swApp.ActiveDoc
    If swModel Is Nothing Then
        WriteLog "{""error"": ""No active document""}"
        Exit Sub
    End If

    ' Find the last sketch and count features for diagnostics
    Dim swFeat As Feature
    Set swFeat = swModel.FirstFeature
    Dim lastSketch As Feature
    Dim sketchCount As Long: sketchCount = 0
    Dim featureCount As Long: featureCount = 0
    Do While Not swFeat Is Nothing
        Dim ft As String: ft = swFeat.GetTypeName2
        If ft = "ProfileFeature" Then
            Set lastSketch = swFeat
            sketchCount = sketchCount + 1
        End If
        If ft = "Extrusion" Or ft = "ICE" Or ft = "Fillet" Then featureCount = featureCount + 1
        Set swFeat = swFeat.GetNextFeature
        If Err.Number <> 0 Then Err.Clear: Set swFeat = Nothing
    Loop

    If lastSketch Is Nothing Then
        WriteLog "{""error"": ""No sketch found for cut""}"
        Exit Sub
    End If

    ' Note: GetSketchSegmentCount returns 0 when sketch is not in edit mode (false negative).
    ' Do NOT abort here — the activation dance below puts the sketch in edit mode,
    ' and FeatureCut4 will fail naturally if the sketch is truly empty.
    Dim skName As String: skName = lastSketch.Name

    ' Activation dance: select, edit, exit, reselect (required for reliable feature creation)
    swModel.ClearSelection2 True
    swModel.Extension.SelectByID2 skName, "SKETCH", 0, 0, 0, False, 0, Nothing, 0
    swModel.EditSketch
    swModel.InsertSketch2 True
    swModel.ClearSelection2 True
    swModel.Extension.SelectByID2 skName, "SKETCH", 0, 0, 0, False, 0, Nothing, 0

    ' FeatureCut4 via late-bound Object (avoids compile-time signature crashes)
    ' 27 params. Key: singleDir=True, flip controls direction, endCond=1 for through-all
    Dim fm As Object
    Set fm = swModel.FeatureManager
    Dim cutFeat As Object
    Set cutFeat = fm.FeatureCut4( _
        True, ${flipStr}, False, _
        ${endCond}, CLng(0), _
        CDbl(${depthM}), CDbl(${depthM}), _
        ${draftEnabled}, False, False, False, _
        CDbl(${draftRad}), CDbl(0), _
        False, False, False, False, _
        ${flipSideStr}, False, True, True, True, _
        False, CDbl(0), CDbl(0), False, False)
    Dim err1 As Long: err1 = Err.Number
    If err1 <> 0 Then Err.Clear

    ' If first direction failed, try flipped direction
    If cutFeat Is Nothing Then
        swModel.ClearSelection2 True
        swModel.Extension.SelectByID2 skName, "SKETCH", 0, 0, 0, False, 0, Nothing, 0
        Dim flipOpposite As Boolean: flipOpposite = Not CBool(${flipStr})
        Set cutFeat = fm.FeatureCut4( _
            True, flipOpposite, False, _
            ${endCond}, CLng(0), _
            CDbl(${depthM}), CDbl(${depthM}), _
            ${draftEnabled}, False, False, False, _
            CDbl(${draftRad}), CDbl(0), _
            False, False, False, False, _
            ${flipSideStr}, False, True, True, True, _
            False, CDbl(0), CDbl(0), False, False)
        If Err.Number <> 0 Then Err.Clear
    End If

    swModel.ClearSelection2 True
    swModel.EditRebuild3

    If Not cutFeat Is Nothing Then
        WriteLog "{""success"": true, ""name"": """ & cutFeat.Name & """}"
    Else
        ' Build diagnostic message
        Dim diag As String
        diag = "sketch=" & skName & ", segments=" & segCount & ", sketches=" & sketchCount & ", features=" & featureCount
        If err1 <> 0 Then diag = diag & ", vbaErr=" & err1

        ' Clean up the dangling sketch so it doesn't corrupt future operations
        ' Only delete if this sketch has no associated feature (it's orphaned)
        swModel.Extension.SelectByID2 skName, "SKETCH", 0, 0, 0, False, 0, Nothing, 0
        swModel.EditDelete
        If Err.Number <> 0 Then Err.Clear
        swModel.ClearSelection2 True

        WriteLog "{""error"": ""FeatureCut4 returned Nothing in both directions. " & diag & ". Dangling sketch deleted to prevent state corruption.""}"
    End If
End Sub

Sub WriteLog(msg As String)
    Dim fNum As Integer: fNum = FreeFile
    Open "LOG_PATH_PLACEHOLDER" For Output As #fNum
    Print #fNum, msg
    Close #fNum
End Sub
`;

    const result = runVBAMacro(this, vba);
    if (!result.success) {
      throw new Error(`Cut extrude macro failed: ${result.error || 'unknown error'}`);
    }

    let parsed: any;
    try { parsed = JSON.parse(result.output || ''); } catch { parsed = null; }

    if (parsed?.error) {
      throw new Error(`Cut extrude failed: ${parsed.error}`);
    }
    if (parsed?.name) {
      return { name: parsed.name, type: 'Cut', suppressed: false };
    }

    // Fallback: check feature tree
    let featureName = '';
    try {
      for (let i = 0; i < 3; i++) {
        const feat = this.currentModel.FeatureByPositionReverse(i);
        if (feat) {
          const typeName = feat.GetTypeName2();
          if (typeName === 'ICE' || typeName === 'Cut' || typeName === 'Cut-Extrude') {
            featureName = feat.Name || feat.GetName() || 'Cut-Extrude';
            break;
          }
        }
      }
    } catch (e) {
      logger.warn(`Could not verify cut feature: ${e}`);
    }

    if (!featureName) {
      throw new Error(`Cut macro ran but no feature created. Raw output: ${result.output || 'none'}`);
    }

    return { name: featureName, type: 'Cut', suppressed: false };
  }
}
