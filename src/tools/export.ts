import { execSync } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { z } from 'zod';
import type { SolidWorksAPI } from '../solidworks/api.js';

export const exportTools = [
  {
    name: 'export_file',
    description: 'Export the current model to various formats',
    inputSchema: z.object({
      outputPath: z.string().describe('Output file path (extension determines format)'),
      format: z
        .enum(['step', 'iges', 'stl', 'pdf', 'dxf', 'dwg'])
        .optional()
        .describe('Export format (if not specified, uses file extension)'),
    }),
    handler: (args: any, swApi: SolidWorksAPI) => {
      try {
        // Determine format from extension if not specified
        const format = args.format || extname(args.outputPath).slice(1).toLowerCase();

        // Try to export
        try {
          swApi.exportFile(args.outputPath, format);
        } catch (e) {
          // Even if export throws, check if file was created
          if (existsSync(args.outputPath)) {
            return `Exported to ${format.toUpperCase()}: ${args.outputPath} (with warnings)`;
          }
          throw e;
        }

        // Verify file was created
        if (existsSync(args.outputPath)) {
          return `Exported to ${format.toUpperCase()}: ${args.outputPath}`;
        } else {
          // File might be created with different extension for some formats
          const altPath = args.outputPath.replace(/\.[^.]+$/, `.${format}`);
          if (existsSync(altPath)) {
            return `Exported to ${format.toUpperCase()}: ${altPath}`;
          }
          return `Export completed but file not found at: ${args.outputPath}. Check SolidWorks for any error messages.`;
        }
      } catch (error) {
        return `Failed to export: ${error}`;
      }
    },
  },

  {
    name: 'batch_export',
    description: 'Export multiple configurations or files to a format',
    inputSchema: z.object({
      format: z.enum(['step', 'iges', 'stl', 'pdf', 'dxf', 'dwg']),
      outputDir: z.string().describe('Output directory'),
      configurations: z.array(z.string()).optional().describe('List of configurations to export (if applicable)'),
      prefix: z.string().optional().describe('Prefix for output files'),
    }),
    handler: (args: any, swApi: SolidWorksAPI) => {
      try {
        const model = swApi.getCurrentModel();
        if (!model) throw new Error('No model open');

        const exported: string[] = [];
        const modelName = basename(model.GetPathName(), extname(model.GetPathName()));

        if (args.configurations && args.configurations.length > 0) {
          // Export each configuration
          for (const config of args.configurations) {
            model.ShowConfiguration2(config);
            const filename = `${args.prefix || ''}${modelName}_${config}.${args.format}`;
            const outputPath = join(args.outputDir, filename);
            swApi.exportFile(outputPath, args.format);
            exported.push(outputPath);
          }
        } else {
          // Export current state
          const filename = `${args.prefix || ''}${modelName}.${args.format}`;
          const outputPath = join(args.outputDir, filename);
          swApi.exportFile(outputPath, args.format);
          exported.push(outputPath);
        }

        return `Exported ${exported.length} file(s):\n${exported.join('\n')}`;
      } catch (error) {
        return `Failed to batch export: ${error}`;
      }
    },
  },

  {
    name: 'export_with_options',
    description: 'Export with specific format options',
    inputSchema: z.object({
      outputPath: z.string().describe('Output file path'),
      format: z.enum(['stl', 'step', 'iges']),
      options: z.object({
        units: z.enum(['mm', 'in', 'm']).optional(),
        binary: z.boolean().optional().describe('Binary format (STL only)'),
        version: z.string().optional().describe('Format version (STEP/IGES)'),
        quality: z.enum(['coarse', 'fine', 'custom']).optional().describe('Mesh quality (STL)'),
      }),
    }),
    handler: (args: any, swApi: SolidWorksAPI) => {
      try {
        const model = swApi.getCurrentModel();
        if (!model) throw new Error('No model open');

        // Set export options based on format
        if (args.format === 'stl' && args.options.quality) {
          const qualityMap = { coarse: 1, fine: 10, custom: 5 };
          model.Extension.SetUserPreferenceInteger(8, 0, qualityMap[args.options.quality as keyof typeof qualityMap]);
        }

        swApi.exportFile(args.outputPath, args.format);
        return `Exported with options to: ${args.outputPath}`;
      } catch (error) {
        return `Failed to export with options: ${error}`;
      }
    },
  },

  {
    name: 'capture_screenshot',
    description: 'Capture a screenshot of the current model view',
    inputSchema: z.object({
      outputPath: z.string().describe('Output image path (.png, .jpg, .bmp)'),
      width: z.number().optional().describe('Image width in pixels'),
      height: z.number().optional().describe('Image height in pixels'),
    }),
    handler: (args: any, swApi: SolidWorksAPI) => {
      try {
        const model = swApi.getCurrentModel();
        if (!model) throw new Error('No model open');

        const ext = args.outputPath.toLowerCase().split('.').pop();
        const width = args.width || 1920;
        const height = args.height || 1080;

        // SolidWorks only reliably exports BMP via SaveBMP
        // For PNG/JPG, save BMP first then convert via PowerShell
        if (ext === 'bmp') {
          const success = model.SaveBMP(args.outputPath, width, height);
          if (!success && !existsSync(args.outputPath)) {
            throw new Error('SaveBMP failed');
          }
          return `Screenshot saved to: ${args.outputPath}`;
        }

        // Save as BMP to temp path, then convert
        const bmpPath = args.outputPath.replace(/\.[^.]+$/, '.bmp');
        const success = model.SaveBMP(bmpPath, width, height);
        if (!success && !existsSync(bmpPath)) {
          throw new Error('SaveBMP failed');
        }

        if (ext === 'png' || ext === 'jpg' || ext === 'jpeg') {
          try {
            const format = ext === 'png' ? 'Png' : 'Jpeg';
            const psCmd = `Add-Type -AssemblyName System.Drawing; $bmp = [System.Drawing.Image]::FromFile('${bmpPath.replace(/'/g, "''")}'); $bmp.Save('${args.outputPath.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::${format}); $bmp.Dispose()`;
            execSync(`powershell -NoProfile -Command "${psCmd}"`, { timeout: 15000, windowsHide: true });

            // Clean up temp BMP
            if (existsSync(bmpPath) && existsSync(args.outputPath)) {
              try { unlinkSync(bmpPath); } catch {}
            }

            if (existsSync(args.outputPath)) {
              return `Screenshot saved to: ${args.outputPath}`;
            }
          } catch (convertErr) {
            // Conversion failed, BMP still exists
            if (existsSync(bmpPath)) {
              return `Screenshot saved as BMP (${ext} conversion failed): ${bmpPath}`;
            }
          }
        }

        // Fallback: return BMP path
        if (existsSync(bmpPath)) {
          return `Screenshot saved as BMP: ${bmpPath}`;
        }
        throw new Error('Failed to save screenshot');
      } catch (error) {
        return `Failed to capture screenshot: ${error}`;
      }
    },
  },
];
