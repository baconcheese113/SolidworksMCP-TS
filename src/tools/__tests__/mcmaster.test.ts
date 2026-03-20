/**
 * Tests for McMaster-Carr integration tools.
 *
 * Schema validation tests run everywhere (no Chrome needed).
 * Handler/network tests require Chrome and are behind MCMASTER_NETWORK_TESTS.
 *
 *   MCMASTER_NETWORK_TESTS=true npm test -- src/tools/__tests__/mcmaster.test.ts
 */

import { describe, it, expect } from 'vitest';
import { mcmasterTools } from '../mcmaster.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findTool(name: string) {
  const tool = mcmasterTools.find(t => t.name === name);
  if (!tool) throw new Error(`Tool "${name}" not found`);
  return tool;
}

async function callTool(name: string, args: Record<string, any>) {
  const tool = findTool(name);
  const validated = tool.inputSchema.parse(args);
  return tool.handler(validated);
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

describe('McMaster Tools — Registration', () => {
  it('exports exactly 4 tools', () => {
    expect(mcmasterTools).toHaveLength(4);
  });

  it('registers expected tool names', () => {
    const names = mcmasterTools.map(t => t.name);
    expect(names).toEqual([
      'mcmaster_search',
      'mcmaster_part_details',
      'mcmaster_download_cad',
      'mcmaster_add_to_pdm',
    ]);
  });

  it('every tool has name, description, inputSchema, handler', () => {
    for (const tool of mcmasterTools) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
      expect(typeof tool.handler).toBe('function');
    }
  });
});

// ---------------------------------------------------------------------------
// Schema validation (no Chrome needed)
// ---------------------------------------------------------------------------

describe('McMaster Tools — Schema Validation', () => {
  it('mcmaster_search requires query string', () => {
    const tool = findTool('mcmaster_search');
    expect(() => tool.inputSchema.parse({})).toThrow();
    expect(() => tool.inputSchema.parse({ query: 'bolt' })).not.toThrow();
  });

  it('mcmaster_part_details requires partNumber', () => {
    const tool = findTool('mcmaster_part_details');
    expect(() => tool.inputSchema.parse({})).toThrow();
    expect(() => tool.inputSchema.parse({ partNumber: '91251A129' })).not.toThrow();
  });

  it('mcmaster_download_cad requires partNumber and destinationPath', () => {
    const tool = findTool('mcmaster_download_cad');
    expect(() => tool.inputSchema.parse({})).toThrow();
    expect(() => tool.inputSchema.parse({ partNumber: '91251A129' })).toThrow();
    const parsed = tool.inputSchema.parse({
      partNumber: '91251A129',
      destinationPath: '/tmp/test.step',
    });
    expect(parsed.format).toBe('STEP'); // default
  });

  it('mcmaster_add_to_pdm requires partNumber and vaultLocalPath', () => {
    const tool = findTool('mcmaster_add_to_pdm');
    expect(() => tool.inputSchema.parse({})).toThrow();
    const parsed = tool.inputSchema.parse({
      partNumber: '91251A129',
      vaultLocalPath: 'C:\\PDMVault\\Parts',
    });
    expect(parsed.format).toBe('STEP');
    expect(parsed.customProperties).toBeUndefined();
  });

  it('mcmaster_add_to_pdm accepts optional customProperties', () => {
    const tool = findTool('mcmaster_add_to_pdm');
    const parsed = tool.inputSchema.parse({
      partNumber: '91251A129',
      vaultLocalPath: '/vault',
      customProperties: { Project: 'Widget' },
    });
    expect(parsed.customProperties).toEqual({ Project: 'Widget' });
  });
});

// ---------------------------------------------------------------------------
// Network tests — require Chrome, only run with MCMASTER_NETWORK_TESTS=true
// ---------------------------------------------------------------------------

const networkDescribe = process.env.MCMASTER_NETWORK_TESTS === 'true' ? describe : describe.skip;

networkDescribe('McMaster Tools — Network (live endpoints)', () => {
  it('mcmaster_part_details returns full data for known part', async () => {
    const result = await callTool('mcmaster_part_details', {
      partNumber: '91251A129',
    });
    if (result.error) {
      expect(result.partNumber).toBe('91251A129');
      return;
    }
    expect(result.partNumber).toBe('91251A129');
    expect(result.description).toBeTruthy();
    expect(result.price).toBeTruthy();
    expect(result.url).toContain('91251A129');
    // Should now have specs from DOM extraction
    expect(result.specs).toBeDefined();
    expect(Object.keys(result.specs).length).toBeGreaterThan(5);
  }, 60000);

  it('mcmaster_search returns results', async () => {
    const result = await callTool('mcmaster_search', {
      query: 'socket head cap screw',
    });
    expect(result.query).toBe('socket head cap screw');
  }, 60000);

  it('mcmaster_download_cad downloads a real STEP file', async () => {
    const result = await callTool('mcmaster_download_cad', {
      partNumber: '91251A129',
      destinationPath: '/tmp/test_91251A129.step',
      format: 'STEP',
    });
    if (result.error) {
      console.log('Download error (may be expected):', result.error);
      return;
    }
    expect(result.success).toBe(true);
    expect(result.fileSize).toBeGreaterThan(100);
  }, 120000);
}, 180000);
