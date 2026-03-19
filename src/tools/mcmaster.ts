/**
 * McMaster-Carr Integration Tools
 *
 * Provides search, part details, and CAD file download from McMaster-Carr.
 * Uses McMaster's internal web part endpoints (reverse-engineered from browser network requests).
 *
 * Endpoint map:
 *   ProductOrderInfo.aspx   — pricing, delivery, description (no auth needed)
 *   ItmPrsnttnWebPart.aspx  — full specs, images, CAD info (needs `cat` cookie)
 *   ProductContent.aspx     — CAD download file paths (needs `cat` cookie)
 *
 * NOTE: These endpoints may change if McMaster updates their site.
 * The version hash in the URL path (e.g. "mv1773779392") rotates periodically.
 */

import { z } from 'zod';
import { logInfo, logError, logOperation } from '../utils/logger.js';
import * as fs from 'fs';
import * as path from 'path';

const MCMASTER_BASE = 'https://www.mcmaster.com';

// Session state
let sessionCookies: string[] = [];
let versionHash: string = '';
let contentVersion: string = 'mvC';
let mcmFeatures: string = '';

/**
 * Make an HTTP request to McMaster-Carr with proper headers.
 * Authenticated requests include x-mcm-features when available.
 */
async function mcmasterFetch(url: string, options: RequestInit = {}, authenticated = false): Promise<Response> {
  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': MCMASTER_BASE,
    'x-requested-with': 'XMLHttpRequest',
    ...(options.headers as Record<string, string> || {}),
  };

  if (authenticated && mcmFeatures) {
    headers['x-mcm-features'] = mcmFeatures;
  }

  if (sessionCookies.length > 0) {
    headers['Cookie'] = sessionCookies.join('; ');
  }

  const response = await fetch(url, {
    ...options,
    headers,
    redirect: 'follow',
  });

  // Capture set-cookie headers for session persistence
  const setCookies = response.headers.getSetCookie?.() || [];
  for (const cookie of setCookies) {
    const name = cookie.split('=')[0];
    sessionCookies = sessionCookies.filter(c => !c.startsWith(name + '='));
    sessionCookies.push(cookie.split(';')[0]);
  }

  return response;
}

/**
 * Check whether we have the `cat` cookie needed for authenticated endpoints.
 */
function hasAuthCookie(): boolean {
  return sessionCookies.some(c => c.startsWith('cat='));
}

/**
 * Initialize a session and extract the version hash from McMaster's homepage.
 */
async function ensureSession(): Promise<void> {
  if (sessionCookies.length > 0 && versionHash) return;

  logInfo('Initializing McMaster-Carr session');
  try {
    const response = await mcmasterFetch(MCMASTER_BASE);
    const html = await response.text();

    const volverMatch = sessionCookies.find(c => c.startsWith('volver='));
    if (volverMatch) {
      versionHash = volverMatch.split('=')[1];
    }

    if (!versionHash) {
      const hashMatch = html.match(/\/(mv\d+)\//);
      if (hashMatch) {
        versionHash = hashMatch[1];
      }
    }

    const stbverMatch = sessionCookies.find(c => c.startsWith('stbver='));
    if (stbverMatch) {
      contentVersion = stbverMatch.split('=')[1];
    }

    if (!versionHash) {
      versionHash = 'mv1773779392';
      logInfo('Using fallback version hash', { versionHash });
    }

    logInfo('McMaster-Carr session initialized', {
      cookies: sessionCookies.length,
      versionHash,
      contentVersion,
    });
  } catch (error) {
    logError('Failed to initialize McMaster-Carr session', error);
    throw new Error('Could not establish session with McMaster-Carr. Check your internet connection.');
  }
}

/**
 * Build the client navigation events parameter for McMaster API calls
 */
function buildNavigationEvents(partNumber: string): string {
  return JSON.stringify([{
    type: 'ORDERINGMASTERPARTNUMBER',
    selectionType: 'SELECTION',
    values: {
      entities: partNumber,
      preselectedComponentPartNumber: '',
      blueprintId: '',
    },
  }]);
}

// ---------------------------------------------------------------------------
// Endpoint: ProductOrderInfo.aspx (no auth required)
// ---------------------------------------------------------------------------

async function fetchProductOrderInfo(partNumber: string): Promise<any> {
  await ensureSession();

  const params = new URLSearchParams({
    partNumber,
    clientNavigationEvents: buildNavigationEvents(partNumber),
    features: 'enableetorightclick,enablerewriteetoeventchain,showoperatorcomponentinpdurl',
  });

  const url = `${MCMASTER_BASE}/${versionHash}/WebParts/OrderServer/ProductOrderInfo.aspx?${params}`;
  const response = await mcmasterFetch(url);

  if (!response.ok) {
    throw new Error(`ProductOrderInfo returned ${response.status}`);
  }

  return await response.json();
}

// ---------------------------------------------------------------------------
// Endpoint: ItmPrsnttnWebPart.aspx (needs `cat` cookie)
// ---------------------------------------------------------------------------

/**
 * Parse the ItmPrsnttnWebPart response. The response body is:
 *   <digits><JSON blob><optional HTML>
 * e.g. "0000019279{...json...}<div ...>"
 * We strip leading digits, then extract the JSON object.
 */
function parseItemPresentationResponse(raw: string): any | null {
  // Strip leading digits
  const stripped = raw.replace(/^\d+/, '');
  if (!stripped.startsWith('{')) return null;

  // Find matching closing brace for the top-level JSON object
  let depth = 0;
  let inString = false;
  let escape = false;
  let endIdx = -1;

  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        endIdx = i + 1;
        break;
      }
    }
  }

  if (endIdx === -1) return null;

  try {
    return JSON.parse(stripped.slice(0, endIdx));
  } catch {
    return null;
  }
}

/**
 * Extract structured specs from ReactData.TableEntries
 */
function extractSpecs(tableEntries: any[]): Record<string, string> {
  const specs: Record<string, string> = {};
  if (!Array.isArray(tableEntries)) return specs;

  for (const entry of tableEntries) {
    if (entry.Name && entry.Value !== undefined && entry.Value !== null) {
      specs[entry.Name] = String(entry.Value);
    }
  }
  return specs;
}

/**
 * Fetch full item presentation data (specs, images, CAD info, descriptions).
 * Requires the `cat` cookie from browser session.
 */
async function fetchItemPresentation(partNumber: string): Promise<any | null> {
  if (!hasAuthCookie()) return null;
  await ensureSession();

  const params = new URLSearchParams({
    partNumber,
    clientNavigationEvents: buildNavigationEvents(partNumber),
    features: 'enablerewriteetoeventchain',
  });

  const url = `${MCMASTER_BASE}/${versionHash}/WebParts/Content/ItmPrsnttnWebPart.aspx?${params}`;

  try {
    const response = await mcmasterFetch(url, {}, true);
    if (!response.ok) return null;

    const raw = await response.text();
    const data = parseItemPresentationResponse(raw);
    if (!data) return null;

    const result: any = {};

    // ReactData contains the richest structured data
    const reactData = data.ReactData || data.reactData || data;

    // Headers — primary and secondary product descriptions
    if (reactData.Headers) {
      result.primaryHeader = reactData.Headers.Primary || null;
      result.secondaryHeader = reactData.Headers.Secondary || null;
    }

    // Table entries — structured specs (material, thickness, hardness, etc.)
    if (reactData.TableEntries) {
      result.specs = extractSpecs(reactData.TableEntries);
    }

    // Copies — product description text blocks
    if (reactData.Copies) {
      result.descriptions = Array.isArray(reactData.Copies)
        ? reactData.Copies.map((c: any) => typeof c === 'string' ? c : c.Text || c.text || '').filter(Boolean)
        : [];
    }

    // CAD download info
    if (reactData.CadDownloadInfo || data.CadDownloadInfo) {
      result.cadDownloadInfo = reactData.CadDownloadInfo || data.CadDownloadInfo;
    }

    // Images
    if (reactData.ImageLayoutComponentDat || data.ImageLayoutComponentDat) {
      const imgData = reactData.ImageLayoutComponentDat || data.ImageLayoutComponentDat;
      result.images = extractImages(imgData);
    }

    return result;
  } catch (error) {
    logError('ItmPrsnttnWebPart fetch failed', error);
    return null;
  }
}

/**
 * Extract image URLs from ImageLayoutComponentDat
 */
function extractImages(imgData: any): string[] {
  if (!imgData) return [];
  const urls: string[] = [];

  // imgData may be an object with image entries or an array
  const items = Array.isArray(imgData) ? imgData : [imgData];
  for (const item of items) {
    if (item.SourcePath) {
      urls.push(`${MCMASTER_BASE}${item.SourcePath}`);
    }
    if (item.sourcePath) {
      urls.push(`${MCMASTER_BASE}${item.sourcePath}`);
    }
    // Some responses nest images in an array
    if (Array.isArray(item.Images)) {
      for (const img of item.Images) {
        if (img.SourcePath) urls.push(`${MCMASTER_BASE}${img.SourcePath}`);
      }
    }
  }
  return urls;
}

// ---------------------------------------------------------------------------
// Endpoint: ProductContent.aspx (needs `cat` cookie)
// ---------------------------------------------------------------------------

async function fetchProductContent(partNumber: string): Promise<any | null> {
  if (!hasAuthCookie()) return null;
  await ensureSession();

  const params = new URLSearchParams({
    partNumber,
    clientNavigationEvents: buildNavigationEvents(partNumber),
    envrmgrcharsetind: '3',
    features: 'enablerewriteetoeventchain,rtrvcadviarps',
  });

  const url = `${MCMASTER_BASE}/${versionHash}/WebParts/Content/ProductContent.aspx?${params}`;

  try {
    const response = await mcmasterFetch(url, {}, true);
    if (!response.ok) return null;

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('json')) {
      return await response.json();
    }

    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  } catch (error) {
    logError('ProductContent fetch failed', error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

async function searchMcMaster(query: string): Promise<any> {
  await ensureSession();
  logOperation('mcmaster_search', 'started', { query });

  const params = new URLSearchParams({
    txtSearch: query,
    selType: 'TxtSearch',
  });

  const searchUrl = `${MCMASTER_BASE}/${versionHash}/WebParts/CatalogServer/CatalogNavigation.aspx?${params}`;

  try {
    const response = await mcmasterFetch(searchUrl);
    const contentType = response.headers.get('content-type') || '';

    if (contentType.includes('json')) {
      const data = await response.json();
      return { query, ...data };
    }

    const html = await response.text();
    const partNumbers = extractPartNumbers(html);

    return {
      query,
      resultCount: partNumbers.length,
      partNumbers,
      note: partNumbers.length === 0
        ? 'Search returned no parseable results. Try using a specific McMaster part number with mcmaster_part_details instead.'
        : undefined,
    };
  } catch (error) {
    return {
      query,
      searchUrl: `${MCMASTER_BASE}/${encodeURIComponent(query)}`,
      error: `Search endpoint failed: ${error}`,
      suggestion: 'If you have a specific part number, use mcmaster_part_details instead.',
    };
  }
}

function extractPartNumbers(html: string): string[] {
  const pattern = /\b(\d{3,6}[A-Z]\d{2,5})\b/g;
  const partNumbers = new Set<string>();
  let match;
  while ((match = pattern.exec(html)) !== null) {
    partNumbers.add(match[1]);
  }
  return Array.from(partNumbers);
}

// ---------------------------------------------------------------------------
// CAD info extraction
// ---------------------------------------------------------------------------

function extractCadInfo(data: any): any | null {
  if (!data?.cadControlDat?.AvailableCAD) return null;

  const cad = data.cadControlDat.AvailableCAD;
  return {
    twoD: (cad.TwoDDownloads || []).map((d: any) => ({
      format: d.DisplayName,
      path: d.FilePath,
      downloadUrl: `${MCMASTER_BASE}${d.FilePath}`,
    })),
    threeD: (cad.ThreeDDownloads || []).map((d: any) => ({
      format: d.DisplayName,
      path: d.FilePath,
      downloadUrl: `${MCMASTER_BASE}${d.FilePath}`,
    })),
    defaultPreference: data.cadControlDat.DefaultPreference,
  };
}

// ---------------------------------------------------------------------------
// Combined part details — merges all three endpoints
// ---------------------------------------------------------------------------

async function getPartDetails(partNumber: string): Promise<any> {
  logOperation('mcmaster_part_details', 'started', { partNumber });

  // Always fetch order info; conditionally fetch authenticated endpoints in parallel
  const [orderInfo, itemPresentation, contentInfo] = await Promise.all([
    fetchProductOrderInfo(partNumber),
    fetchItemPresentation(partNumber).catch(() => null),
    fetchProductContent(partNumber).catch(() => null),
  ]);

  const result: any = {
    partNumber,
    url: `${MCMASTER_BASE}/${partNumber}`,
  };

  // --- From ProductOrderInfo (always available) ---
  result.description = orderInfo.parentDescription;
  result.suffixDescription = orderInfo.suffixDescription;
  result.unitOfMeasure = orderInfo.unitOfMeasure;
  result.delivery = orderInfo.deliveryMessage;

  if (orderInfo.pricingData) {
    result.price = orderInfo.pricingData.price;
    result.priceLevels = orderInfo.pricingData.priceLevels;
  }

  if (orderInfo.productStatusDat?.warningMessage?.length > 0) {
    result.warnings = orderInfo.productStatusDat.warningMessage;
  }

  // --- From ItmPrsnttnWebPart (authenticated — richest data) ---
  if (itemPresentation) {
    if (itemPresentation.primaryHeader) {
      result.primaryHeader = itemPresentation.primaryHeader;
    }
    if (itemPresentation.secondaryHeader) {
      result.secondaryHeader = itemPresentation.secondaryHeader;
    }
    if (itemPresentation.specs && Object.keys(itemPresentation.specs).length > 0) {
      result.specs = itemPresentation.specs;
    }
    if (itemPresentation.descriptions && itemPresentation.descriptions.length > 0) {
      result.productDescriptions = itemPresentation.descriptions;
    }
    if (itemPresentation.images && itemPresentation.images.length > 0) {
      result.imageUrls = itemPresentation.images;
    }
    if (itemPresentation.cadDownloadInfo) {
      result.cadDownloadInfo = itemPresentation.cadDownloadInfo;
    }
  }

  // --- From ProductContent (authenticated — CAD file paths) ---
  const cadInfo = extractCadInfo(contentInfo) || extractCadInfo(orderInfo);
  if (cadInfo) {
    result.cadFiles = cadInfo;
  }

  // Image fallback from content or order info
  if (!result.imageUrls) {
    const imageSource = contentInfo?.displayImage?.sourcePath || orderInfo.displayImage?.sourcePath;
    if (imageSource) {
      result.imageUrls = [`${MCMASTER_BASE}${imageSource}`];
    }
  }

  // Tell the user if authenticated data wasn't available
  if (!hasAuthCookie()) {
    result.note = 'Set browser cookies via mcmaster_set_cookies to get full specs, images, and CAD file paths.';
  }

  return result;
}

// ---------------------------------------------------------------------------
// Set browser cookies
// ---------------------------------------------------------------------------

function setBrowserCookies(cookieString: string, features?: string): void {
  sessionCookies = cookieString.split(';').map(c => c.trim()).filter(Boolean);

  const volverMatch = sessionCookies.find(c => c.startsWith('volver='));
  if (volverMatch) {
    versionHash = volverMatch.split('=')[1];
  }
  const stbverMatch = sessionCookies.find(c => c.startsWith('stbver='));
  if (stbverMatch) {
    contentVersion = stbverMatch.split('=')[1];
  }
  if (features) {
    mcmFeatures = features;
  }

  logInfo('Browser cookies set', {
    count: sessionCookies.length,
    versionHash,
    contentVersion,
    hasAuthCookie: hasAuthCookie(),
    hasMcmFeatures: !!mcmFeatures,
  });
}

// ---------------------------------------------------------------------------
// CAD download
// ---------------------------------------------------------------------------

async function downloadCad(
  partNumber: string,
  format: string,
  destinationPath: string,
  cadFilePath?: string,
  browserCookies?: string,
): Promise<any> {
  if (browserCookies) {
    setBrowserCookies(browserCookies);
  }
  await ensureSession();
  logOperation('mcmaster_download_cad', 'started', { partNumber, format, destinationPath });

  let cadUrl: string;

  if (cadFilePath) {
    cadUrl = cadFilePath.startsWith('http') ? cadFilePath : `${MCMASTER_BASE}${cadFilePath}`;
  } else {
    const details = await getPartDetails(partNumber);

    if (!details.cadFiles) {
      return {
        success: false,
        partNumber,
        error: 'No CAD file paths available. McMaster CAD paths require browser-level session cookies.',
        suggestion: 'Use mcmaster_set_cookies to provide your browser cookies, or provide the cadFilePath directly if you have it.',
        url: details.url,
      };
    }

    const allCadFiles = [...(details.cadFiles.threeD || []), ...(details.cadFiles.twoD || [])];
    const normalizedFormat = format.toUpperCase();

    const cadFile = allCadFiles.find((f: any) => {
      const fmtUpper = f.format.toUpperCase();
      return fmtUpper.includes(normalizedFormat) ||
             (normalizedFormat === 'SOLIDWORKS' && fmtUpper.includes('SOLIDWORKS')) ||
             (normalizedFormat === 'SLDPRT' && fmtUpper.includes('SOLIDWORKS') && fmtUpper.includes('3-D')) ||
             (normalizedFormat === 'SLDDRW' && fmtUpper.includes('SOLIDWORKS') && fmtUpper.includes('2-D'));
    });

    if (!cadFile) {
      return {
        success: false,
        partNumber,
        error: `Format "${format}" not found`,
        availableFormats: allCadFiles.map((f: any) => f.format),
      };
    }

    cadUrl = cadFile.downloadUrl || `${MCMASTER_BASE}${cadFile.path}`;
  }

  try {
    const response = await mcmasterFetch(cadUrl, {}, true);

    if (!response.ok) {
      return {
        success: false,
        partNumber,
        error: `Download returned status ${response.status}. CAD downloads require browser-level session cookies.`,
        cadUrl,
        suggestion: 'Use mcmaster_set_cookies with your browser cookies first, then retry the download.',
      };
    }

    const dir = path.dirname(destinationPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(destinationPath, buffer);

    return {
      success: true,
      partNumber,
      filePath: destinationPath,
      fileSize: buffer.length,
      cadUrl,
    };
  } catch (error) {
    return {
      success: false,
      partNumber,
      error: `Download failed: ${error}`,
      cadUrl,
    };
  }
}

// ---------------------------------------------------------------------------
// Add to PDM — full workflow: download CAD + set properties + generate add VBA
// ---------------------------------------------------------------------------

async function addToPdm(
  partNumber: string,
  vaultLocalPath: string,
  format: string,
  browserCookies?: string,
  customProperties?: Record<string, string>,
): Promise<any> {
  if (browserCookies) {
    setBrowserCookies(browserCookies);
  }

  logOperation('mcmaster_add_to_pdm', 'started', { partNumber, vaultLocalPath, format });

  // Step 1: Get full part details (metadata)
  const details = await getPartDetails(partNumber);

  // Step 2: Determine file name and destination path
  const ext = format.toLowerCase() === 'solidworks' || format.toLowerCase() === 'sldprt'
    ? '.sldprt'
    : format.toLowerCase() === 'slddrw'
      ? '.slddrw'
      : `.${format.toLowerCase()}`;
  const sanitizedPartNumber = partNumber.replace(/[^a-zA-Z0-9_-]/g, '_');
  const fileName = `${sanitizedPartNumber}${ext}`;
  const destinationPath = path.join(vaultLocalPath, fileName);

  // Step 3: Download CAD file
  const downloadResult = await downloadCad(partNumber, format, destinationPath);
  if (!downloadResult.success) {
    return {
      success: false,
      step: 'download',
      partNumber,
      ...downloadResult,
    };
  }

  // Step 4: Build custom properties from McMaster metadata
  const props: Record<string, string> = {
    'McMaster PartNumber': partNumber,
    ...(details.description ? { 'Description': details.description } : {}),
    ...(details.suffixDescription ? { 'Suffix Description': details.suffixDescription } : {}),
    ...(details.price ? { 'Price': details.price } : {}),
    ...(details.unitOfMeasure ? { 'Unit of Measure': details.unitOfMeasure } : {}),
    'Supplier': 'McMaster-Carr',
    'Supplier URL': details.url,
  };

  // Add specs from ItmPrsnttnWebPart if available
  if (details.specs) {
    for (const [name, value] of Object.entries(details.specs)) {
      props[name] = String(value);
    }
  }

  // Merge user-provided custom properties (override defaults)
  if (customProperties) {
    Object.assign(props, customProperties);
  }

  // Step 5: Generate VBA to set custom properties on the file
  const propsVbaLines = Object.entries(props).map(([name, value]) =>
    `    swModel.Extension.CustomPropertyManager("").Add3 "${name.replace(/"/g, '""')}", 30, "${String(value).replace(/"/g, '""')}", 1`
  );

  const setPropsVba = [
    `Sub SetMcMasterProperties()`,
    `    Dim swApp As Object`,
    `    Dim swModel As Object`,
    `    Set swApp = Application.SldWorks`,
    `    Set swModel = swApp.ActiveDoc`,
    `    If swModel Is Nothing Then`,
    `        MsgBox "No active document"`,
    `        Exit Sub`,
    `    End If`,
    ``,
    ...propsVbaLines,
    ``,
    `    swModel.Save2 False, 0, 0`,
    `    MsgBox "McMaster properties set for ${partNumber}"`,
    `End Sub`,
  ].join('\n');

  // Step 6: Generate VBA to add file to PDM vault
  const addToPdmVba = [
    `Sub AddToPDMVault()`,
    `    Dim pdmVault As Object`,
    `    Dim pdmFolder As Object`,
    `    Set pdmVault = CreateObject("ConisioLib.EdmVault")`,
    `    pdmVault.LoginAuto "", 0  ' Uses default vault`,
    ``,
    `    If Not pdmVault.IsLoggedIn Then`,
    `        MsgBox "Failed to login to PDM vault"`,
    `        Exit Sub`,
    `    End If`,
    ``,
    `    Dim destFolder As String`,
    `    destFolder = "${vaultLocalPath.replace(/\\/g, '\\\\').replace(/"/g, '""')}"`,
    `    Set pdmFolder = pdmVault.GetFolderFromPath(destFolder)`,
    ``,
    `    If pdmFolder Is Nothing Then`,
    `        Dim rootFolder As Object`,
    `        Set rootFolder = pdmVault.RootFolder`,
    `        Set pdmFolder = rootFolder.CreateFolderPath(destFolder, 0)`,
    `    End If`,
    ``,
    `    If Not pdmFolder Is Nothing Then`,
    `        pdmFolder.AddFile 0, "${destinationPath.replace(/\\/g, '\\\\').replace(/"/g, '""')}", _`,
    `            "McMaster-Carr part ${partNumber}", 0`,
    `        MsgBox "File added to PDM vault: ${fileName}"`,
    `    Else`,
    `        MsgBox "Could not access vault folder"`,
    `    End If`,
    ``,
    `    pdmVault.Logout`,
    `End Sub`,
  ].join('\n');

  return {
    success: true,
    partNumber,
    filePath: destinationPath,
    fileSize: downloadResult.fileSize,
    metadata: details,
    customProperties: props,
    vba: {
      setProperties: setPropsVba,
      addToVault: addToPdmVba,
      instructions: [
        `1. Open "${fileName}" in SolidWorks`,
        `2. Run the SetMcMasterProperties macro to stamp metadata`,
        `3. Save the file`,
        `4. Run the AddToPDMVault macro to add it to your vault`,
        `   OR: manually drag the file into your PDM vault folder at "${vaultLocalPath}"`,
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Exported MCP tool definitions
// ---------------------------------------------------------------------------

export const mcmasterTools = [
  {
    name: 'mcmaster_set_cookies',
    description: 'Set browser cookies for McMaster-Carr authenticated operations (needed for full specs, images, and CAD downloads). Copy cookies from browser DevTools: Application > Cookies > mcmaster.com. The `cat` cookie is required for authenticated endpoints.',
    inputSchema: z.object({
      cookies: z.string().describe('Cookie string from browser (e.g. "bid=123; volver=mv123; stbver=mvC; cat=5_123_abc")'),
      features: z.string().optional().describe('x-mcm-features header value from browser network tab (optional, improves compatibility)'),
    }),
    handler: async (args: any) => {
      setBrowserCookies(args.cookies, args.features);
      return {
        success: true,
        message: 'Browser cookies set.' + (hasAuthCookie()
          ? ' Authenticated endpoints (full specs, CAD downloads) are now available.'
          : ' WARNING: No `cat` cookie found — authenticated endpoints will not work. Make sure to include the `cat` cookie.'),
        versionHash,
        contentVersion,
        cookieCount: sessionCookies.length,
        hasAuthCookie: hasAuthCookie(),
      };
    },
  },
  {
    name: 'mcmaster_search',
    description: 'Search McMaster-Carr catalog for parts by keyword or category (e.g. "socket head cap screw", "stainless steel rod")',
    inputSchema: z.object({
      query: z.string().describe('Search query - keywords, part description, or category name'),
    }),
    handler: async (args: any) => {
      try {
        return await searchMcMaster(args.query);
      } catch (error) {
        logError('McMaster search failed', error);
        return {
          error: `Search failed: ${error}`,
          suggestion: 'Check your internet connection. If you have a specific part number, use mcmaster_part_details instead.',
        };
      }
    },
  },
  {
    name: 'mcmaster_part_details',
    description: 'Get full details for a McMaster-Carr part number. Without cookies: returns description, pricing, and delivery. With cookies (via mcmaster_set_cookies): also returns full specs table (material, dimensions, hardness, compliance, etc.), product descriptions, images, and CAD file paths.',
    inputSchema: z.object({
      partNumber: z.string().describe('McMaster-Carr part number (e.g. "91251A129", "94355A211")'),
    }),
    handler: async (args: any) => {
      try {
        return await getPartDetails(args.partNumber);
      } catch (error) {
        logError('McMaster part details failed', error);
        return {
          error: `Failed to get part details: ${error}`,
          partNumber: args.partNumber,
          url: `${MCMASTER_BASE}/${args.partNumber}`,
        };
      }
    },
  },
  {
    name: 'mcmaster_download_cad',
    description: 'Download a CAD file for a McMaster-Carr part. Supports STEP, IGES, Solidworks (SLDPRT/SLDDRW), DWG, DXF, Parasolid, SAT, and PDF. Requires browser cookies (use mcmaster_set_cookies first) or a direct cadFilePath.',
    inputSchema: z.object({
      partNumber: z.string().describe('McMaster-Carr part number'),
      format: z.string().default('STEP').describe('CAD format: STEP, IGES, Solidworks, SLDPRT, SLDDRW, DWG, DXF, Parasolid, SAT, or PDF'),
      destinationPath: z.string().describe('Local file path to save the downloaded CAD file'),
      cadFilePath: z.string().optional().describe('Direct CAD file path from a previous mcmaster_part_details response (e.g. "/mvC/Library/CAD2/...")'),
      browserCookies: z.string().optional().describe('Browser cookie string (alternative to using mcmaster_set_cookies first)'),
    }),
    handler: async (args: any) => {
      try {
        return await downloadCad(args.partNumber, args.format, args.destinationPath, args.cadFilePath, args.browserCookies);
      } catch (error) {
        logError('McMaster CAD download failed', error);
        return {
          error: `Download failed: ${error}`,
          partNumber: args.partNumber,
        };
      }
    },
  },
  {
    name: 'mcmaster_add_to_pdm',
    description: 'Full workflow: download a McMaster-Carr CAD file, stamp it with part metadata (description, material, price, specs) as SolidWorks custom properties, and generate VBA macros to add it to your PDM vault. Requires browser cookies for CAD download.',
    inputSchema: z.object({
      partNumber: z.string().describe('McMaster-Carr part number (e.g. "91251A129")'),
      vaultLocalPath: z.string().describe('Local path to your PDM vault working folder (e.g. "C:\\\\PDMVault\\\\Purchased Parts")'),
      format: z.string().default('STEP').describe('CAD format: STEP, IGES, Solidworks, SLDPRT, SLDDRW, DWG, DXF'),
      browserCookies: z.string().optional().describe('Browser cookie string (alternative to using mcmaster_set_cookies first)'),
      customProperties: z.record(z.string()).optional().describe('Additional custom properties to set on the file (e.g. {"Project": "Widget-2024", "Buyer": "J.Smith"})'),
    }),
    handler: async (args: any) => {
      try {
        return await addToPdm(args.partNumber, args.vaultLocalPath, args.format, args.browserCookies, args.customProperties);
      } catch (error) {
        logError('McMaster add-to-PDM failed', error);
        return {
          error: `Add to PDM failed: ${error}`,
          partNumber: args.partNumber,
        };
      }
    },
  },
];
