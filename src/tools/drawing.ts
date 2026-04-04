import { z } from 'zod';
import type { SolidWorksAPI } from '../solidworks/api.js';
import { SolidWorksConfig } from '../utils/solidworks-config.js';

export const drawingTools = [
  {
    name: 'create_drawing_from_model',
    description: 'REQUIRES WINDOWS + SOLIDWORKS. Create a new drawing document (.slddrw) with an initial view from the active 3D model. Use add_drawing_view to add more views afterward.',
    inputSchema: z.object({
      template: z.string().describe('Drawing template path'),
      sheet_size: z.enum(['A4', 'A3', 'A2', 'A1', 'A0', 'Letter', 'Tabloid']).optional(),
    }),
    handler: (args: any, swApi: SolidWorksAPI) => {
      try {
        const app = swApi.getApp();
        const model = swApi.getCurrentModel();
        if (!model) throw new Error('No model open to create drawing from');

        const modelPath = String(model.GetPathName() || '');
        if (!modelPath) {
          throw new Error('Model has no saved path - save the model first before creating a drawing');
        }


        let templatePath = args.template;
        if (!templatePath || templatePath === '') {
          try {
            templatePath = SolidWorksConfig.getTemplatePath(app, 'drawing', args.template);
          } catch (e) {
            throw new Error(`Template path error: ${e}`);
          }
        }

        // NewDocument returns a COM object, but via winax the return may not
        // be the ModelDoc2 pointer.  After creation, ActiveDoc is the new drawing.
        try {
          app.NewDocument(templatePath, 0, 0, 0);
        } catch (e) {
          try {
            app.NewDocument(templatePath, 2, 0.297, 0.21);
          } catch (e2) {
            throw new Error(`Cannot create drawing with template: ${templatePath} — ${e2}`);
          }
        }

        // Get the drawing doc from ActiveDoc (reliable via winax)
        const drawDoc = app.ActiveDoc;
        if (!drawDoc || drawDoc.GetType() !== 3) {
          throw new Error('Failed to create drawing document — ActiveDoc is not a drawing');
        }


        const warnings: string[] = [];
        try {
          const firstView = drawDoc.CreateDrawViewFromModelView3(
            modelPath,
            '*Front',
            0.15,
            0.15,
            0
          );

          if (firstView) {
            try {
              const topView = drawDoc.CreateUnfoldedViewAt3(0.25, 0.15, 0, false);
              if (!topView) warnings.push('Failed to create top view');
            } catch (e) {
              warnings.push(`Top view error: ${e}`);
            }

            try {
              const rightView = drawDoc.CreateUnfoldedViewAt3(0.15, 0.25, 0, false);
              if (!rightView) warnings.push('Failed to create right view');
            } catch (e) {
              warnings.push(`Right view error: ${e}`);
            }
          } else {
            warnings.push('Failed to create front view - drawing is empty');
          }
        } catch (e) {
          warnings.push(`View creation error: ${e}`);
        }

        const warningText = warnings.length > 0 ? `\nWarnings: ${warnings.join('; ')}` : '';
        return `Created new drawing from template: ${templatePath}${warningText}`;
      } catch (error) {
        return `Failed to create drawing: ${error}`;
      }
    },
  },

  {
    name: 'add_drawing_view',
    description: 'REQUIRES WINDOWS + SOLIDWORKS. Insert a standard, projected, or isometric view into the active drawing. A drawing must be open (use create_drawing_from_model first).',
    inputSchema: z.object({
      viewType: z.enum(['front', 'top', 'right', 'back', 'bottom', 'left', 'iso', 'current']),
      modelPath: z.string().describe('Path to the model file'),
      x: z.number().describe('X position on sheet (mm)'),
      y: z.number().describe('Y position on sheet (mm)'),
      scale: z.number().optional().describe('View scale (e.g., 0.5 for 1:2)'),
    }),
    handler: (args: any, swApi: SolidWorksAPI) => {
      try {
        const model = swApi.getCurrentModel();
        if (!model || model.GetType() !== 3) {
          // swDocDRAWING
          throw new Error('Current document must be a drawing');
        }

        const drawingDoc = model;

        // View orientation map
        const orientationMap: Record<string, string> = {
          front: '*Front',
          top: '*Top',
          right: '*Right',
          back: '*Back',
          bottom: '*Bottom',
          left: '*Left',
          iso: '*Isometric',
          current: '*Current',
        };

        const view = drawingDoc.CreateDrawViewFromModelView3(
          args.modelPath,
          orientationMap[args.viewType],
          args.x / 1000, // Convert mm to m
          args.y / 1000,
          0
        );

        if (!view) throw new Error('Failed to create view');

        // Set scale if specified
        if (args.scale) {
          view.ScaleDecimal = args.scale;
        }

        return `Added ${args.viewType} view at (${args.x}, ${args.y})`;
      } catch (error) {
        return `Failed to add drawing view: ${error}`;
      }
    },
  },

  {
    name: 'add_section_view',
    description: 'REQUIRES WINDOWS + SOLIDWORKS. Insert a section view cut along a line in an existing view. A drawing with at least one view must be open.',
    inputSchema: z.object({
      parentView: z.string().describe('Name of the parent view'),
      x: z.number().describe('X position on sheet (mm)'),
      y: z.number().describe('Y position on sheet (mm)'),
      sectionLine: z
        .object({
          x1: z.number(),
          y1: z.number(),
          x2: z.number(),
          y2: z.number(),
        })
        .describe('Section line coordinates relative to parent view'),
    }),
    handler: (_args: any, swApi: SolidWorksAPI) => {
      try {
        const model = swApi.getCurrentModel();
        if (!model || model.GetType() !== 3) {
          throw new Error('Current document must be a drawing');
        }

        // Implementation would require selecting parent view and creating section line
        // This is a simplified response
        return `Section view creation requires interactive selection. Use VBA generation for automated section views.`;
      } catch (error) {
        return `Failed to add section view: ${error}`;
      }
    },
  },

  {
    name: 'add_dimensions',
    description: 'REQUIRES WINDOWS + SOLIDWORKS. Add reference dimensions to a drawing view. Different from add_sketch_dimension which dimensions sketch entities in a 3D model.',
    inputSchema: z.object({
      viewName: z.string().describe('Name of the view to dimension'),
      autoArrange: z.boolean().default(true).describe('Automatically arrange dimensions'),
    }),
    handler: (args: any, swApi: SolidWorksAPI) => {
      try {
        const model = swApi.getCurrentModel();
        if (!model || model.GetType() !== 3) {
          throw new Error('Current document must be a drawing');
        }

        const drawingDoc = model;
        const view = drawingDoc.FeatureByName(args.viewName);

        if (!view) throw new Error(`View "${args.viewName}" not found`);

        // Select the view
        view.Select2(false, 0);

        // Auto-dimension
        drawingDoc.Extension.AutoDimension(
          1, // Scheme: Baseline
          1, // Type: Linear dimensions
          true, // Include hidden edges
          1, // Placement: Above view
          0 // Offset
        );

        return `Added dimensions to view: ${args.viewName}`;
      } catch (error) {
        return `Failed to add dimensions: ${error}`;
      }
    },
  },

  {
    name: 'update_sheet_format',
    description: 'REQUIRES WINDOWS + SOLIDWORKS. Update the title block, border, or custom properties on the active drawing sheet.',
    inputSchema: z.object({
      properties: z.object({
        title: z.string().optional(),
        drawnBy: z.string().optional(),
        checkedBy: z.string().optional(),
        date: z.string().optional(),
        scale: z.string().optional(),
        material: z.string().optional(),
        finish: z.string().optional(),
      }),
    }),
    handler: (args: any, swApi: SolidWorksAPI) => {
      try {
        const model = swApi.getCurrentModel();
        if (!model || model.GetType() !== 3) {
          throw new Error('Current document must be a drawing');
        }

        // Update custom properties
        const customPropMgr = model.Extension.CustomPropertyManager('');

        for (const [key, value] of Object.entries(args.properties)) {
          if (value) {
            customPropMgr.Add3(
              key,
              30, // swCustomInfoType_e.swCustomInfoText
              value,
              1 // swCustomPropertyAddOption_e.swCustomPropertyReplaceValue
            );
          }
        }

        // Force update of sheet format
        model.ForceRebuild3(false);

        return `Updated sheet format properties`;
      } catch (error) {
        return `Failed to update sheet format: ${error}`;
      }
    },
  },
];
