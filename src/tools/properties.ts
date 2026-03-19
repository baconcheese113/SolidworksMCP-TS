import { z } from 'zod';
import { SolidWorksAPI } from '../solidworks/api.js';

/**
 * Model Interrogation & Custom Property Tools
 * Direct COM operations for reading/writing properties, feature tree, and document info.
 */

export const getCustomPropertiesTool = {
    name: 'get_custom_properties',
    description: 'Read all custom properties from the active document, optionally for a specific configuration',
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

      const nameArray: string[] = Array.isArray(names) ? names : [names];
      const properties: Array<{ name: string; value: string; evaluatedValue: string; type: number }> = [];

      for (const name of nameArray) {
        const valOut = { value: '' };
        const evalOut = { value: '' };
        // Get6 returns: retval, name, useCached, valOut, resolvedValOut, wasResolved
        try {
          propMgr.Get6(name, false, valOut, evalOut, undefined);
          const propType = propMgr.GetType2(name);
          properties.push({
            name,
            value: valOut.value || '',
            evaluatedValue: evalOut.value || '',
            type: propType
          });
        } catch {
          // Fallback: try Get4
          try {
            propMgr.Get4(name, false, valOut, evalOut);
            properties.push({
              name,
              value: valOut.value || '',
              evaluatedValue: evalOut.value || '',
              type: 0
            });
          } catch {
            properties.push({ name, value: '(read error)', evaluatedValue: '', type: 0 });
          }
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
    description: 'Set one or more custom properties on the active document',
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
    description: 'Return the full feature tree of the active document as structured JSON',
    inputSchema: z.object({
      includeSuppressionState: z.boolean().default(true),
      maxFeatures: z.number().default(500).describe('Maximum features to return')
    }),
    handler: (args: any, swApi: SolidWorksAPI) => {
      const model = swApi.getCurrentModel();
      if (!model) throw new Error('No active document');

      const featureCount = model.GetFeatureCount();
      const limit = Math.min(featureCount, args.maxFeatures);
      const features: Array<{
        index: number;
        name: string;
        typeName: string;
        suppressed?: boolean;
      }> = [];

      for (let i = 0; i < limit; i++) {
        try {
          const feat = model.FeatureByPositionReverse(featureCount - 1 - i);
          if (!feat) continue;

          const typeName = feat.GetTypeName2() || '';
          const featName = feat.Name || feat.GetName?.() || `Feature_${i}`;

          const entry: any = {
            index: i,
            name: featName,
            typeName
          };

          if (args.includeSuppressionState) {
            try {
              entry.suppressed = feat.IsSuppressed2(0, undefined)
                ? true
                : false;
            } catch {
              try {
                entry.suppressed = !!feat.IsSuppressed();
              } catch {
                // Can't read suppression state
              }
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
    description: 'Get comprehensive info about the active document: path, type, title, configurations, material, units, saved state',
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
