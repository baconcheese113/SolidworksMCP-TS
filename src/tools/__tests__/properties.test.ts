import { describe, it, expect } from 'vitest';
import {
  propertyTools,
  getCustomPropertiesTool,
  setCustomPropertiesTool,
  getFeatureTreeTool,
  getActiveDocumentInfoTool
} from '../properties.js';

describe('Property Tools — Registration', () => {
  it('exports exactly 4 tools', () => {
    expect(propertyTools).toHaveLength(4);
  });

  it('registers expected tool names', () => {
    const names = propertyTools.map(t => t.name);
    expect(names).toEqual([
      'get_custom_properties',
      'set_custom_properties',
      'get_feature_tree',
      'get_active_document_info'
    ]);
  });
});

describe('Property Tools — Schema Validation', () => {
  it('get_custom_properties accepts empty args', () => {
    const result = getCustomPropertiesTool.inputSchema.parse({});
    expect(result).toEqual({});
  });

  it('get_custom_properties accepts configuration', () => {
    const result = getCustomPropertiesTool.inputSchema.parse({ configuration: 'Default' });
    expect(result.configuration).toBe('Default');
  });

  it('set_custom_properties requires at least one property', () => {
    expect(() => setCustomPropertiesTool.inputSchema.parse({ properties: [] })).toThrow();
  });

  it('set_custom_properties validates property array', () => {
    const result = setCustomPropertiesTool.inputSchema.parse({
      properties: [
        { name: 'PartNumber', value: 'ABC-123' },
        { name: 'Cost', value: '42.50', type: 'number' }
      ]
    });
    expect(result.properties).toHaveLength(2);
    expect(result.properties[0].type).toBe('text'); // default
    expect(result.properties[1].type).toBe('number');
  });

  it('get_feature_tree has defaults', () => {
    const result = getFeatureTreeTool.inputSchema.parse({});
    expect(result.includeSuppressionState).toBe(true);
    expect(result.maxFeatures).toBe(500);
  });

  it('get_active_document_info accepts empty args', () => {
    const result = getActiveDocumentInfoTool.inputSchema.parse({});
    expect(result).toEqual({});
  });
});
