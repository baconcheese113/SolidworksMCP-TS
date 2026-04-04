import { z } from 'zod';
import { SolidWorksAPI } from '../solidworks/api.js';

/**
 * Model Interrogation & Custom Property Tools
 * Direct COM operations for reading/writing properties, feature tree, and document info.
 */

export const getCustomPropertiesTool = {
    name: 'get_custom_properties',
    description: 'REQUIRES WINDOWS + SOLIDWORKS. Read all custom properties from the active document. For bulk property management across many files, use vba_custom_properties to generate a VBA macro instead.',
    inputSchema: z.object({
      configuration: z.string().optional().describe('Configuration name (empty string or omit for document-level properties)')
    }),
    handler: (args: any, swApi: SolidWorksAPI) => {
      const model = swApi.getCurrentModel();
      if (!model) throw new Error('No active document');

      const configName = args.configuration ?? '';
      const propMgr = model.Extension.CustomPropertyManager(configName);

      const names = propMgr.GetNames();
      if (!names || (Array.isArray(names) && names.length === 0)) {
        return {
          configuration: configName || '(document-level)',
          properties: [],
          count: 0
        };
      }

      const nameArray: string[] = (Array.isArray(names) ? names : [names]).map((n: any) => String(n));
      const properties: Array<{ name: string; value: string; evaluatedValue: string; type: number }> = [];

      for (const name of nameArray) {
        try {
          const rawVal = propMgr.Get(name);
          const value = String(rawVal ?? '');
          let propType = 0;
          try { propType = Number(propMgr.GetType2(name)); } catch { /* ignore */ }
          properties.push({
            name: String(name),
            value,
            evaluatedValue: value,
            type: propType
          });
        } catch {
          properties.push({ name: String(name), value: '(read error)', evaluatedValue: '', type: 0 });
        }
      }

      return {
        configuration: configName || '(document-level)',
        properties,
        count: properties.length
      };
    }
  };

export const setCustomPropertiesTool = {
    name: 'set_custom_properties',
    description: 'REQUIRES WINDOWS + SOLIDWORKS. Write custom properties to the active document. For bulk property updates across many files, use vba_custom_properties to generate a VBA macro instead.',
    inputSchema: z.object({
      properties: z.array(z.object({
        name: z.string(),
        value: z.string(),
        type: z.enum(['text', 'number', 'date', 'yesno']).default('text')
      })).min(1),
      configuration: z.string().optional().describe('Configuration name (empty string or omit for document-level)')
    }),
    handler: (args: any, swApi: SolidWorksAPI) => {
      const model = swApi.getCurrentModel();
      if (!model) throw new Error('No active document');

      const configName = args.configuration ?? '';
      const propMgr = model.Extension.CustomPropertyManager(configName);

      const typeMap: Record<string, number> = {
        text: 30,    // swCustomInfoText
        number: 30,  // swCustomInfoNumber (same underlying)
        date: 64,    // swCustomInfoDate
        yesno: 11    // swCustomInfoYesOrNo
      };

      const results: Array<{ name: string; status: string }> = [];

      for (const prop of args.properties) {
        const swType = typeMap[prop.type] || 30;
        try {
          // Add3: name, fieldType, value, overwriteExisting (2 = replace)
          const ret = propMgr.Add3(prop.name, swType, prop.value, 2);
          results.push({
            name: prop.name,
            status: ret !== undefined ? 'set' : 'set (unconfirmed)'
          });
        } catch (error) {
          results.push({ name: prop.name, status: `error: ${error}` });
        }
      }

      return {
        configuration: configName || '(document-level)',
        results
      };
    }
  };

export const getFeatureTreeTool = {
    name: 'get_feature_tree',
    description: 'REQUIRES WINDOWS + SOLIDWORKS. Walk the feature tree and return every feature with its type, name, suppression state, dimensions, and child features. Useful for discovering dimension names before calling get_dimension or set_dimension, and for verifying that features were created correctly.',
    inputSchema: z.object({
      includeSuppressionState: z.boolean().default(true),
      includeDimensions: z.boolean().default(true).describe('Include dimension names and values for each feature'),
      maxFeatures: z.number().default(500).describe('Maximum features to return'),
      skipSystemFeatures: z.boolean().default(false).describe('Skip Origin, planes, axes, and system folders to reduce noise')
    }),
    handler: (args: any, swApi: SolidWorksAPI) => {
      const model = swApi.getCurrentModel();
      if (!model) throw new Error('No active document');

      const SYSTEM_TYPES = new Set([
        'OriginProfileFeature', 'RefPlane', 'RefAxis', 'ProfileFeature',
        'MaterialFolder', 'HistoryFolder', 'SensorFolder', 'DocsFolder',
        'DetailCabinet', 'FlatPatternFolder', 'CommentsFolder', 'FtrFolder'
      ]);

      const featureCount = model.GetFeatureCount();
      const limit = Math.min(featureCount, args.maxFeatures);
      const features: Array<{
        index: number;
        name: string;
        typeName: string;
        suppressed?: boolean;
        dimensions?: Array<{ fullName: string; value: number }>;
      }> = [];

      for (let i = 0; i < limit; i++) {
        try {
          const feat = model.FeatureByPositionReverse(featureCount - 1 - i);
          if (!feat) continue;

          const typeName = String(feat.GetTypeName2() || '');

          if (args.skipSystemFeatures && SYSTEM_TYPES.has(typeName)) continue;
          // feat.Name is a COM method (function), not a property — must call it
          let featName = `Feature_${i}`;
          try {
            if (typeof feat.Name === 'function') featName = String(feat.Name());
            else if (typeof feat.GetNameForSelection === 'function') featName = String(feat.GetNameForSelection());
            else featName = String(feat.Name || `Feature_${i}`);
          } catch { /* fallback */ }

          const entry: any = {
            index: i,
            name: featName,
            typeName
          };

          if (args.includeSuppressionState) {
            try {
              // IsSuppressed (no params) works through winax; IsSuppressed2 has ByRef issues
              entry.suppressed = !!feat.IsSuppressed();
            } catch {
              try {
                entry.suppressed = feat.IsSuppressed2(0, undefined) ? true : false;
              } catch {
                // Can't read suppression state
              }
            }
          }

          // Extract dimensions for this feature
          if (args.includeDimensions) {
            const dims: Array<{ fullName: string; value: number }> = [];
            try {
              let dispDim = feat.GetFirstDisplayDimension();
              let safety = 0;
              while (dispDim && safety < 50) {
                safety++;
                try {
                  const dimObj = dispDim.GetDimension2?.(0) || dispDim.GetDimension?.();
                  if (dimObj) {
                    // COM values need explicit coercion to serialize in JSON
                    const fullName = String(dimObj.FullName || dimObj.Name || '');
                    // SystemValue is in meters for length dims — convert to mm
                    const sysVal = Number(dimObj.SystemValue);
                    const valueMM = !isNaN(sysVal) ? Math.round(sysVal * 1000 * 1000) / 1000 : 0;
                    dims.push({ fullName, value: valueMM });
                  }
                } catch {
                  // Skip unreadable dimension
                }
                try {
                  dispDim = feat.GetNextDisplayDimension(dispDim);
                } catch {
                  break;
                }
              }
            } catch {
              // Feature has no display dimensions
            }
            if (dims.length > 0) {
              entry.dimensions = dims;
            }
          }

          features.push(entry);
        } catch {
          // Skip inaccessible features
        }
      }

      return {
        totalFeatures: featureCount,
        returnedFeatures: features.length,
        features
      };
    }
  };

export const getActiveDocumentInfoTool = {
    name: 'get_active_document_info',
    description: 'REQUIRES WINDOWS + SOLIDWORKS. Return metadata about the active document: file path, document type (part/assembly/drawing), title, configurations list, material, unit system, and saved state.',
    inputSchema: z.object({}),
    handler: (_args: any, swApi: SolidWorksAPI) => {
      const model = swApi.getCurrentModel();
      if (!model) throw new Error('No active document');

      const docTypeMap: Record<number, string> = { 1: 'Part', 2: 'Assembly', 3: 'Drawing' };

      let title = '';
      try { title = model.GetTitle(); } catch { /* COM fallback */ }

      let pathName = '';
      try { pathName = model.GetPathName(); } catch { /* COM fallback */ }

      let docType = 0;
      try { docType = model.GetType(); } catch { /* COM fallback */ }

      let configurations: string[] = [];
      try {
        const names = model.GetConfigurationNames();
        if (names && Array.isArray(names)) {
          configurations = names;
        }
      } catch { /* COM fallback */ }

      let activeConfig = '';
      try {
        const cfgMgr = model.ConfigurationManager;
        if (cfgMgr && cfgMgr.ActiveConfiguration) {
          activeConfig = cfgMgr.ActiveConfiguration.Name;
        }
      } catch { /* COM fallback */ }

      let material = '';
      try {
        // Parts only
        if (docType === 1) {
          material = model.MaterialIdName || '';
          if (!material) {
            const partDoc = model;
            material = partDoc.GetMaterialPropertyName2?.('', undefined) || '';
          }
        }
      } catch { /* COM fallback */ }

      let savedState = true;
      try { savedState = !model.GetSaveFlag(); } catch { /* COM fallback */ }

      const units: Record<string, string> = {};
      try {
        const userPrefs = model.Extension;
        if (userPrefs) {
          // GetUserPreferenceIntegerValue: 196 = swUnitsLinear
          const linearUnit = userPrefs.GetUserPreferenceIntegerValue?.(196, 0, '');
          const unitNames: Record<number, string> = {
            0: 'mm', 1: 'cm', 2: 'meters', 3: 'inches', 4: 'feet',
            5: 'feet-inches', 6: 'angstroms', 7: 'nanometers', 8: 'microns'
          };
          units.linear = unitNames[linearUnit] || 'unknown';
        }
      } catch { /* COM fallback */ }

      return {
        title,
        path: pathName,
        type: docTypeMap[docType] || 'Unknown',
        typeId: docType,
        saved: savedState,
        activeConfiguration: activeConfig,
        configurations,
        configurationCount: configurations.length,
        material: material || '(not set)',
        units
      };
    }
  };

export const propertyTools = [
  getCustomPropertiesTool,
  setCustomPropertiesTool,
  getFeatureTreeTool,
  getActiveDocumentInfoTool
];
