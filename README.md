# SolidWorks MCP Server

<div align="center">

[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-blue?logo=typescript)](https://www.typescriptlang.org/)
[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-green?logo=anthropic)](https://modelcontextprotocol.io)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green?logo=node.js)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![SolidWorks](https://img.shields.io/badge/SolidWorks-2021--2025-red)](https://www.solidworks.com/)

An MCP server that lets AI assistants (Claude, etc.) drive SolidWorks through its COM API.
90+ tools for modeling, sketching, drawing, export, analysis, VBA generation, and McMaster-Carr part sourcing.

</div>

## Workflow Examples

Real-world engineering workflows showing how tools chain together. Each example is a task a physical sciences hardware or controls engineer might perform while designing instruments and fixtures.

### Design a Detector Mounting Fixture

You need a custom mount for a detector module. Search McMaster for shoulder bolts and dowel pins, create the part with a bolt pattern, verify the dowel press-fit, and check it into PDM.

1. `mcmaster_search` — find M4 shoulder bolts and 6mm dowel pins
2. `create_part` — new part document
3. `create_sketch` + `sketch_circle` + `sketch_linear_pattern` — bolt hole pattern on mounting face
4. `create_extrusion` — extrude the base plate
5. `fit_analysis` — verify H7/g6 fit for dowel pin bores (clearance at assembly, light interference after cooling)
6. `set_custom_properties` — stamp PartNumber, Project, Material, Engineer
7. `vba_pdm_operations` — check in to vault with comment

### Build an Instrument Assembly & Generate BOM

Assemble an optical instrument from custom parts and COTS hardware, then extract a BOM for procurement.

1. `open_model` — open the top-level assembly
2. `vba_assembly_components` — insert sub-assemblies and parts
3. `vba_assembly_mates` — constrain components (coincident, concentric, distance)
4. `mcmaster_download_cad` — download STEP files for purchased fasteners, bearings, O-rings
5. `check_interference` — verify no collisions between components
6. `tolerance_stack_analysis` — stack up the critical optical path (detector to lens mount)
7. `extract_bom` — export structured BOM as JSON or CSV with vendor info and quantities

### Release a Drawing Package for Shop Fabrication

Create a drawing from a finished part, add views and dimensions, and release through PDM.

1. `create_drawing_from_model` — new drawing from the 3D part
2. `add_drawing_view` + `add_section_view` — front, side, isometric, and section views
3. `add_dimensions` — add critical dimensions to views
4. `update_sheet_format` — fill title block (drawn by, date, project, revision)
5. `export_file` — export as PDF for the machine shop
6. `vba_pdm_operations` — transition workflow state from WIP to Released

### Source and Qualify a COTS Part from McMaster-Carr

Find a part on McMaster, review specs, download the CAD model, and add it to your PDM vault with full metadata.

1. `mcmaster_search` — search for "linear ball bearing 12mm"
2. `mcmaster_part_details` — review full specs, pricing, and lead time
3. `mcmaster_download_cad` — download STEP model to local path
4. `mcmaster_add_to_pdm` — stamp McMaster metadata as custom properties and generate VBA to add to vault

### Batch Update Custom Properties Across a Project

A project code changed and you need to update the Project property on 50 files in the vault.

1. `vba_pdm_operations` — check out target files from vault
2. `vba_custom_properties` — batch set Project, Revision, and Engineer properties
3. `vba_pdm_operations` — check in all files with comment "Updated project code to PRJ-2024-042"

### Analyze a Press-Fit for a Precision Instrument

Verify that an Invar alignment pin will maintain proper interference in an aluminum housing across the operating temperature range.

1. `fit_analysis` — calculate H7/p6 limits at 25mm nominal (room temperature)
2. `tolerance_stack_analysis` — stack up housing bore tolerance, pin OD tolerance, and thermal dimensional changes
3. Review the min/max clearance and interference to confirm the fit holds from 20°C assembly down to operating conditions

### Create a Parametric Part with Configurations

Design a mounting bracket in multiple sizes driven by a design table.

1. `create_part` + `create_sketch` + `sketch_rectangle` + `create_extrusion` — base geometry
2. `vba_configurations` — create Small, Medium, Large configurations
3. `vba_equations` — link hole spacing and wall thickness to a driving dimension
4. `vba_design_table` — generate an Excel-driven design table for all size variants

### Automate Drawing Standards Across a Project

Ensure all drawings in a project use the same title block, border, and format settings.

1. `extract_drawing_template` — capture settings from the master/reference drawing
2. `batch_apply_template` — apply to all child drawings in the project folder
3. `compare_drawing_templates` — verify consistency and flag any deviations

## How It Works

```
Claude / MCP Client
       |
   MCP Protocol (stdio JSON-RPC)
       |
   Tool Handlers (src/tools/*.ts)
       |
   SolidWorksAPI (src/solidworks/api.ts)  -- winax COM bridge
       |
   SolidWorks COM API
```

The server registers tools over MCP's stdio transport. When a tool is called, it validates input with Zod, then calls SolidWorks through the [winax](https://github.com/niclasku/winax) COM bridge. VBA generation tools produce macro code without needing a live SolidWorks connection. McMaster-Carr tools work over HTTP on any platform.

## Prerequisites

- **Windows 10/11** (required for SolidWorks COM)
- **SolidWorks 2021-2025** (licensed, running)
- **Node.js 20+**
- **Python 3.10+** and **Visual Studio Build Tools** (needed to compile the `winax` native module)
- **Claude Desktop** or any MCP-compatible client

## Windows Setup (from scratch)

If you're starting from a fresh Windows machine, here's everything you need. Open **PowerShell as Administrator**:

### 1. Install prerequisites with winget

```powershell
# Volta (Node.js version manager - auto-switches node version per project)
winget install Volta.Volta

# Python (needed for node-gyp to compile winax)
winget install Python.Python.3.12

# Visual Studio Build Tools (C++ compiler for native modules)
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"

# Git
winget install Git.Git
```

Close and reopen PowerShell after installing these so PATH updates take effect.

### 2. Install Node.js via Volta

```powershell
# Volta automatically installs and uses the right Node version per project
volta install node@20
```

### 3. Clone and build

```powershell
git clone https://github.com/vespo92/SolidworksMCP-TS.git
cd SolidworksMCP-TS

# Volta pins Node 20 for this repo automatically (see package.json "volta" field)
npm install    # compiles winax native module
npm run build  # TypeScript -> dist/
```

> **Troubleshooting `npm install` failures:** If winax fails to compile, make sure you have the Visual Studio Build Tools with the C++ workload installed and that `python` is on your PATH. You can verify with `python --version` and `cl` (should print the MSVC compiler version). If needed: `npm config set msvs_version 2022`.

### 4. Connect to an AI assistant

#### Claude Code (automatic)

If you cloned the repo, Claude Code auto-detects the `.mcp.json` and offers to enable the server. Just open the project:

```powershell
cd SolidworksMCP-TS
claude
```

Or add it manually from anywhere:

```powershell
claude mcp add --transport stdio solidworks -- node C:/path/to/SolidworksMCP-TS/dist/index.js
```

#### Claude Desktop

Add to your `claude_desktop_config.json` (usually at `%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "solidworks": {
      "command": "node",
      "args": ["C:/path/to/SolidworksMCP-TS/dist/index.js"]
    }
  }
}
```

Restart Claude Desktop after saving. Start SolidWorks before using any modeling/sketch/analysis tools (VBA generation and McMaster-Carr tools work without SolidWorks running).

## Tools

### Modeling (7 tools)

| Tool | Description |
|------|-------------|
| `open_model` | Open a SolidWorks part, assembly, or drawing file |
| `create_part` | Create a new SolidWorks part document |
| `close_model` | Close the current model with option to save |
| `create_extrusion` | Create an extrusion feature |
| `get_dimension` | Get the value of a dimension |
| `set_dimension` | Set the value of a dimension |
| `rebuild_model` | Rebuild the current model |

### Sketching (17 tools)

| Tool | Description |
|------|-------------|
| `create_sketch` | Create a new sketch on a specified plane or face |
| `edit_sketch` | Enter sketch edit mode for an existing sketch |
| `exit_sketch` | Exit sketch edit mode and rebuild |
| `sketch_line` | Draw a line in the active sketch |
| `sketch_centerline` | Draw a centerline in the active sketch |
| `sketch_circle` | Draw a circle in the active sketch |
| `sketch_arc` | Draw an arc in the active sketch |
| `sketch_rectangle` | Draw a rectangle in the active sketch |
| `sketch_polygon` | Draw a regular polygon in the active sketch |
| `sketch_spline` | Draw a spline through points in the active sketch |
| `sketch_ellipse` | Draw an ellipse in the active sketch |
| `add_sketch_constraint` | Add constraints between sketch entities |
| `add_sketch_dimension` | Add dimensions to sketch entities |
| `sketch_linear_pattern` | Create a linear pattern of sketch entities |
| `sketch_circular_pattern` | Create a circular pattern of sketch entities |
| `sketch_mirror` | Mirror sketch entities about a line |
| `sketch_offset` | Create offset curves from sketch entities |

### Drawing (5 tools)

| Tool | Description |
|------|-------------|
| `create_drawing_from_model` | Create a new drawing from the current 3D model |
| `add_drawing_view` | Add a view to the current drawing |
| `add_section_view` | Add a section view to the drawing |
| `add_dimensions` | Add dimensions to a drawing view |
| `update_sheet_format` | Update drawing sheet format and properties |

### Export (4 tools)

| Tool | Description |
|------|-------------|
| `export_file` | Export the current model to STEP, IGES, STL, PDF, DWG, DXF |
| `batch_export` | Export multiple configurations or files to a format |
| `export_with_options` | Export with specific format options |
| `capture_screenshot` | Capture a screenshot of the current model view |

### Analysis (6 tools)

| Tool | Description |
|------|-------------|
| `get_mass_properties` | Get mass properties of the current model |
| `check_interference` | Check for interference between components in an assembly |
| `measure_distance` | Measure distance between two selected entities |
| `analyze_draft` | Analyze draft angles for molding |
| `check_geometry` | Check model geometry for errors |
| `get_bounding_box` | Get the bounding box dimensions of the model |

### VBA Generation (28 tools)

These tools generate ready-to-run VBA macro code. They don't require a live SolidWorks connection.

| Tool | Description |
|------|-------------|
| `generate_vba_script` | Generate a VBA script from a template with parameters |
| `create_feature_vba` | Generate VBA code to create a specific feature |
| `create_batch_vba` | Generate VBA for batch processing multiple files |
| `run_vba_macro` | Execute a VBA macro in SolidWorks |
| `create_drawing_vba` | Generate VBA to create drawings from 3D models |
| `vba_create_reference_geometry` | Generate VBA for reference geometry (planes, axes, points) |
| `vba_advanced_features` | Generate VBA for advanced features (sweep, loft, boundary) |
| `vba_pattern_features` | Generate VBA for pattern features |
| `vba_sheet_metal` | Generate VBA for sheet metal operations |
| `vba_surface_modeling` | Generate VBA for surface modeling operations |
| `vba_assembly_mates` | Generate VBA for creating assembly mates |
| `vba_assembly_components` | Generate VBA for inserting and managing components |
| `vba_assembly_analysis` | Generate VBA for assembly analysis |
| `vba_assembly_configurations` | Generate VBA for managing assembly configurations |
| `vba_create_drawing_views` | Generate VBA for creating drawing views |
| `vba_drawing_dimensions` | Generate VBA for adding dimensions to drawings |
| `vba_drawing_annotations` | Generate VBA for adding annotations to drawings |
| `vba_drawing_tables` | Generate VBA for creating tables in drawings |
| `vba_drawing_sheet_format` | Generate VBA for managing drawing sheets and formats |
| `vba_batch_operations` | Generate VBA for batch file operations |
| `vba_custom_properties` | Generate VBA for managing custom properties |
| `vba_pdm_operations` | Generate VBA for PDM vault operations (check in/out, add file, search) |
| `vba_design_table` | Generate VBA for creating and managing design tables |
| `vba_configurations` | Generate VBA for managing configurations |
| `vba_equations` | Generate VBA for managing equations and global variables |
| `vba_simulation_setup` | Generate VBA for setting up simulation studies |
| `vba_api_automation` | Generate VBA for advanced API automation and event handling |
| `vba_error_handling` | Generate VBA with comprehensive error handling and logging |

### Template Management (6 tools)

| Tool | Description |
|------|-------------|
| `extract_drawing_template` | Extract complete template settings from a parent drawing file |
| `apply_drawing_template` | Apply template settings to a target drawing file |
| `batch_apply_template` | Apply template to multiple child drawing files |
| `compare_drawing_templates` | Compare template settings between two drawings |
| `save_template_to_library` | Save a drawing template to a reusable library |
| `list_template_library` | List all templates in the library |

### Macro Recording (8 tools)

| Tool | Description |
|------|-------------|
| `start_native_macro_recording` | Start recording a macro using SolidWorks native VBA recorder |
| `stop_native_macro_recording` | Stop the current native macro recording and save |
| `pause_resume_macro_recording` | Pause or resume the current macro recording |
| `run_macro` | Run a SolidWorks macro file |
| `edit_macro` | Open a macro in the SolidWorks VBA editor |
| `create_initialized_macro` | Create a new macro with proper SolidWorks VBA initialization |
| `convert_text_to_native_macro` | Convert plain text VBA code to a properly initialized SolidWorks macro |
| `batch_run_macros` | Run multiple macros in sequence |

### McMaster-Carr (5 tools)

Search McMaster-Carr, get full part details (specs, pricing, delivery), download CAD files, and add parts to your PDM vault with metadata. Works on any platform — no SolidWorks connection needed.

| Tool | Auth | Description |
|------|:---:|---|
| `mcmaster_search` | No | Search catalog by keyword or category |
| `mcmaster_part_details` | No (basic) | Pricing and delivery. With browser cookies: full specs table, images, CAD paths |
| `mcmaster_set_cookies` | - | Provide browser cookies for authenticated endpoints (`cat` cookie required) |
| `mcmaster_download_cad` | Yes | Download STEP, SLDPRT, IGES, DWG, etc. to a local path |
| `mcmaster_add_to_pdm` | Yes | Download CAD + stamp metadata as custom properties + generate PDM add VBA |

## Development

```bash
npm run build        # TypeScript compile
npm run dev          # Hot-reload dev server (tsx watch)
npm test             # Unit tests (vitest)
npm run test:watch   # Watch mode
npm run lint         # ESLint
npm run typecheck    # Type check without emit
```

### Testing

Tests use mocks by default so they run on any platform (including CI on Mac/Linux):

```bash
npm test                                    # All tests (mocked, no network)
MCMASTER_NETWORK_TESTS=true npm test        # Include McMaster live endpoint tests
USE_MOCK_SOLIDWORKS=false npm test          # Integration tests (Windows + SolidWorks required)
```

### Project Structure

```
src/
  index.ts                  # MCP server entry point, tool registration
  solidworks/
    api.ts                  # Direct COM interface via winax
  tools/
    modeling.ts             # Part/assembly/feature tools
    sketch.ts              # Sketch creation and entities
    drawing.ts             # Drawing generation
    export.ts              # File export
    analysis.ts            # Mass properties, interference, etc.
    vba.ts                 # VBA code generation (+ vba-*.ts)
    template-manager.ts    # Feature templates
    native-macro.ts        # Macro recording/playback
    mcmaster.ts            # McMaster-Carr integration
  adapters/                # Adapter layer (not currently wired into the server)
  resources/               # MCP resource definitions (design tables, PDM config)
  utils/                   # Logging (winston), environment config
```

### Key Conventions

- **ESM modules** (`"type": "module"` in package.json)
- **Never pass `null` to COM** — use `undefined` for optional parameters (COM interprets `null` as VT_NULL causing type mismatch)
- **Winston logging only** — never `console.*` (breaks JSON-RPC stdio transport)
- **Zod schemas** for all tool input validation

## Troubleshooting

### winax won't compile
Make sure Visual Studio Build Tools (C++ workload) and Python are installed. Then:
```powershell
npm config set msvs_version 2022
npm install --build-from-source
```

### SolidWorks connection fails
- SolidWorks must be running before starting the MCP server
- Check that SolidWorks COM is registered: `regsvr32 "C:\Program Files\SOLIDWORKS Corp\SOLIDWORKS\sldworks.tlb"`
- Try running your terminal as Administrator

### Debug logging
```powershell
$env:LOG_LEVEL="debug"
node dist/index.js
```

## License

MIT
