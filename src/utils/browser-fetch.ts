/**
 * Browser-based fetch using puppeteer-core + puppeteer-extra-plugin-stealth.
 *
 * McMaster-Carr is protected by Akamai Bot Manager which blocks non-browser
 * requests via TLS fingerprinting and JavaScript-based bot detection.
 *
 * This module launches headless Chrome with puppeteer-extra's stealth plugin,
 * which patches dozens of browser fingerprinting vectors that Akamai checks
 * (webdriver, plugins, languages, WebGL, codecs, iframe identity, etc.).
 *
 * Design:
 *   - Lazy singleton: Chrome launches on first call, stays alive for reuse
 *   - Stealth: puppeteer-extra-plugin-stealth handles all evasion automatically
 *   - No manual cookies needed: browser gets its own session automatically
 *   - Binary downloads return base64-encoded data
 *   - DOM extraction: can navigate to pages and extract data from rendered HTML
 *   - Auto-cleanup on process exit / idle timeout
 */

import puppeteerCore, { type Browser, type Page } from 'puppeteer-core';
import { addExtra } from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { logInfo, logError } from './logger.js';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const puppeteer = addExtra(puppeteerCore as any);
puppeteer.use(StealthPlugin());

let browser: Browser | null = null;
let page: Page | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let sessionReady = false;
let detectedChromeVersion: string | null = null;

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Find Chrome/Chromium executable on the system.
 */
export function findChromePath(): string | null {
  const candidates: string[] = [];

  if (process.platform === 'win32') {
    candidates.push(
      path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['LOCALAPPDATA'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    );
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    );
  }

  for (const p of candidates) {
    if (p && fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

/**
 * Detect the actual Chrome major version by running `--version`.
 * Falls back to a recent stable version if detection fails.
 */
export function detectChromeVersion(chromePath: string): string {
  if (detectedChromeVersion) return detectedChromeVersion;

  try {
    const raw = execSync(`"${chromePath}" --version`, {
      timeout: 5000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const match = raw.match(/(\d+\.\d+\.\d+\.\d+)/);
    if (match) {
      detectedChromeVersion = match[1];
      return detectedChromeVersion;
    }
  } catch {
    // --version can fail on some platforms; fall through
  }

  detectedChromeVersion = '131.0.0.0';
  return detectedChromeVersion;
}

/**
 * Build a user-agent string that matches the actual installed Chrome version
 * and real platform. Akamai cross-references the UA with the TLS fingerprint,
 * so the version must match the binary that produced the TLS ClientHello.
 */
function buildUserAgent(chromeVersion: string): string {
  if (process.platform === 'darwin') {
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
  }
  if (process.platform === 'win32') {
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
  }
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
}

/**
 * Parse a cookie string array (["name=value", ...]) into puppeteer cookie objects.
 */
export function parseCookiesForBrowser(cookies: string[]): Array<{ name: string; value: string; domain: string; path: string }> {
  return cookies
    .filter(c => c.includes('='))
    .map(c => {
      const eqIdx = c.indexOf('=');
      return {
        name: c.slice(0, eqIdx).trim(),
        value: c.slice(eqIdx + 1).trim(),
        domain: '.www.mcmaster.com',
        path: '/',
      };
    });
}

/**
 * Wait for the Akamai `cat` cookie with polling instead of a fixed sleep.
 * Returns true if the cookie appeared, false on timeout.
 */
async function waitForCatCookie(pg: Page, timeoutMs: number = 15000): Promise<boolean> {
  const start = Date.now();
  const pollInterval = 500;

  while (Date.now() - start < timeoutMs) {
    const cookies = await pg.cookies();
    if (cookies.some(c => c.name === 'cat')) return true;
    await new Promise(r => setTimeout(r, pollInterval));
  }

  return false;
}

/**
 * Launch Chrome with puppeteer-extra stealth plugin and establish a McMaster
 * session. Uses `headless: true` which is the new headless mode in puppeteer
 * v22+ — it shares the real Chrome rendering and network stack.
 */
async function ensureBrowser(): Promise<Page> {
  resetIdleTimer();

  if (browser && page) {
    try {
      await browser.version();
      return page;
    } catch {
      browser = null;
      page = null;
      sessionReady = false;
    }
  }

  const chromePath = findChromePath();
  if (!chromePath) {
    throw new Error(
      'Chrome not found. Install Google Chrome to use McMaster features. ' +
      'Expected locations: ' + (process.platform === 'win32'
        ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
        : process.platform === 'darwin'
          ? '/Applications/Google Chrome.app'
          : '/usr/bin/google-chrome')
    );
  }

  const chromeVersion = detectChromeVersion(chromePath);
  const ua = buildUserAgent(chromeVersion);
  logInfo('Launching Chrome for McMaster requests', { chromePath, chromeVersion });

  browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-infobars',
      '--no-first-run',
      '--password-store=basic',
      '--use-mock-keychain',
      `--user-agent=${ua}`,
    ],
  }) as unknown as Browser;

  page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  logInfo('Navigating to McMaster homepage to establish session...');

  await page.goto('https://www.mcmaster.com', { waitUntil: 'networkidle2', timeout: 60000 });

  const hasCat = await waitForCatCookie(page);

  if (!hasCat) {
    logInfo('cat cookie not set on first load, reloading once...');
    await page.reload({ waitUntil: 'networkidle2', timeout: 60000 });
    await waitForCatCookie(page, 10000);
  }

  sessionReady = true;

  const cookies = await page.cookies();
  const catCookie = cookies.find(c => c.name === 'cat');
  const volver = cookies.find(c => c.name === 'volver');

  logInfo('Chrome browser ready', {
    cookies: cookies.length,
    hasCat: !!catCookie,
    volver: volver?.value,
    chromeVersion,
  });

  return page;
}

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    closeBrowser().catch(() => {});
  }, IDLE_TIMEOUT_MS);
}

export interface BrowserFetchResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string; // text or base64 if binary
}

/**
 * Get all cookies from the browser's cookie jar.
 * Returns ["name=value", ...] format.
 */
export async function getBrowserCookies(): Promise<string[]> {
  const pg = await ensureBrowser();
  const cookies = await pg.cookies();
  return cookies.map(c => `${c.name}=${c.value}`);
}

/**
 * Check if the browser has a specific cookie.
 */
export async function hasBrowserCookie(name: string): Promise<boolean> {
  const pg = await ensureBrowser();
  const cookies = await pg.cookies();
  return cookies.some(c => c.name === name);
}

/**
 * Get a specific cookie value from the browser.
 */
export async function getBrowserCookieValue(name: string): Promise<string | null> {
  const pg = await ensureBrowser();
  const cookies = await pg.cookies();
  const cookie = cookies.find(c => c.name === name);
  return cookie?.value ?? null;
}

/**
 * Inject cookies into the browser's cookie jar.
 */
export async function injectCookies(cookies: string[]): Promise<void> {
  const pg = await ensureBrowser();
  const cookieObjects = parseCookiesForBrowser(cookies);
  if (cookieObjects.length > 0) {
    await pg.setCookie(...cookieObjects);
  }
}

/**
 * Navigate a NEW page to a URL for DOM extraction.
 * Uses a separate page from the session page to avoid navigation conflicts.
 * The new page inherits cookies from the browser context and stealth patches.
 */
export async function navigateTo(url: string): Promise<Page> {
  await ensureBrowser();

  const navPage = await browser!.newPage();
  await navPage.setViewport({ width: 1920, height: 1080 });
  await navPage.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  await navPage.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise(r => setTimeout(r, 3000));

  return navPage;
}

/**
 * Make an HTTP request through Chrome's network stack.
 * The browser's own cookies (including the `cat` Akamai token) are sent
 * automatically via credentials: 'include'.
 */
export async function browserFetch(
  url: string,
  options?: {
    method?: string;
    headers?: Record<string, string>;
    cookies?: string[];
    binary?: boolean;
    body?: string;
  },
): Promise<BrowserFetchResult> {
  const pg = await ensureBrowser();

  if (options?.cookies && options.cookies.length > 0) {
    const cookieObjects = parseCookiesForBrowser(options.cookies);
    if (cookieObjects.length > 0) {
      await pg.setCookie(...cookieObjects);
    }
  }

  const fetchOptions: Record<string, any> = {
    method: options?.method || 'GET',
    headers: options?.headers || {},
    credentials: 'include',
  };

  if (options?.body !== undefined) {
    fetchOptions.body = options.body;
  }

  const binary = options?.binary ?? false;

  const result = await pg.evaluate(
    async (fetchUrl: string, fetchOpts: Record<string, any>, isBinary: boolean) => {
      try {
        const resp = await fetch(fetchUrl, fetchOpts);
        const headers: Record<string, string> = {};
        resp.headers.forEach((v, k) => { headers[k] = v; });

        let body: string;
        if (isBinary) {
          const buffer = await resp.arrayBuffer();
          const bytes = new Uint8Array(buffer);
          let binaryStr = '';
          for (let i = 0; i < bytes.length; i++) {
            binaryStr += String.fromCharCode(bytes[i]);
          }
          body = btoa(binaryStr);
        } else {
          body = await resp.text();
        }

        return {
          status: resp.status,
          statusText: resp.statusText,
          headers,
          body,
          error: null,
        };
      } catch (err: any) {
        return {
          status: 0,
          statusText: '',
          headers: {} as Record<string, string>,
          body: '',
          error: err?.message || String(err),
        };
      }
    },
    url,
    fetchOptions,
    binary,
  );

  if (result.error) {
    throw new Error(`Browser fetch failed: ${result.error}`);
  }

  return {
    status: result.status,
    statusText: result.statusText,
    headers: result.headers,
    body: result.body,
  };
}

/**
 * Close the browser instance and clean up.
 */
export async function closeBrowser(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (browser) {
    try {
      await browser.close();
    } catch {
      // Ignore close errors
    }
    browser = null;
    page = null;
    sessionReady = false;
    logInfo('Chrome browser closed');
  }
}

/**
 * Close and re-launch the browser. Use when the session is stale
 * (e.g. `cat` cookie missing after initial load).
 */
export async function resetSession(): Promise<void> {
  detectedChromeVersion = null;
  await closeBrowser();
}

// Cleanup on process exit
process.on('exit', () => {
  if (browser) {
    browser.close().catch(() => {});
  }
});

process.on('SIGINT', () => {
  closeBrowser().then(() => process.exit(0)).catch(() => process.exit(1));
});
