/**
 * McMaster-Carr Integration Tools
 *
 * Provides search, part details, and CAD file download from McMaster-Carr.
 * All requests go through headless Chrome (puppeteer-core) to bypass Akamai
 * Bot Manager's TLS fingerprinting and JavaScript-based bot detection.
 *
 * No manual cookies needed — Chrome obtains the `cat` session token automatically
 * via stealth evasion (disabling automation signals).
 *
 * Data sources:
 *   ProductOrderInfo.aspx — pricing, delivery, description
 *   ProductContent.aspx   — CAD download file paths
 *   DOM extraction         — full specs table from rendered product page
 */

import { z } from 'zod';
import { logInfo, logError, logOperation } from '../utils/logger.js';
import {
  browserFetch,
  closeBrowser,
  getBrowserCookieValue,
  hasBrowserCookie,
  navigateTo,
  resetSession,
} from '../utils/browser-fetch.js';
import * as fs from 'fs';
import * as path from 'path';

const MCMASTER_BASE = 'https://www.mcmaster.com';

// Version hash and content version — extracted from browser cookies
let versionHash: string = '';
let contentVersion: string = 'mvC';

/**
 * Ensure we have the versionHash from browser cookies.
 * This is called after ensureBrowser() has navigated to mcmaster.com.
 */
async function ensureVersionHash(): Promise<void> {
  if (versionHash) return;

  try {
    const volver = await getBrowserCookieValue('volver');
    if (volver) {
      versionHash = volver;
    }
    const stbver = await getBrowserCookieValue('stbver');
    if (stbver) {
      contentVersion = stbver;
    }
  } catch {
    // getBrowserCookieValue triggers ensureBrowser which may already be running
  }

  if (!versionHash) {
    versionHash = 'mv1773949599';
    logInfo('Using fallback version hash', { versionHash });
  }

  logInfo('McMaster session ready', { versionHash, contentVersion });
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
// Endpoint: ProductOrderInfo.aspx (pricing, delivery, description)
// ---------------------------------------------------------------------------

async function fetchProductOrderInfo(partNumber: string): Promise<any> {
  await ensureVersionHash();

  const params = new URLSearchParams({
    partNumber,
    clientNavigationEvents: buildNavigationEvents(partNumber),
    features: 'enableetorightclick,enablerewriteetoeventchain,showoperatorcomponentinpdurl',
  });

  const url = `${MCMASTER_BASE}/${versionHash}/WebParts/OrderServer/ProductOrderInfo.aspx?${params}`;
  const response = await browserFetch(url, {
    headers: { 'x-requested-with': 'XMLHttpRequest' },
  });

  if (response.status !== 200) {
    throw new Error(`ProductOrderInfo returned ${response.status}`);
  }

  return JSON.parse(response.body);
}

// ---------------------------------------------------------------------------
// DOM Extraction: Navigate to product page and extract specs from rendered HTML
// ---------------------------------------------------------------------------

async function extractSpecsFromDOM(partNumber: string): Promise<{
  specs: Record<string, string>;
  primaryHeader: string | null;
  images: string[];
  notFound: boolean;
}> {
  const navPage = await navigateTo(`${MCMASTER_BASE}/${partNumber}`);

  try {
    // Check for "No matches" page (invalid part number)
    const bodyText = await navPage.evaluate(() => document.body?.innerText?.slice(0, 1000) || '');
    if (bodyText.includes('No matches were found')) {
      return { specs: {}, primaryHeader: null, images: [], notFound: true };
    }

    const data = await navPage.evaluate(() => {
      const result: any = { specs: {}, primaryHeader: null, images: [] };

      // Primary header (product name)
      const h1 = document.querySelector('h1');
      result.primaryHeader = h1?.textContent?.trim() || null;

      // Specs table — extract label/value pairs from all tables
      const tables = Array.from(document.querySelectorAll('table'));
      for (const table of tables) {
        const rows = Array.from(table.querySelectorAll('tr'));
        for (const row of rows) {
          const cells = Array.from(row.querySelectorAll('td, th'));
          if (cells.length >= 2) {
            const label = cells[0].textContent?.trim();
            const value = cells[1].textContent?.trim();
            if (label && value && label.length < 100 && value.length < 200) {
              result.specs[label] = value;
            }
          }
        }
      }

      // Images — only product-specific images (ImageCache), not site chrome
      const imgEls = Array.from(document.querySelectorAll('img[src*="ImageCache"], img[src*="CAD"]'));
      for (const img of imgEls) {
        const src = (img as HTMLImageElement).src;
        if (src && !result.images.includes(src) && !src.includes('BrowseCatalog') && !src.includes('CategoryTiles')) {
          result.images.push(src);
        }
      }

      return result;
    });

    return { ...data, notFound: false };
  } finally {
    await navPage.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Endpoint: ProductContent.aspx (CAD file paths)
// ---------------------------------------------------------------------------

async function fetchProductContent(partNumber: string): Promise<any | null> {
  await ensureVersionHash();

  const params = new URLSearchParams({
    partNumber,
    clientNavigationEvents: buildNavigationEvents(partNumber),
    envrmgrcharsetind: '3',
    features: 'enablerewriteetoeventchain,rtrvcadviarps',
  });

  const url = `${MCMASTER_BASE}/${versionHash}/WebParts/Content/ProductContent.aspx?${params}`;

  try {
    const response = await browserFetch(url, {
      headers: {
        'Accept': '*/*',
        'Referer': `${MCMASTER_BASE}/${partNumber}`,
        'x-requested-with': 'XMLHttpRequest',
      },
    });

    if (response.status !== 200) return null;

    const text = response.body;

    // Try direct JSON parse
    try {
      return JSON.parse(text);
    } catch {
      // Fall through
    }

    // Try extracting JSON from HTML-wrapped response
    const htmlStripped = text.replace(/<[^>]*>/g, '').trim();
    try {
      return JSON.parse(htmlStripped);
    } catch {
      // Fall through
    }

    // Try digit-prefix format (e.g. "0000019279{...json...}")
    const parsed = parseDigitPrefixResponse(text) || parseDigitPrefixResponse(htmlStripped);
    if (parsed) return parsed;

    logInfo('fetchProductContent: could not parse response', {
      bodyLength: text.length,
      bodyPreview: text.slice(0, 200),
    });
    return null;
  } catch (error) {
    logError('ProductContent fetch failed', error);
    return null;
  }
}

/**
 * Parse a response with digit prefix: "0000019279{...json...}<optional HTML>"
 */
function parseDigitPrefixResponse(raw: string): any | null {
  const stripped = raw.replace(/^\d+/, '');
  if (!stripped.startsWith('{')) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  let endIdx = -1;

  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { endIdx = i + 1; break; }
    }
  }

  if (endIdx === -1) return null;

  try {
    return JSON.parse(stripped.slice(0, endIdx));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Search — DOM scraping of McMaster search results page
// ---------------------------------------------------------------------------

interface CategoryResult {
  name: string;
  description: string;
  productCount?: number;
  url?: string;
}

async function searchMcMaster(query: string): Promise<any> {
  logOperation('mcmaster_search', 'started', { query });

  try {
    const navPage = await navigateTo(`${MCMASTER_BASE}/${encodeURIComponent(query)}`);

    try {
      const data = await navPage.evaluate(() => {
        const bodyText = document.body?.innerText || '';

        // Extract total product count (e.g. "14,873 Products")
        const totalMatch = bodyText.match(/([\d,]+)\s+Products?/);
        const totalCount = totalMatch ? parseInt(totalMatch[1].replace(/,/g, ''), 10) : 0;

        // Extract product categories with descriptions and counts
        // McMaster renders categories as blocks: name, description, "N products"
        const categories: Array<{
          name: string;
          description: string;
          productCount?: number;
          url?: string;
        }> = [];

        // Get all links — category links go to /products/ or subcategory pages
        const links = Array.from(document.querySelectorAll('a[href]'));
        const catLinks = links.filter(l => {
          const href = (l as HTMLAnchorElement).getAttribute('href') || '';
          // Category links have product counts or descriptive text nearby
          const text = l.textContent?.trim() || '';
          return text.length > 3 && text.length < 100 &&
            !href.startsWith('/orders') && !href.startsWith('/contact') &&
            !href.startsWith('/order-history') && href !== '/';
        });

        // Look for category blocks in the body text
        // Pattern: category name, then description, then "N products"
        const lines = bodyText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        const productCountPattern = /^([\d,]+)\s+products?$/i;

        for (let i = 0; i < lines.length; i++) {
          const countMatch = lines[i].match(productCountPattern);
          if (!countMatch) continue;

          const count = parseInt(countMatch[1].replace(/,/g, ''), 10);
          // Look backwards for the category name and description
          // Usually: name (i-2), description (i-1), "N products" (i)
          let name = '';
          let description = '';

          if (i >= 2 && lines[i - 1].length > 10 && lines[i - 2].length > 3) {
            name = lines[i - 2];
            description = lines[i - 1];
          } else if (i >= 1 && lines[i - 1].length > 3) {
            name = lines[i - 1];
          }

          // Skip UI elements and the total count line
          const skipNames = ['Print', 'Forward', 'Log in', 'ORDER', 'ORDER HISTORY', 'How can we improve?'];
          if (name && !name.match(productCountPattern) && !skipNames.includes(name) && count !== totalCount) {
            // Find URL for this category
            const matchingLink = catLinks.find(l => l.textContent?.trim() === name);
            const url = matchingLink ? (matchingLink as HTMLAnchorElement).href : undefined;

            categories.push({ name, description, productCount: count, url });
          }
        }

        // Extract available filter dimensions (so LLM knows what filtering is possible)
        const filters: string[] = [];
        const filterLabels = ['System of Measurement', 'Thread Size', 'Length', 'Material',
          'Fastener Head Type', 'Threading', 'Finish', 'Drive Style', 'Thread Type',
          'Thread Spacing', 'Thread Pitch', 'Tensile Strength', 'Inner Diameter',
          'Outer Diameter', 'Width', 'Thickness', 'Shaft Diameter', 'OD', 'ID',
          'Housing Type', 'Shaft Type', 'Load Capacity', 'Dynamic Load Capacity',
          'Temperature', 'Pressure Rating', 'Bore Diameter'];
        for (const label of filterLabels) {
          if (bodyText.includes(label)) filters.push(label);
        }

        // Extract any part numbers that might be on the page (rare but possible for direct matches)
        const partPattern = /\b(\d{3,6}[A-Z]\d{2,5})\b/g;
        const partMatches = bodyText.match(partPattern);
        const partNumbers = partMatches ? [...new Set(partMatches)] : [];

        return { totalCount, categories, filters, partNumbers };
      });

      // If we found part numbers directly (specific search hit a product table)
      if (data.partNumbers.length > 0) {
        const enriched = [];
        for (const pn of data.partNumbers.slice(0, 10)) {
          try {
            const orderInfo = await fetchProductOrderInfo(pn);
            enriched.push({
              partNumber: pn,
              description: [orderInfo.parentDescription, orderInfo.suffixDescription].filter(Boolean).join(' — '),
              price: orderInfo.pricingData?.price,
            });
          } catch {
            enriched.push({ partNumber: pn, description: '' });
          }
        }
        return {
          query,
          totalProducts: data.totalCount,
          partNumbers: data.partNumbers,
          products: enriched,
          categories: data.categories.length > 0 ? data.categories : undefined,
          availableFilters: data.filters,
          note: `Found ${data.partNumbers.length} specific products. Use mcmaster_part_details for full specs, or mcmaster_download_cad to download a CAD file.`,
        };
      }

      // Categories-only result (broad search)
      if (data.categories.length > 0) {
        return {
          query,
          totalProducts: data.totalCount,
          categories: data.categories,
          availableFilters: data.filters,
          note: 'Search returned product categories. To find specific part numbers, try a more specific search (e.g. add material or size) or browse mcmaster.com directly. Use mcmaster_part_details if you already have a part number.',
        };
      }

      return {
        query,
        totalProducts: data.totalCount,
        availableFilters: data.filters,
        note: 'No products or categories found. Try different search terms (e.g. "socket head cap screw" instead of "bolt"). Use mcmaster_part_details if you have a specific part number.',
      };
    } finally {
      await navPage.close().catch(() => {});
    }
  } catch (error) {
    return {
      query,
      error: `Search failed: ${error}`,
      suggestion: 'If you have a specific part number, use mcmaster_part_details instead.',
    };
  }
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
// Combined part details — merges all data sources
// ---------------------------------------------------------------------------

async function getPartDetails(partNumber: string): Promise<any> {
  logOperation('mcmaster_part_details', 'started', { partNumber });

  const result = await _getPartDetailsOnce(partNumber);

  // If we got pricing but no specs and no CAD, the session may be degraded.
  // Reset the browser and try once more.
  const hasCat = await hasBrowserCookie('cat').catch(() => false);
  const hasContent = !!result.cadFiles || (result.specs && Object.keys(result.specs).length > 0);

  if (!hasContent && !hasCat && result.description) {
    logInfo('Session appears degraded (no cat cookie, no content). Resetting browser and retrying...', { partNumber });
    await resetSession();
    return _getPartDetailsOnce(partNumber);
  }

  return result;
}

async function _getPartDetailsOnce(partNumber: string): Promise<any> {
  const domData = await extractSpecsFromDOM(partNumber).catch(() => ({ specs: {}, primaryHeader: null, images: [], notFound: false }));

  // Now make API calls — the page is on mcmaster.com so fetch() works from this context
  const [orderInfo, contentInfo] = await Promise.all([
    fetchProductOrderInfo(partNumber),
    fetchProductContent(partNumber).catch(() => null),
  ]);

  const result: any = {
    partNumber,
    url: `${MCMASTER_BASE}/${partNumber}`,
  };

  // --- From ProductOrderInfo (pricing, delivery) ---
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

  // --- From DOM extraction (specs, images, header) ---
  if (domData.primaryHeader) {
    result.primaryHeader = domData.primaryHeader;
  }
  if (Object.keys(domData.specs).length > 0) {
    result.specs = domData.specs;
  }
  if (domData.images.length > 0) {
    result.imageUrls = domData.images;
  }

  if (domData.notFound) {
    result.warning = `Part number "${partNumber}" was not found on McMaster-Carr. This may be a catalog/category page number, not an individual product number.`;
  }

  // --- From ProductContent (CAD file paths) ---
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

  // Detect catalog/category pages: they return specs but no pricing or description
  if (!domData.notFound && !result.description && !result.price) {
    result.warning = `Part number "${partNumber}" appears to be a catalog or category page, not an individual product. No pricing or description available.`;
  }

  // Attach diagnostics for internal use by downloadCad error reporting
  const hasCat = await hasBrowserCookie('cat').catch(() => false);
  result._diagnostics = {
    orderInfoOk: !!orderInfo,
    specsFromDOM: Object.keys(domData.specs).length,
    contentOk: !!contentInfo,
    hasCatCookie: hasCat,
    versionHash,
    hasCadFiles: !!result.cadFiles,
  };

  logInfo('Part details diagnostics', result._diagnostics);

  return result;
}

// ---------------------------------------------------------------------------
// CAD download
// ---------------------------------------------------------------------------

async function downloadCad(
  partNumber: string,
  format: string,
  destinationPath: string,
  cadFilePath?: string,
): Promise<any> {
  await ensureVersionHash();
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
        error: 'No CAD file paths available.',
        diagnostics: details._diagnostics,
        suggestion: 'CAD files may not be available for this part, or the ProductContent endpoint returned no data. Try calling mcmaster_part_details first to check.',
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
    let response = await browserFetch(cadUrl, {
      headers: {
        'Accept': 'application/octet-stream, */*',
        'Referer': `${MCMASTER_BASE}/${partNumber}`,
      },
      binary: true,
    });

    // Retry once on 403 (Akamai rate limiting)
    if (response.status === 403) {
      await new Promise(r => setTimeout(r, 2000));
      response = await browserFetch(cadUrl, {
        headers: {
          'Accept': 'application/octet-stream, */*',
          'Referer': `${MCMASTER_BASE}/${partNumber}`,
        },
        binary: true,
      });
    }

    if (response.status !== 200) {
      return {
        success: false,
        partNumber,
        error: `Download returned status ${response.status}`,
        statusText: response.statusText,
        cadUrl,
      };
    }

    const dir = path.dirname(destinationPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const buffer = Buffer.from(response.body, 'base64');

    // Validate that we got actual CAD data, not an HTML error page
    const headerStr = buffer.slice(0, 50).toString('utf-8');
    const headerLower = headerStr.toLowerCase();
    if (headerLower.includes('<!doctype') || headerLower.includes('<html')) {
      return {
        success: false,
        partNumber,
        error: 'Download returned HTML instead of CAD data — session may be expired',
        bodyPreview: buffer.slice(0, 200).toString('utf-8'),
        cadUrl,
        suggestion: 'Try the request again. The browser session may have expired.',
      };
    }

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
  customProperties?: Record<string, string>,
): Promise<any> {
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

  // Add specs from DOM extraction if available
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
    name: 'mcmaster_search',
    description: `Search McMaster-Carr catalog by keyword. Returns matching products with part numbers, descriptions, and prices when the search is specific (e.g. "linear ball bearing 12mm"), or product categories with counts when the search is broad (e.g. "bearing"). Works on any platform — no SolidWorks needed. The first call launches a headless Chrome browser and may take 15-30 seconds; subsequent calls reuse the session. Use mcmaster_part_details to get full specs for a specific part number.`,
    inputSchema: z.object({
      query: z.string().describe('Search keywords — e.g. "linear ball bearing 12mm", "M4 socket head cap screw", "O-ring". More specific queries return individual products with part numbers; broad queries return categories.'),
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
    description: `Get full details for a specific McMaster-Carr part number: description, pricing tiers, delivery estimate, full specs table (material, dimensions, tolerances, compliance), available CAD file formats with download paths, and product images. Works on any platform — no SolidWorks needed. The part number format is digits + letter + digits (e.g. "91251A129"). Call mcmaster_search first if you don't have a part number. Returns cadFiles field with available 2D/3D formats — pass a cadFilePath to mcmaster_download_cad to skip redundant lookups.`,
    inputSchema: z.object({
      partNumber: z.string().describe('McMaster-Carr part number — must be a specific product number like "91251A129", not a category name'),
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
    description: `Download a CAD file for a McMaster-Carr part to a local path. Works on any platform — no SolidWorks needed. Supports STEP, IGES, Solidworks (SLDPRT/SLDDRW), DWG, DXF, Parasolid, SAT, and PDF. Not all parts have CAD files — fasteners and mechanical parts usually do, but consumables typically don't. Tip: call mcmaster_part_details first and pass the cadFilePath from cadFiles to skip a redundant product lookup.`,
    inputSchema: z.object({
      partNumber: z.string().describe('McMaster-Carr part number (e.g. "91251A129")'),
      format: z.string().default('STEP').describe('CAD format: STEP, IGES, Solidworks, SLDPRT, SLDDRW, DWG, DXF, Parasolid, SAT, or PDF'),
      destinationPath: z.string().describe('Full local file path to save the CAD file (e.g. "/Users/me/Downloads/91251A129.step"). Parent directories are created automatically.'),
      cadFilePath: z.string().optional().describe('Optional: direct CAD file path from a previous mcmaster_part_details cadFiles response — skips a redundant lookup'),
    }),
    handler: async (args: any) => {
      try {
        return await downloadCad(args.partNumber, args.format, args.destinationPath, args.cadFilePath);
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
    description: 'Full workflow: download a McMaster-Carr CAD file, stamp it with part metadata (description, material, price, specs) as SolidWorks custom properties, and generate VBA macros to add it to your PDM vault. The download step works on any platform. The generated VBA macros must be run on Windows with SolidWorks to set properties and check into PDM.',
    inputSchema: z.object({
      partNumber: z.string().describe('McMaster-Carr part number (e.g. "91251A129")'),
      vaultLocalPath: z.string().describe('Local path to your PDM vault working folder (e.g. "C:\\\\PDMVault\\\\Purchased Parts")'),
      format: z.string().default('STEP').describe('CAD format: STEP, IGES, Solidworks, SLDPRT, SLDDRW, DWG, DXF'),
      customProperties: z.record(z.string()).optional().describe('Additional custom properties to set on the file (e.g. {"Project": "Widget-2024", "Buyer": "J.Smith"})'),
    }),
    handler: async (args: any) => {
      try {
        return await addToPdm(args.partNumber, args.vaultLocalPath, args.format, args.customProperties);
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
