/**
 * Tests for browser-fetch utility (Chrome detection and cookie parsing).
 * Actual browser launch tests require Chrome and are behind MCMASTER_NETWORK_TESTS.
 */

import { describe, it, expect, vi } from 'vitest';
import { findChromePath, parseCookiesForBrowser, detectChromeVersion } from '../browser-fetch.js';

describe('browser-fetch — Chrome detection', () => {
  it('findChromePath returns a string or null', () => {
    const result = findChromePath();
    expect(result === null || typeof result === 'string').toBe(true);
  });

  it('detectChromeVersion returns a version string', () => {
    const chromePath = findChromePath();
    if (!chromePath) return; // skip if no Chrome installed
    const version = detectChromeVersion(chromePath);
    expect(version).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });
});

describe('browser-fetch — Cookie parsing', () => {
  it('parses simple cookies', () => {
    const cookies = parseCookiesForBrowser(['bid=123', 'cat=token456']);
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toEqual({
      name: 'bid',
      value: '123',
      domain: '.www.mcmaster.com',
      path: '/',
    });
    expect(cookies[1]).toEqual({
      name: 'cat',
      value: 'token456',
      domain: '.www.mcmaster.com',
      path: '/',
    });
  });

  it('handles cookies with = in value', () => {
    const cookies = parseCookiesForBrowser(['cat=2_123_abc=def']);
    expect(cookies).toHaveLength(1);
    expect(cookies[0].name).toBe('cat');
    expect(cookies[0].value).toBe('2_123_abc=def');
  });

  it('filters out entries without =', () => {
    const cookies = parseCookiesForBrowser(['bid=123', 'invalid', 'cat=456']);
    expect(cookies).toHaveLength(2);
    expect(cookies[0].name).toBe('bid');
    expect(cookies[1].name).toBe('cat');
  });

  it('handles empty array', () => {
    const cookies = parseCookiesForBrowser([]);
    expect(cookies).toHaveLength(0);
  });
});
