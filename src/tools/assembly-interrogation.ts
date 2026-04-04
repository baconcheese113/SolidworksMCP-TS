import { z } from 'zod';
import { SolidWorksAPI } from '../solidworks/api.js';
import { executeRawVBScript, runVBAMacro } from '../utils/vba-executor.js';

/**
 * Assembly Intelligence Tools
 *
 * KEY LESSONS:
 * - VBScript (cscript.exe) CANNOT read Transform2 or index GetComponents() SafeArrays.
 * - VBA macros (.swb via RunMacro) run inside SolidWorks with full type support.
 * - Use runVBAMacro() for anything that needs Transform2, GetComponents, or AddMate5.
 * - VBA output goes through a log file (RunMacro has no stdout).
 */

/**
 * VBA macro that runs inside SolidWorks to read assembly components with
 * full transform, bounding box, and cylinder geometry data.
 * Uses GetComponents() (works in VBA) and Transform2 (works in VBA).
 * Outputs JSON to a log file.
 */
const GET_COMPONENTS_VBA = `
Dim swApp As SldWorks.SldWorks

Sub main()
    Set swApp = Application.SldWorks
    Dim swModel As ModelDoc2
    Set swModel = swApp.ActiveDoc
    If swModel Is Nothing Then
        WriteLog "ERROR: No active document"
        Exit Sub
    End If
    If swModel.GetType <> 2 Then
        WriteLog "ERROR: Active document is not an assembly"
        Exit Sub
    End If

    Dim swAssy As AssemblyDoc
    Set swAssy = swModel
    Dim swMathUtil As MathUtility
    Set swMathUtil = swApp.GetMathUtility

    Dim vComps As Variant
    vComps = swAssy.GetComponents(False)
    If IsEmpty(vComps) Then
        WriteLog "{""assemblyTitle"": """ & JsonEsc(swModel.GetTitle) & """, ""components"": []}"
        Exit Sub
    End If

    Dim msg As String
    msg = "{" & vbCrLf
    msg = msg & """assemblyTitle"": """ & JsonEsc(swModel.GetTitle) & """," & vbCrLf
    msg = msg & """components"": [" & vbCrLf

    Dim i As Long
    For i = 0 To UBound(vComps)
        Dim comp As Component2
        Set comp = vComps(i)

        If i > 0 Then msg = msg & "," & vbCrLf

        Dim cName As String: cName = comp.Name2
        Dim cPath As String: cPath = comp.GetPathName
        Dim cConfig As String: cConfig = comp.ReferencedConfiguration
        Dim cFixed As Boolean: cFixed = comp.IsFixed
        Dim cSuppressed As Boolean: cSuppressed = comp.IsSuppressed

        ' Transform
        Dim tx As Double, ty As Double, tz As Double
        Dim r0 As Double, r1 As Double, r2 As Double
        Dim r3 As Double, r4 As Double, r5 As Double
        Dim r6 As Double, r7 As Double, r8 As Double
        tx = 0: ty = 0: tz = 0
        r0 = 1: r1 = 0: r2 = 0: r3 = 0: r4 = 1: r5 = 0: r6 = 0: r7 = 0: r8 = 1

        Dim xf As MathTransform
        Set xf = comp.Transform2
        If Not xf Is Nothing Then
            Dim d As Variant
            d = xf.ArrayData
            r0 = d(0): r1 = d(1): r2 = d(2)
            r3 = d(3): r4 = d(4): r5 = d(5)
            r6 = d(6): r7 = d(7): r8 = d(8)
            tx = Round(d(9) * 1000, 3)
            ty = Round(d(10) * 1000, 3)
            tz = Round(d(11) * 1000, 3)
        End If

        ' Bounding box
        Dim bboxStr As String: bboxStr = "null"
        Dim bbox As Variant
        bbox = comp.GetBox(False, False)
        If Not IsEmpty(bbox) Then
            bboxStr = "{""min"": {""x"": " & Round(bbox(0) * 1000, 2) & ", ""y"": " & Round(bbox(1) * 1000, 2) & ", ""z"": " & Round(bbox(2) * 1000, 2) & "}"
            bboxStr = bboxStr & ", ""max"": {""x"": " & Round(bbox(3) * 1000, 2) & ", ""y"": " & Round(bbox(4) * 1000, 2) & ", ""z"": " & Round(bbox(5) * 1000, 2) & "}"
            bboxStr = bboxStr & ", ""size"": {""x"": " & Round((bbox(3) - bbox(0)) * 1000, 2) & ", ""y"": " & Round((bbox(4) - bbox(1)) * 1000, 2) & ", ""z"": " & Round((bbox(5) - bbox(2)) * 1000, 2) & "}}"
        End If

        ' Cylinder faces (world coordinates)
        Dim cylStr As String: cylStr = ""
        Dim compBody As Body2
        Set compBody = comp.GetBody
        If Not compBody Is Nothing And Not xf Is Nothing Then
            Dim face As Face2
            Set face = compBody.GetFirstFace
            Do While Not face Is Nothing
                Dim surf As Surface
                Set surf = face.GetSurface
                If surf.IsCylinder Then
                    Dim cp As Variant
                    cp = surf.CylinderParams
                    If Not IsEmpty(cp) Then
                        ' Transform origin and axis to world coords
                        Dim orgArr(2) As Double
                        orgArr(0) = cp(0): orgArr(1) = cp(1): orgArr(2) = cp(2)
                        Dim axArr(2) As Double
                        axArr(0) = cp(3): axArr(1) = cp(4): axArr(2) = cp(5)

                        Dim swOrg As MathPoint
                        Set swOrg = swMathUtil.CreatePoint(orgArr)
                        Dim swAx As MathVector
                        Set swAx = swMathUtil.CreateVector(axArr)
                        Dim wOrg As MathPoint
                        Set wOrg = swOrg.MultiplyTransform(xf)
                        Dim wAx As MathVector
                        Set wAx = swAx.MultiplyTransform(xf)
                        Dim wo As Variant: wo = wOrg.ArrayData
                        Dim wa As Variant: wa = wAx.ArrayData

                        If cylStr <> "" Then cylStr = cylStr & ", "
                        cylStr = cylStr & "{""radius"": " & Round(cp(6) * 1000, 3)
                        cylStr = cylStr & ", ""worldOrigin"": {""x"": " & Round(wo(0) * 1000, 1) & ", ""y"": " & Round(wo(1) * 1000, 1) & ", ""z"": " & Round(wo(2) * 1000, 1) & "}"
                        cylStr = cylStr & ", ""worldAxis"": {""x"": " & Round(wa(0), 4) & ", ""y"": " & Round(wa(1), 4) & ", ""z"": " & Round(wa(2), 4) & "}}"
                    End If
                End If
                Set face = face.GetNextFace
            Loop
        End If

        msg = msg & "{"
        msg = msg & """name"": """ & JsonEsc(cName) & """, "
        msg = msg & """path"": """ & JsonEsc(cPath) & """, "
        msg = msg & """configurationName"": """ & JsonEsc(cConfig) & """, "
        msg = msg & """suppressed"": " & LCase(CStr(cSuppressed)) & ", "
        msg = msg & """fixed"": " & LCase(CStr(cFixed)) & ", "
        msg = msg & """position"": {""x"": " & tx & ", ""y"": " & ty & ", ""z"": " & tz & "}, "
        msg = msg & """rotation"": [" & Round(r0, 6) & "," & Round(r1, 6) & "," & Round(r2, 6) & "," & Round(r3, 6) & "," & Round(r4, 6) & "," & Round(r5, 6) & "," & Round(r6, 6) & "," & Round(r7, 6) & "," & Round(r8, 6) & "], "
        msg = msg & """boundingBox"": " & bboxStr & ", "
        msg = msg & """cylinders"": [" & cylStr & "]"
        msg = msg & "}"
    Next i

    msg = msg & vbCrLf & "]" & vbCrLf & "}"

    WriteLog msg
End Sub

Function JsonEsc(s As String) As String
    Dim r As String: r = s
    r = Replace(r, "\\", "\\\\")
    r = Replace(r, """", "\\""")
    r = Replace(r, vbCr, "")
    r = Replace(r, vbLf, "")
    JsonEsc = r
End Function

Sub WriteLog(msg As String)
    Dim fNum As Integer: fNum = FreeFile
    Open "LOG_PATH_PLACEHOLDER" For Output As #fNum
    Print #fNum, msg
    Close #fNum
End Sub
`;

/**
 * Convert a 3x3 rotation matrix [r0..r8] to human-readable euler angles (degrees).
 * Uses ZYX convention. Returns object with x, y, z angles rounded to nearest degree.
 */
function rotationToEulerDeg(rot: number[]): { x: number; y: number; z: number } {
  const sy = Math.sqrt(rot[0] * rot[0] + rot[3] * rot[3]);
  const singular = sy < 1e-6;
  let rx: number, ry: number, rz: number;
  if (!singular) {
    rx = Math.atan2(rot[5], rot[8]);
    ry = Math.atan2(-rot[2], sy);
    rz = Math.atan2(rot[1], rot[0]);
  } else {
    rx = Math.atan2(-rot[7], rot[4]);
    ry = Math.atan2(-rot[2], sy);
    rz = 0;
  }
  const toDeg = (rad: number) => Math.round(rad * 180 / Math.PI);
  return { x: toDeg(rx), y: toDeg(ry), z: toDeg(rz) };
}

/**
 * Format euler angles as a compact human-readable string.
 * Returns "none" for identity rotation.
 */
function describeOrientation(rot: number[]): string {
  const angles = rotationToEulerDeg(rot);
  const parts: string[] = [];
  if (angles.x !== 0) parts.push(`X:${angles.x}°`);
  if (angles.y !== 0) parts.push(`Y:${angles.y}°`);
  if (angles.z !== 0) parts.push(`Z:${angles.z}°`);
  return parts.length > 0 ? parts.join(' ') : 'none';
}

export const assemblyInterrogationTools = [
  {
    name: 'get_assembly_components',
    description: 'Get component data from an assembly. detail_level controls output: "summary" = unique parts with qty + sizes (~500B). "compact" = per-instance position, orientation (euler angles), bbox, fixed/suppressed (~3KB). "full" = adds raw rotation matrix + full bbox min/max per instance (~10KB). Use topLevelOnly=true to skip sub-assembly children.',
    inputSchema: z.object({
      maxDepth: z.number().default(10).describe('Maximum recursion depth for sub-assemblies'),
      detail_level: z.enum(['summary', 'compact', 'full']).default('compact').describe('Output detail level'),
      topLevelOnly: z.boolean().default(false).describe('Only return top-level components (skip sub-assembly children)')
    }),
    handler: (args: any, swApi: SolidWorksAPI) => {
      const result = runVBAMacro(swApi, GET_COMPONENTS_VBA);

      if (!result.success) {
        throw new Error(`get_assembly_components failed: ${result.error || result.output}`);
      }

      // Parse the JSON output from the VBA macro log
      try {
        const parsed = JSON.parse(result.output || '{}');
        let components = parsed.components || [];
        const detailLevel = args.detail_level || 'compact';

        // Filter to top-level only if requested (components without "/" in name)
        if (args.topLevelOnly) {
          components = components.filter((c: any) => !c.name.includes('/'));
        }

        // Build summary (always computed)
        const pathMap = new Map<string, { path: string; config: string; quantity: number; names: string[]; firstBbox: any }>();
        for (const comp of components) {
          if (comp.path) {
            const key = `${comp.path}|${comp.configurationName}`;
            const existing = pathMap.get(key);
            if (existing) {
              existing.quantity++;
              existing.names.push(comp.name);
            } else {
              pathMap.set(key, {
                path: comp.path,
                config: comp.configurationName,
                quantity: 1,
                names: [comp.name],
                firstBbox: comp.boundingBox
              });
            }
          }
        }

        const uniqueParts = Array.from(pathMap.values()).map(v => {
          const fileName = v.path.replace(/^.*[\\/]/, '');
          const entry: any = {
            name: fileName,
            configuration: v.config,
            quantity: v.quantity,
          };
          if (v.firstBbox?.size) {
            entry.size_mm = v.firstBbox.size;
          }
          if (detailLevel !== 'summary') {
            entry.instanceNames = v.names;
          }
          return entry;
        });

        const summary = {
          assemblyTitle: parsed.assemblyTitle || '',
          totalInstances: components.length,
          uniqueComponents: uniqueParts.length,
          components: uniqueParts
        };

        if (detailLevel === 'summary') {
          return summary;
        }

        if (detailLevel === 'compact') {
          // Per-instance data with human-readable orientation, no raw matrices or cylinders
          const compactComponents = components.map((comp: any) => {
            const entry: any = {
              name: comp.name,
              position: comp.position,
              suppressed: comp.suppressed,
              fixed: comp.fixed,
            };
            if (comp.boundingBox?.size) {
              entry.size_mm = comp.boundingBox.size;
            }
            // Decode rotation matrix to euler angles
            if (comp.rotation && Array.isArray(comp.rotation)) {
              entry.orientation = describeOrientation(comp.rotation);
            }
            return entry;
          });

          return {
            ...summary,
            instances: compactComponents
          };
        }

        // Full detail — rotation matrix + full bbox, but NO cylinder geometry (too large)
        const fullComponents = components.map((comp: any) => {
          const entry: any = {
            name: comp.name,
            path: comp.path,
            configurationName: comp.configurationName,
            suppressed: comp.suppressed,
            fixed: comp.fixed,
            position: comp.position,
            rotation: comp.rotation,
            boundingBox: comp.boundingBox,
          };
          // Include decoded orientation for readability
          if (comp.rotation && Array.isArray(comp.rotation)) {
            entry.orientation = describeOrientation(comp.rotation);
          }
          return entry;
        });

        return {
          assemblyTitle: parsed.assemblyTitle || '',
          totalInstances: components.length,
          uniqueComponents: uniqueParts.length,
          summary: uniqueParts,
          instances: fullComponents
        };
      } catch (parseErr) {
        return {
          assemblyTitle: '',
          components: [],
          rawOutput: result.output,
          parseError: String(parseErr)
        };
      }
    }
  },

  {
    name: 'extract_bom',
    description: 'Extract a structured Bill of Materials from an assembly, including custom properties from each component',
    inputSchema: z.object({
      propertyNames: z.array(z.string()).default(['PartNumber', 'Description', 'Material', 'Cost', 'Vendor']).describe('Custom property names to read from each component'),
      format: z.enum(['json', 'csv']).default('json')
    }),
    handler: (args: any, _swApi: SolidWorksAPI) => {
      // Build VBScript that walks tree AND reads custom properties
      const propsArray = args.propertyNames.map((p: string) => `"${p}"`).join(', ');

      const vbs = `
Dim swModel
Set swModel = swApp.ActiveDoc
If swModel Is Nothing Then
    WScript.Echo "ERROR: No active document"
    WScript.Quit 1
End If
If swModel.GetType <> 2 Then
    WScript.Echo "ERROR: Active document is not an assembly"
    WScript.Quit 1
End If

On Error Resume Next

' Property names to read
Dim propNames
propNames = Array(${propsArray})

' Collect unique components by walking feature tree
Dim pathDict
Set pathDict = CreateObject("Scripting.Dictionary")

Dim feat
Set feat = swModel.FirstFeature
Do While Not feat Is Nothing
    Dim typeName
    typeName = feat.GetTypeName2
    If Err.Number <> 0 Then Err.Clear

    If typeName = "Reference" Then
        Dim comp
        Set comp = feat.GetSpecificFeature2
        If Err.Number <> 0 Then Err.Clear

        If Not comp Is Nothing Then
            Dim cPath, cConfig
            cPath = comp.GetPathName
            If Err.Number <> 0 Then cPath = "" : Err.Clear
            cConfig = comp.ReferencedConfiguration
            If Err.Number <> 0 Then cConfig = "" : Err.Clear

            If cPath <> "" Then
                Dim dictKey
                dictKey = cPath & "|" & cConfig
                If pathDict.Exists(dictKey) Then
                    pathDict(dictKey)("qty") = pathDict(dictKey)("qty") + 1
                Else
                    Dim newEntry
                    Set newEntry = CreateObject("Scripting.Dictionary")
                    newEntry.Add "path", cPath
                    newEntry.Add "config", cConfig
                    newEntry.Add "qty", 1
                    pathDict.Add dictKey, newEntry
                End If
            End If
        End If
    End If

    Set feat = feat.GetNextFeature
    If Err.Number <> 0 Then Err.Clear : Set feat = Nothing
Loop

' Output BOM
WScript.Echo "{"
WScript.Echo """assemblyTitle"": """ & Replace(swModel.GetTitle, """", "'") & ""","
WScript.Echo """bom"": ["

Dim firstEntry
firstEntry = True
Dim itemNum
itemNum = 1
Dim key
For Each key In pathDict.Keys
    Dim entry
    Set entry = pathDict(key)

    If Not firstEntry Then WScript.Echo ","
    firstEntry = False

    Dim fileName
    fileName = entry("path")
    Dim pos
    pos = InStrRev(fileName, "\\")
    If pos > 0 Then fileName = Mid(fileName, pos + 1)

    WScript.Echo "{"
    WScript.Echo """item"": " & itemNum & ","
    WScript.Echo """fileName"": """ & Replace(fileName, """", "'") & ""","
    WScript.Echo """path"": """ & Replace(Replace(entry("path"), "\\", "\\\\"), """", "'") & ""","
    WScript.Echo """configuration"": """ & Replace(entry("config"), """", "'") & ""","
    WScript.Echo """quantity"": " & entry("qty") & ","

    ' Read custom properties from the component document
    Dim compModel
    Set compModel = Nothing
    Set compModel = swApp.GetOpenDocumentByName(entry("path"))
    If Err.Number <> 0 Then Err.Clear

    If compModel Is Nothing Then
        Dim compDocType
        compDocType = 1
        If InStr(LCase(entry("path")), ".sldasm") > 0 Then compDocType = 2
        Set compModel = swApp.OpenDoc(entry("path"), compDocType)
        If Err.Number <> 0 Then Err.Clear
    End If

    WScript.Echo """properties"": {"
    Dim firstProp
    firstProp = True
    Dim p
    For Each p In propNames
        If Not firstProp Then WScript.Echo ","
        firstProp = False

        Dim propVal
        propVal = ""
        If Not compModel Is Nothing Then
            ' Try document-level properties first, then config-specific
            Dim propMgr
            Set propMgr = compModel.Extension.CustomPropertyManager("")
            If Not propMgr Is Nothing Then
                propVal = propMgr.Get(p)
                If Err.Number <> 0 Then propVal = "" : Err.Clear
            End If
            ' If empty, try config-specific
            If propVal = "" Then
                Set propMgr = compModel.Extension.CustomPropertyManager(entry("config"))
                If Not propMgr Is Nothing Then
                    propVal = propMgr.Get(p)
                    If Err.Number <> 0 Then propVal = "" : Err.Clear
                End If
            End If
        End If
        WScript.Echo """" & p & """: """ & Replace(propVal, """", "'") & """"
    Next
    WScript.Echo "}"

    WScript.Echo "}"
    itemNum = itemNum + 1
Next

WScript.Echo "]"
WScript.Echo "}"
`;

      const result = executeRawVBScript(vbs);
      if (!result.success) {
        throw new Error(`extract_bom failed: ${result.error || result.output}`);
      }

      try {
        const parsed = JSON.parse(result.output || '{}');

        if (args.format === 'csv') {
          const bomEntries = parsed.bom || [];
          const headers = ['Item', 'FileName', 'Quantity', ...args.propertyNames];
          const csvLines = [headers.join(',')];
          for (const row of bomEntries) {
            const values = [
              row.item,
              `"${row.fileName}"`,
              row.quantity,
              ...args.propertyNames.map((p: string) => `"${(row.properties?.[p] || '').replace(/"/g, '""')}"`)
            ];
            csvLines.push(values.join(','));
          }
          return csvLines.join('\n');
        }

        return {
          assemblyTitle: parsed.assemblyTitle || '',
          totalLineItems: (parsed.bom || []).length,
          totalParts: (parsed.bom || []).reduce((sum: number, r: any) => sum + r.quantity, 0),
          bom: parsed.bom || []
        };
      } catch (parseErr) {
        return {
          rawOutput: result.output,
          parseError: String(parseErr)
        };
      }
    }
  }
];
