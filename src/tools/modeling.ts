import { z } from 'zod';
import type { SolidWorksAPI } from '../solidworks/api.js';
import { runVBAMacro } from '../utils/vba-executor.js';

export const modelingTools = [
  {
    name: 'open_model',
    description: 'REQUIRES WINDOWS + SOLIDWORKS. Open a SolidWorks file (.sldprt, .sldasm, .slddrw) or import a foreign CAD file (.step, .stp, .iges, .igs, .x_t, .sat) in the running SolidWorks instance. Foreign formats are imported as parts. The file must exist on the local filesystem.',
    inputSchema: z.object({
      path: z.string().describe('Full path to the file (.sldprt, .sldasm, .slddrw, .step, .stp, .iges, .igs, .x_t, .sat)'),
    }),
    handler: (args: any, swApi: SolidWorksAPI) => {
      try {
        const model = swApi.openModel(args.path);
        return `Opened ${model.type}: ${model.name}`;
      } catch (error) {
        return `Failed to open model: ${error}`;
      }
    },
  },

  {
    name: 'create_part',
    description: 'REQUIRES WINDOWS + SOLIDWORKS. Create a new empty part document (.sldprt). This is typically the first step before create_sketch.',
    inputSchema: z.object({}),
    handler: (_args: any, swApi: SolidWorksAPI) => {
      try {
        const model = swApi.createPart();
        return `Created new part: ${model.name}`;
      } catch (error) {
        return `Failed to create part: ${error}`;
      }
    },
  },

  {
    name: 'close_model',
    description: 'REQUIRES WINDOWS + SOLIDWORKS. Close the active document, optionally saving first.',
    inputSchema: z.object({
      save: z.boolean().default(false).describe('Save before closing'),
    }),
    handler: (args: any, swApi: SolidWorksAPI) => {
      try {
        // FIX: Safely handle model closing
        const currentModel = swApi.getCurrentModel();
        if (!currentModel) {
          return 'No active model to close';
        }

        // Get title safely before closing
        let modelTitle = 'Unknown';
        try {
          if (currentModel.GetTitle) {
            modelTitle = currentModel.GetTitle();
          } else if (currentModel.GetPathName) {
            const path = currentModel.GetPathName();
            modelTitle = path ? path.split('\\').pop() || 'Unknown' : 'Unknown';
          }
        } catch (_e) {
          // Title might not be available
        }

        swApi.closeModel(args.save);
        return `Model "${modelTitle}" closed successfully`;
      } catch (error) {
        return `Failed to close model: ${error}`;
      }
    },
  },

  {
    name: 'create_extrusion',
    description: 'REQUIRES WINDOWS + SOLIDWORKS. Create a boss-extrude from the most recent closed sketch. You must close the sketch first (exit_sketch). If multiple sketches exist, the last one created is used. For complex extrusions with many parameters, use create_feature_vba to generate VBA code instead.',
    inputSchema: z.object({
      depth: z.number().describe('Extrusion depth in mm'),
      draft: z.number().default(0).describe('Draft angle in degrees'),
      reverse: z.boolean().default(false).describe('Reverse direction'),
    }),
    handler: (args: any, swApi: SolidWorksAPI) => {
      try {
        const feature = swApi.createExtrude(args.depth, args.draft, args.reverse);
        return `Created extrusion: ${feature.name}`;
      } catch (error) {
        return `Failed to create extrusion: ${error}`;
      }
    },
  },

  {
    name: 'get_dimension',
    description: 'REQUIRES WINDOWS + SOLIDWORKS. Read a named dimension value (e.g. "D1@Sketch1") from the active model. Use get_feature_tree to discover dimension names.',
    inputSchema: z.object({
      name: z.string().describe('Dimension name (e.g., "D1@Sketch1")'),
    }),
    handler: (args: any, swApi: SolidWorksAPI) => {
      try {
        const value = swApi.getDimension(args.name);
        return `Dimension ${args.name} = ${value} mm`;
      } catch (error) {
        return `Failed to get dimension: ${error}`;
      }
    },
  },

  {
    name: 'set_dimension',
    description: 'REQUIRES WINDOWS + SOLIDWORKS. Change a named dimension value in the active model. Call rebuild_model afterward to update geometry.',
    inputSchema: z.object({
      name: z.string().describe('Dimension name (e.g., "D1@Sketch1")'),
      value: z.number().describe('New value in mm'),
    }),
    handler: (args: any, swApi: SolidWorksAPI) => {
      try {
        swApi.setDimension(args.name, args.value);
        return `Set dimension ${args.name} = ${args.value} mm`;
      } catch (error) {
        return `Failed to set dimension: ${error}`;
      }
    },
  },

  {
    name: 'rebuild_model',
    description: 'REQUIRES WINDOWS + SOLIDWORKS. Force a rebuild of the active model to update all features after dimension or property changes.',
    inputSchema: z.object({
      force: z.boolean().default(false).describe('Force rebuild even if not needed'),
    }),
    handler: (args: any, swApi: SolidWorksAPI) => {
      try {
        const model = swApi.getCurrentModel();
        if (!model) throw new Error('No model open');

        // FIX: Use correct SolidWorks API methods
        let success = false;

        if (args.force) {
          // Use ForceRebuild3 for forced rebuild
          try {
            success = model.ForceRebuild3(false); // false = top level only
          } catch (_e) {
            // If ForceRebuild3 doesn't exist, try ForceRebuild
            try {
              model.ForceRebuild();
              success = true;
            } catch (_e2) {
              // Fall back to EditRebuild
              success = model.EditRebuild();
            }
          }
        } else {
          // Use EditRebuild for normal rebuild
          try {
            success = model.EditRebuild();
          } catch (_e) {
            // Try alternative methods
            try {
              model.Rebuild(1); // 1 = swRebuildAll
              success = true;
            } catch (_e2) {
              throw new Error('Rebuild method not available');
            }
          }
        }

        if (!success && success !== undefined) {
          throw new Error('Rebuild failed');
        }

        return 'Model rebuilt successfully';
      } catch (error) {
        return `Failed to rebuild model: ${error}`;
      }
    },
  },

  {
    name: 'save_model',
    description: 'REQUIRES WINDOWS + SOLIDWORKS. Save the active document. If path is provided, does Save As to that location. If omitted, saves in place. All save-as paths must be under C:\\Eng Vault\\Sandbox\\JYannessa\\. WARNING: Saving to a PDM vault path may trigger a data card dialog that blocks until the user clicks OK.',
    inputSchema: z.object({
      path: z.string().optional().describe('Full path for Save As (e.g. C:\\Eng Vault\\Sandbox\\JYannessa\\MyPart.sldprt). Omit to save in place.'),
    }),
    handler: (args: any, swApi: SolidWorksAPI) => {
      try {
        const result = swApi.saveModel(args.path);
        return result;
      } catch (error) {
        return `Failed to save model: ${error}`;
      }
    },
  },

  {
    name: 'cut_extrude',
    description: 'REQUIRES WINDOWS + SOLIDWORKS. Create a cut-extrude from the most recent closed sketch (exit_sketch first). Removes material instead of adding it. Automatically tries both cut directions if the first attempt fails. Use throughAll=true for holes — it avoids depth calculation issues.',
    inputSchema: z.object({
      depth: z.number().default(10).describe('Cut depth in mm (ignored if throughAll is true)'),
      throughAll: z.boolean().default(false).describe('Cut through the entire body'),
      reverse: z.boolean().default(false).describe('Reverse cut direction'),
      draft: z.number().default(0).describe('Draft angle in degrees'),
      flipSide: z.boolean().default(false).describe('Flip side to cut'),
    }),
    handler: (args: any, swApi: SolidWorksAPI) => {
      try {
        const feature = swApi.createCutExtrude(
          args.depth,
          args.throughAll,
          args.reverse,
          args.draft,
          args.flipSide
        );
        return `Created cut extrusion: ${feature.name}`;
      } catch (error) {
        return `Failed to create cut extrusion: ${error}`;
      }
    },
  },

  {
    name: 'create_revolve',
    description: 'REQUIRES WINDOWS + SOLIDWORKS. Revolve the most recent sketch around its centerline to create a solid of revolution (boss or cut). CRITICAL: The sketch MUST contain both a closed profile AND a construction centerline (use sketch_centerline) as the revolve axis — revolve fails without both. Call exit_sketch before this.',
    inputSchema: z.object({
      angle: z.number().default(360).describe('Revolve angle in degrees (default 360 for full revolution)'),
      cut: z.boolean().default(false).describe('True for cut-revolve (remove material), false for boss-revolve'),
    }),
    handler: (args: any, swApi: SolidWorksAPI) => {
      const angleVal = args.angle || 360;
      const isCut = args.cut ? 'True' : 'False';
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

    Dim swFeat As Feature
    Dim lastSketch As Feature
    Set swFeat = swModel.FirstFeature
    Do While Not swFeat Is Nothing
        If swFeat.GetTypeName2 = "ProfileFeature" Then Set lastSketch = swFeat
        Set swFeat = swFeat.GetNextFeature
        If Err.Number <> 0 Then Err.Clear: Set swFeat = Nothing
    Loop

    If lastSketch Is Nothing Then
        WriteLog "{""error"": ""No sketch found in feature tree""}"
        Exit Sub
    End If

    Dim sketchName As String: sketchName = lastSketch.Name

    swModel.ClearSelection2 True
    swModel.Extension.SelectByID2 sketchName, "SKETCH", 0, 0, 0, False, 0, Nothing, 0
    swModel.EditSketch
    swModel.InsertSketch2 True
    swModel.ClearSelection2 True
    swModel.Extension.SelectByID2 sketchName, "SKETCH", 0, 0, 0, False, 0, Nothing, 0

    Dim angleRad As Double
    angleRad = ${angleVal} * 3.14159265358979 / 180#

    Dim fm As Object
    Set fm = swModel.FeatureManager
    Dim swRevFeat As Object
    Set swRevFeat = fm.FeatureRevolve2(True, True, False, ${isCut}, False, False, 0, 0, angleRad, 0, False, False, 0, 0, 0, 0, 0, True, True, True)
    If Err.Number <> 0 Then Err.Clear

    On Error GoTo 0
    If Not swRevFeat Is Nothing Then
        WriteLog "{""success"": true, ""featureName"": """ & swRevFeat.Name & """, ""sketchUsed"": """ & sketchName & """, ""angle"": ${angleVal}}"
    Else
        WriteLog "{""error"": ""FeatureRevolve2 failed. Ensure sketch has a closed profile and a centerline."", ""sketchUsed"": """ & sketchName & """}"
    End If
End Sub

Sub WriteLog(msg As String)
    Dim fNum As Integer: fNum = FreeFile
    Open "LOG_PATH_PLACEHOLDER" For Output As #fNum
    Print #fNum, msg
    Close #fNum
End Sub
`;
      const result = runVBAMacro(swApi, vba);
      if (!result.success) throw new Error(`create_revolve failed: ${result.error}`);
      try { return JSON.parse(result.output || '{}'); } catch { return { rawOutput: result.output }; }
    }
  },

  {
    name: 'create_reference_plane',
    description: 'REQUIRES WINDOWS + SOLIDWORKS. Create an offset reference plane from an existing plane (Front Plane, Top Plane, Right Plane, or a named custom plane).',
    inputSchema: z.object({
      referencePlane: z.string().default('Front Plane').describe('Name of the plane to offset from'),
      offset: z.number().describe('Offset distance in mm'),
      flip: z.boolean().default(false).describe('Flip offset direction'),
    }),
    handler: (args: any, swApi: SolidWorksAPI) => {
      const offsetM = (args.flip ? -args.offset : args.offset) / 1000;
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

    swModel.ClearSelection2 True
    swModel.Extension.SelectByID2 "${args.referencePlane}", "PLANE", 0, 0, 0, False, 0, Nothing, 0

    Dim selCount As Long
    selCount = swModel.SelectionManager.GetSelectedObjectCount2(-1)
    If selCount = 0 Then
        Dim swFeat As Feature
        Set swFeat = swModel.FirstFeature
        Do While Not swFeat Is Nothing
            If swFeat.GetTypeName2 = "RefPlane" And swFeat.Name = "${args.referencePlane}" Then
                swModel.ClearSelection2 True
                swFeat.Select2 False, 0
                selCount = swModel.SelectionManager.GetSelectedObjectCount2(-1)
                Exit Do
            End If
            Set swFeat = swFeat.GetNextFeature
            If Err.Number <> 0 Then Err.Clear: Set swFeat = Nothing
        Loop
    End If

    If selCount = 0 Then
        WriteLog "{""error"": ""Could not select plane '${args.referencePlane}'""}"
        Exit Sub
    End If

    On Error GoTo 0
    Dim fm As Object
    Set fm = swModel.FeatureManager
    Dim swPlaneFeat As Feature
    Set swPlaneFeat = fm.InsertRefPlane(4, ${offsetM}, 0, 0, 0, 0)

    If Not swPlaneFeat Is Nothing Then
        WriteLog "{""success"": true, ""featureName"": """ & swPlaneFeat.Name & """, ""referencePlane"": ""${args.referencePlane}"", ""offset_mm"": ${args.offset}}"
    Else
        WriteLog "{""error"": ""InsertRefPlane failed"", ""referencePlane"": ""${args.referencePlane}""}"
    End If
End Sub

Sub WriteLog(msg As String)
    Dim fNum As Integer: fNum = FreeFile
    Open "LOG_PATH_PLACEHOLDER" For Output As #fNum
    Print #fNum, msg
    Close #fNum
End Sub
`;
      const result = runVBAMacro(swApi, vba);
      if (!result.success) throw new Error(`create_reference_plane failed: ${result.error}`);
      try { return JSON.parse(result.output || '{}'); } catch { return { rawOutput: result.output }; }
    }
  },

  {
    name: 'create_fillet',
    description: 'REQUIRES WINDOWS + SOLIDWORKS. Add a constant-radius fillet to edges on the active part. Specify edge locations as x,y,z coordinates in mm — coordinates must be within ~1mm of actual edge midpoints. Use get_bounding_box or get_part_faces first to discover edge locations if unsure.',
    inputSchema: z.object({
      radius: z.number().describe('Fillet radius in mm'),
      edgePoints: z.array(z.object({
        x: z.number().describe('X coordinate in mm near the edge'),
        y: z.number().describe('Y coordinate in mm near the edge'),
        z: z.number().default(0).describe('Z coordinate in mm near the edge'),
      })).describe('Points near the edges to fillet (each point selects the closest edge)'),
    }),
    handler: (args: any, swApi: SolidWorksAPI) => {
      const radiusM = args.radius / 1000;
      const edgeSelections = args.edgePoints.map((pt: any, i: number) => {
        const xM = pt.x / 1000;
        const yM = pt.y / 1000;
        const zM = (pt.z || 0) / 1000;
        const append = i > 0 ? 'True' : 'False';
        return `swModel.Extension.SelectByID2 "", "EDGE", ${xM}, ${yM}, ${zM}, ${append}, 1, Nothing, 0`;
      }).join('\n    ');

      const vba = `
Dim swApp As SldWorks.SldWorks

Sub main()
    Set swApp = Application.SldWorks
    Dim swModel As ModelDoc2
    Set swModel = swApp.ActiveDoc
    If swModel Is Nothing Then
        WriteLog "{""error"": ""No active document""}"
        Exit Sub
    End If

    swModel.ClearSelection2 True
    ${edgeSelections}

    Dim selCount As Long
    selCount = swModel.SelectionManager.GetSelectedObjectCount2(-1)

    If selCount = 0 Then
        WriteLog "{""error"": ""No edges found at specified coordinates""}"
        Exit Sub
    End If

    On Error Resume Next
    Dim fm As Object
    Set fm = swModel.FeatureManager
    Dim swFeat As Object
    Set swFeat = fm.FeatureFillet3(195, ${radiusM}, 0#, 0#, 0, 0, 0, 0, 0#, 0#, 0#, 0#, 0#)
    If Err.Number <> 0 Then Err.Clear
    On Error GoTo 0

    If Not swFeat Is Nothing Then
        WriteLog "{""success"": true, ""featureName"": """ & swFeat.Name & """, ""radius_mm"": ${args.radius}, ""edgesSelected"": " & selCount & "}"
    Else
        WriteLog "{""error"": ""FeatureFillet3 failed"", ""radius_mm"": ${args.radius}, ""edgesSelected"": " & selCount & "}"
    End If
End Sub

Sub WriteLog(msg As String)
    Dim fNum As Integer: fNum = FreeFile
    Open "LOG_PATH_PLACEHOLDER" For Output As #fNum
    Print #fNum, msg
    Close #fNum
End Sub
`;
      const result = runVBAMacro(swApi, vba);
      if (!result.success) throw new Error(`create_fillet failed: ${result.error}`);
      try { return JSON.parse(result.output || '{}'); } catch { return { rawOutput: result.output }; }
    }
  },

  {
    name: 'create_chamfer',
    description: 'REQUIRES WINDOWS + SOLIDWORKS. Add a chamfer to edges on the active part. Specify edge locations as x,y,z coordinates in mm — coordinates must be within ~1mm of actual edge midpoints. Use get_bounding_box or get_part_faces first to discover edge locations if unsure.',
    inputSchema: z.object({
      distance: z.number().describe('Chamfer distance in mm'),
      angle: z.number().default(45).describe('Chamfer angle in degrees (for angle-distance mode)'),
      mode: z.enum(['equal_distance', 'angle_distance']).default('equal_distance').describe('Chamfer mode'),
      edgePoints: z.array(z.object({
        x: z.number().describe('X coordinate in mm near the edge'),
        y: z.number().describe('Y coordinate in mm near the edge'),
        z: z.number().default(0).describe('Z coordinate in mm near the edge'),
      })).describe('Points near the edges to chamfer'),
    }),
    handler: (args: any, swApi: SolidWorksAPI) => {
      const distM = args.distance / 1000;
      const angleRad = (args.angle || 45) * Math.PI / 180;
      const chamferType = args.mode === 'angle_distance' ? 2 : 0;
      const edgeSelections = args.edgePoints.map((pt: any, i: number) => {
        const xM = pt.x / 1000;
        const yM = pt.y / 1000;
        const zM = (pt.z || 0) / 1000;
        const append = i > 0 ? 'True' : 'False';
        return `swModel.Extension.SelectByID2 "", "EDGE", ${xM}, ${yM}, ${zM}, ${append}, 1, Nothing, 0`;
      }).join('\n    ');

      const vba = `
Dim swApp As SldWorks.SldWorks

Sub main()
    Set swApp = Application.SldWorks
    Dim swModel As ModelDoc2
    Set swModel = swApp.ActiveDoc
    If swModel Is Nothing Then
        WriteLog "{""error"": ""No active document""}"
        Exit Sub
    End If

    swModel.ClearSelection2 True
    ${edgeSelections}

    Dim selCount As Long
    selCount = swModel.SelectionManager.GetSelectedObjectCount2(-1)

    If selCount = 0 Then
        WriteLog "{""error"": ""No edges found at specified coordinates""}"
        Exit Sub
    End If

    On Error Resume Next
    Dim fm As Object
    Set fm = swModel.FeatureManager
    Dim swFeat As Object
    Set swFeat = fm.InsertFeatureChamfer(4, ${chamferType}, ${distM}, ${angleRad}, ${distM}, 0#, 0#, 0#)
    If Err.Number <> 0 Then Err.Clear
    On Error GoTo 0

    If Not swFeat Is Nothing Then
        WriteLog "{""success"": true, ""featureName"": """ & swFeat.Name & """, ""distance_mm"": ${args.distance}, ""edgesSelected"": " & selCount & "}"
    Else
        WriteLog "{""error"": ""InsertFeatureChamfer failed"", ""distance_mm"": ${args.distance}, ""edgesSelected"": " & selCount & "}"
    End If
End Sub

Sub WriteLog(msg As String)
    Dim fNum As Integer: fNum = FreeFile
    Open "LOG_PATH_PLACEHOLDER" For Output As #fNum
    Print #fNum, msg
    Close #fNum
End Sub
`;
      const result = runVBAMacro(swApi, vba);
      if (!result.success) throw new Error(`create_chamfer failed: ${result.error}`);
      try { return JSON.parse(result.output || '{}'); } catch { return { rawOutput: result.output }; }
    }
  },

];
