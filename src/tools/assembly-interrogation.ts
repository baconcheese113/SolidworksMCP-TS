import { z } from 'zod';
import { SolidWorksAPI } from '../solidworks/api.js';

/**
 * Assembly Intelligence Tools
 * Recursive component traversal and BOM extraction via direct COM.
 */

interface ComponentNode {
  name: string;
  path: string;
  configurationName: string;
  suppressed: boolean;
  visible: boolean;
  children: ComponentNode[];
}

function traverseComponents(comp: any, depth: number, maxDepth: number): ComponentNode {
  let name = '';
  try { name = comp.Name2 || comp.Name || ''; } catch { /* COM fallback */ }

  let compPath = '';
  try { compPath = comp.GetPathName() || ''; } catch { /* COM fallback */ }

  let configName = '';
  try { configName = comp.ReferencedConfiguration || ''; } catch { /* COM fallback */ }

  let suppressed = false;
  try { suppressed = !!comp.IsSuppressed(); } catch { /* COM fallback */ }

  let visible = true;
  try { visible = comp.Visible !== 0; } catch { /* COM fallback */ }

  const children: ComponentNode[] = [];
  if (depth < maxDepth) {
    try {
      const childComps = comp.GetChildren();
      if (childComps && Array.isArray(childComps)) {
        for (const child of childComps) {
          children.push(traverseComponents(child, depth + 1, maxDepth));
        }
      }
    } catch {
      // No children or can't access
    }
  }

  return { name, path: compPath, configurationName: configName, suppressed, visible, children };
}

/**
 * Flatten component tree to count unique parts and their quantities.
 */
function flattenForBOM(node: ComponentNode, result: Map<string, { path: string; config: string; quantity: number; names: string[] }>) {
  if (node.path) {
    const key = `${node.path}|${node.configurationName}`;
    const existing = result.get(key);
    if (existing) {
      existing.quantity++;
      existing.names.push(node.name);
    } else {
      result.set(key, {
        path: node.path,
        config: node.configurationName,
        quantity: 1,
        names: [node.name]
      });
    }
  }
  for (const child of node.children) {
    flattenForBOM(child, result);
  }
}

export const assemblyInterrogationTools = [
  {
    name: 'get_assembly_components',
    description: 'Get the full component hierarchy of an assembly with names, paths, quantities, and suppression states',
    inputSchema: z.object({
      maxDepth: z.number().default(10).describe('Maximum recursion depth for sub-assemblies')
    }),
    handler: (args: any, swApi: SolidWorksAPI) => {
      const model = swApi.getCurrentModel();
      if (!model) throw new Error('No active document');

      const docType = model.GetType();
      if (docType !== 2) {
        throw new Error('Active document is not an assembly (type must be swDocASSEMBLY)');
      }

      let rootComp: any;
      try {
        const config = model.GetActiveConfiguration?.() || model.ConfigurationManager?.ActiveConfiguration;
        rootComp = config.GetRootComponent3(true);
        if (!rootComp) rootComp = config.GetRootComponent2(true);
      } catch {
        throw new Error('Cannot access assembly root component. Ensure an assembly is open.');
      }

      const tree = traverseComponents(rootComp, 0, args.maxDepth);

      // Also compute flat summary
      const flatMap = new Map<string, { path: string; config: string; quantity: number; names: string[] }>();
      flattenForBOM(tree, flatMap);

      const uniqueParts = Array.from(flatMap.values()).map(v => ({
        path: v.path,
        configuration: v.config,
        quantity: v.quantity,
        instanceNames: v.names
      }));

      return {
        assemblyTitle: model.GetTitle?.() || '',
        tree,
        summary: {
          totalInstances: uniqueParts.reduce((sum, p) => sum + p.quantity, 0),
          uniqueComponents: uniqueParts.length,
          components: uniqueParts
        }
      };
    }
  },

  {
    name: 'extract_bom',
    description: 'Extract a structured Bill of Materials from an assembly, including custom properties from each component',
    inputSchema: z.object({
      propertyNames: z.array(z.string()).default(['PartNumber', 'Description', 'Material', 'Cost', 'Vendor']).describe('Custom property names to read from each component'),
      includeSubAssemblies: z.boolean().default(true),
      format: z.enum(['json', 'csv']).default('json')
    }),
    handler: (args: any, swApi: SolidWorksAPI) => {
      const model = swApi.getCurrentModel();
      if (!model) throw new Error('No active document');

      const docType = model.GetType();
      if (docType !== 2) {
        throw new Error('Active document is not an assembly');
      }

      let rootComp: any;
      try {
        const config = model.GetActiveConfiguration?.() || model.ConfigurationManager?.ActiveConfiguration;
        rootComp = config.GetRootComponent3(true);
        if (!rootComp) rootComp = config.GetRootComponent2(true);
      } catch {
        throw new Error('Cannot access assembly root component');
      }

      const tree = traverseComponents(rootComp, 0, args.includeSubAssemblies ? 50 : 1);
      const flatMap = new Map<string, { path: string; config: string; quantity: number; names: string[] }>();
      flattenForBOM(tree, flatMap);

      // For each unique component, try to read custom properties
      const app = swApi.getApp();
      const bomEntries: any[] = [];
      let itemNumber = 1;

      for (const [, entry] of flatMap) {
        const bomRow: any = {
          item: itemNumber++,
          fileName: entry.path.split(/[/\\]/).pop() || entry.path,
          path: entry.path,
          configuration: entry.config,
          quantity: entry.quantity
        };

        // Try to read properties from the component document
        // Open silently if not already open
        if (entry.path && app) {
          let compModel: any = null;
          let wasAlreadyOpen = false;
          try {
            const errors = { value: 0 };
            const warnings = { value: 0 };
            const ext = entry.path.toLowerCase();
            const compDocType = ext.endsWith('.sldasm') ? 2 : 1;

            // Try to get already-open document first
            try {
              compModel = app.GetOpenDocumentByName(entry.path);
            } catch { /* may not be open */ }

            wasAlreadyOpen = !!compModel;

            if (!compModel) {
              try {
                compModel = app.OpenDoc6(
                  entry.path,
                  compDocType,
                  1, // swOpenDocOptions_Silent
                  entry.config || '',
                  errors,
                  warnings
                );
              } catch {
                // Can't open — skip property reading
              }
            }

            if (compModel) {
              const propMgr = compModel.Extension?.CustomPropertyManager(entry.config || '');
              if (propMgr) {
                for (const propName of args.propertyNames) {
                  try {
                    const valOut = { value: '' };
                    const evalOut = { value: '' };
                    propMgr.Get6(propName, false, valOut, evalOut, undefined);
                    bomRow[propName] = evalOut.value || valOut.value || '';
                  } catch {
                    try {
                      const valOut = { value: '' };
                      const evalOut = { value: '' };
                      propMgr.Get4(propName, false, valOut, evalOut);
                      bomRow[propName] = evalOut.value || valOut.value || '';
                    } catch {
                      bomRow[propName] = '';
                    }
                  }
                }
              }
            }
          } catch {
            // Property reading failed — row still has basic info
          } finally {
            // Close if we opened it — guaranteed even if property reading throws
            if (compModel && !wasAlreadyOpen) {
              try { app.CloseDoc(compModel.GetTitle()); } catch { /* best-effort */ }
            }
          }
        }

        bomEntries.push(bomRow);
      }

      if (args.format === 'csv') {
        const headers = ['Item', 'FileName', 'Quantity', ...args.propertyNames];
        const csvLines = [headers.join(',')];
        for (const row of bomEntries) {
          const values = [
            row.item,
            `"${row.fileName}"`,
            row.quantity,
            ...args.propertyNames.map((p: string) => `"${(row[p] || '').replace(/[\r\n]+/g, ' ').replace(/"/g, '""')}"`)
          ];
          csvLines.push(values.join(','));
        }
        return csvLines.join('\n');
      }

      return {
        assemblyTitle: model.GetTitle?.() || '',
        totalLineItems: bomEntries.length,
        totalParts: bomEntries.reduce((sum: number, r: any) => sum + r.quantity, 0),
        bom: bomEntries
      };
    }
  }
];
