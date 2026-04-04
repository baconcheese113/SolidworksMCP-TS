# SolidWorks MCP Server

## Build & Test

```bash
npm run build        # TypeScript compile (tsc)
npm run dev          # Hot-reload dev server (tsx watch)
npm test             # Run unit tests (vitest)
npm run test:watch   # Watch mode tests
npm run lint         # Biome lint check
npm run lint:fix     # Biome auto-fix
npm run format       # Biome format
npm run check        # TypeScript + Biome in one command
npm run typecheck    # Type check without emit
```

**Important**: This project requires Windows + SolidWorks to run. The `winax` native module only compiles on Windows and is an optional dependency. On non-Windows, use `npm install --ignore-scripts`. Tests use `USE_MOCK_SOLIDWORKS=true` by default for cross-platform CI.

## Architecture

- **MCP Server** (`src/index.ts`) - Entry point, registers tools via stdio transport
- **Adapters** (`src/adapters/`) - COM bridge layer with intelligent routing:
  - `winax-adapter.ts` - Direct COM via winax
  - `winax-adapter-enhanced.ts` - Enhanced adapter with complexity analysis
  - `feature-complexity-analyzer.ts` - Routes operations between direct COM and VBA macro fallback
  - `macro-generator.ts` - Generates VBA code for complex operations
- **Tools** (`src/tools/`) - MCP tool implementations (modeling, sketch, drawing, export, analysis, VBA)
- **Core API** (`src/solidworks/api.ts`) - Low-level SolidWorks COM interface

## Key Patterns

### COM Interop
- **Never pass `null` to COM optional parameters** - use `undefined` instead. COM interprets `null` as VT_NULL which causes type mismatch errors. This is the root cause of SelectByID2 failures.
- **Prefer feature tree traversal** over `SelectByID2` for sketch selection. Use `FeatureByPositionReverse()` + `GetTypeName2()` to find sketches reliably.
- Operations with >12 parameters automatically fall back to VBA macro execution.

### VBScript Execution (cscript.exe)
- **ByRef params fail in VBScript**: `SaveAs3`, `Save3`, `OpenDoc6`, `AddMate5`, `RunMacro2` have ByRef Long params that cause "Type mismatch". Use simpler variants (`SaveAs`/`Save2`/`OpenDoc`/`RunMacro`) or the `.swb` macro workaround.
- **Hybrid VBScript+winax for complex COM**: Some operations need both SelectByID2 (which requires VBScript's `Set nullCallout = Nothing`) AND methods with ByRef params (which need winax). Solution: VBScript selects entities first, then winax calls the COM method — selection state persists in SolidWorks between calls. Example: `add_mate` uses VBScript to select, then winax `AddMate()` to create the mate.
- **CustomPropertyManager**: `Get4`/`Get3`/`Get2` all have ByRef params that fail in VBScript. Use `.Get(propName)` which returns the value directly. Check document-level (`""`) first, then config-specific (`"Default"`).
- **COM values need coercion**: `String()` and `Number()` are required before `JSON.stringify()` — COM BSTR/VARIANT values serialize as `{}` otherwise.
- **`Nothing` vs `Empty`**: VBScript's `Nothing` marshals as VT_NULL which causes type mismatch in SelectByID2. Use `Empty` for optional COM params. Exception: `SelectByID2`'s Callout param works with `Set x = Nothing` passed as a variable.
- **`AddToDB = True`**: Required for sketch entity creation (CreateCircleByRadius, CreateLine) when called from cscript.exe.
- **SafeArray indexing broken in VBScript**: COM SafeArrays from `GetChildren()`, `GetComponents()`, `GetFaces()` can't be indexed — elements return as `Empty`. Walk the feature tree with `FirstFeature`/`GetNextFeature` + `GetTypeName2() = "Reference"` + `GetSpecificFeature2` to get `IComponent2` objects instead.
- **SafeArray crashes in winax/Node.js**: Same COM SafeArrays crash Node.js bypassing try/catch. Always use VBScript to access these.
- **`Set` keyword for COM object properties**: In VBScript, assigning a COM object to a property requires `Set` — e.g. `Set swComp.Transform2 = swTransform`. Without `Set`, you get "Type mismatch". This applies to `Transform2`, `Transform`, and any property that accepts an object.
- **Transform creation**: `MathUtility.CreateTransform(array)` is unreliable in VBScript. Use `CreateTransformRotateAxis(point, vector, angle)` + `CreateTransformTranslateVect(vector)` + `.Multiply()` to compose transforms step by step.
- **Face traversal without SafeArrays**: `IBody2.GetFirstFace()` + `IFace2.GetNextFace()` avoids SafeArray issues. Use `surf.IsCylinder`/`surf.IsPlane` on `face.GetSurface` to identify face types. Note: `CylinderParams` may not return data in VBScript; compute radius from face area instead (`r = area / (2*pi*height)`).

### Inspecting Assembly State (DO NOT use screenshots)
- **Never take screenshots** unless explicitly asked by the user or as an absolute last resort. They fill the context window and text tools provide the same information.
- Use `get_assembly_components` for component positions, rotations, and hierarchy
- Use `get_feature_tree` with `includeDimensions: true` for part geometry
- Use `get_bounding_box` or `get_mass_properties` for spatial understanding
- Reserve `capture_screenshot` for visual verification only when text tools are insufficient

### Code Style
- ESM modules (`"type": "module"` in package.json)
- Zod schemas for all tool input validation
- Winston logging (never use `console.*` - it breaks JSON-RPC stdio transport)
- `@ts-ignore` on winax imports is intentional (no type definitions exist)

## PDM / File Safety
- **Sandbox path**: All file mutations, additions, and VBA-generated file paths MUST use `C:\Eng Vault\Sandbox\JYannessa\` — never write to the production vault root or arbitrary paths.

## Testing
- Mock adapter (`src/adapters/mock-solidworks-adapter.ts`) simulates SolidWorks for CI
- Set `USE_MOCK_SOLIDWORKS=false` for integration tests on Windows with SolidWorks running
