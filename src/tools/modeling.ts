import { z } from 'zod';
import { SolidWorksAPI } from '../solidworks/api.js';

export const modelingTools = [
  {
    name: 'open_model',
    description: 'REQUIRES WINDOWS + SOLIDWORKS. Open a .sldprt, .sldasm, or .slddrw file in the running SolidWorks instance. The file must exist on the local filesystem.',
    inputSchema: z.object({
      path: z.string().describe('Full path to the SolidWorks file'),
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
    handler: (args: any, swApi: SolidWorksAPI) => {
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
        } catch (e) {
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
    description: 'REQUIRES WINDOWS + SOLIDWORKS. Create a boss-extrude or cut-extrude from the most recent sketch. You must create and close a sketch first (create_sketch → sketch geometry → exit_sketch → create_extrusion). For complex extrusions with many parameters, use create_feature_vba to generate VBA code instead.',
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
          } catch (e) {
            // If ForceRebuild3 doesn't exist, try ForceRebuild
            try {
              model.ForceRebuild();
              success = true;
            } catch (e2) {
              // Fall back to EditRebuild
              success = model.EditRebuild();
            }
          }
        } else {
          // Use EditRebuild for normal rebuild
          try {
            success = model.EditRebuild();
          } catch (e) {
            // Try alternative methods
            try {
              model.Rebuild(1); // 1 = swRebuildAll
              success = true;
            } catch (e2) {
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
];