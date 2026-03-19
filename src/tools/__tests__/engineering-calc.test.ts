import { describe, it, expect } from 'vitest';
import {
  engineeringCalcTools,
  toleranceStackAnalysisTool,
  fitAnalysisTool
} from '../engineering-calc.js';
import { z } from 'zod';

type StackInput = z.input<typeof toleranceStackAnalysisTool.inputSchema>;
type FitInput = z.input<typeof fitAnalysisTool.inputSchema>;

function callToleranceStack(args: StackInput) {
  const validated = toleranceStackAnalysisTool.inputSchema.parse(args);
  return toleranceStackAnalysisTool.handler(validated);
}

function callFitAnalysis(args: FitInput) {
  const validated = fitAnalysisTool.inputSchema.parse(args);
  return fitAnalysisTool.handler(validated);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe('Engineering Calc Tools — Registration', () => {
  it('exports exactly 2 tools', () => {
    expect(engineeringCalcTools).toHaveLength(2);
  });

  it('registers expected tool names', () => {
    const names = engineeringCalcTools.map(t => t.name);
    expect(names).toEqual(['tolerance_stack_analysis', 'fit_analysis']);
  });
});

// ---------------------------------------------------------------------------
// Tolerance Stack Analysis
// ---------------------------------------------------------------------------

describe('tolerance_stack_analysis', () => {
  it('computes a simple 2-dimension stack', () => {
    const result = callToleranceStack({
      dimensions: [
        { name: 'Housing', nominal: 50, plusTolerance: 0.1, minusTolerance: 0.1, direction: '+' },
        { name: 'Shaft',   nominal: 49, plusTolerance: 0.05, minusTolerance: 0.05, direction: '-' }
      ]
    });

    // Nominal gap: 50 - 49 = 1mm
    expect(result.nominal).toBeCloseTo(1, 4);

    // Worst case: max = (50+0.1) - (49-0.05) = 1.15
    //             min = (50-0.1) - (49+0.05) = 0.85
    expect(result.worstCase.max).toBeCloseTo(1.15, 4);
    expect(result.worstCase.min).toBeCloseTo(0.85, 4);
  });

  it('reports contributions sorted by percentage', () => {
    const result = callToleranceStack({
      dimensions: [
        { name: 'A', nominal: 10, plusTolerance: 0.5, minusTolerance: 0.5, direction: '+' },
        { name: 'B', nominal: 5,  plusTolerance: 0.1, minusTolerance: 0.1, direction: '-' },
        { name: 'C', nominal: 3,  plusTolerance: 0.3, minusTolerance: 0.3, direction: '-' }
      ]
    });

    expect(result.contributions[0].name).toBe('A');
    expect(result.contributions[0].percentContribution).toBeGreaterThan(50);
  });

  it('evaluates pass/fail against target gap', () => {
    const result = callToleranceStack({
      dimensions: [
        { name: 'Outer', nominal: 100, plusTolerance: 0.2, minusTolerance: 0.2, direction: '+' },
        { name: 'Inner', nominal: 99,  plusTolerance: 0.1, minusTolerance: 0.1, direction: '-' }
      ],
      targetGap: { name: 'Clearance', min: 0.5, max: 1.5 }
    });

    expect(result.passFail).not.toBeNull();
    expect(result.passFail!.name).toBe('Clearance');
    // Nominal gap = 1mm, WC range = [0.7, 1.3] — should pass
    expect(result.passFail!.worstCase.pass).toBe(true);
  });

  it('detects failure when tolerance is too wide', () => {
    const result = callToleranceStack({
      dimensions: [
        { name: 'A', nominal: 10, plusTolerance: 1, minusTolerance: 1, direction: '+' },
        { name: 'B', nominal: 9,  plusTolerance: 1, minusTolerance: 1, direction: '-' }
      ],
      targetGap: { name: 'Gap', min: 0.5, max: 1.5 }
    });

    // WC range: [-1, 3] — exceeds [0.5, 1.5]
    expect(result.passFail!.worstCase.pass).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fit Analysis
// ---------------------------------------------------------------------------

describe('fit_analysis', () => {
  it('computes H7/g6 clearance fit at 25mm', () => {
    const result = callFitAnalysis({
      nominalSize: 25,
      holeFit: 'H7',
      shaftFit: 'g6'
    });

    expect(result.designation).toBe('H7/g6');
    expect(result.fit.type).toBe('Clearance');
    expect(result.fit.maxClearance).toBeGreaterThan(0);
    expect(result.fit.minClearance).toBeGreaterThan(0);

    // H7 hole: min = 25.000, max > 25.000
    expect(result.hole.minDiameter).toBe(25);
    expect(result.hole.maxDiameter).toBeGreaterThan(25);

    // g6 shaft: both limits below 25
    expect(result.shaft.maxDiameter).toBeLessThan(25);
    expect(result.shaft.minDiameter).toBeLessThan(result.shaft.maxDiameter);
  });

  it('computes H7/p6 interference fit at 25mm', () => {
    const result = callFitAnalysis({
      nominalSize: 25,
      holeFit: 'H7',
      shaftFit: 'p6'
    });

    expect(result.fit.type).toBe('Transition');
    // p6 shaft should have positive fundamental deviation
    expect(result.shaft.minDiameter).toBeGreaterThan(25);
  });

  it('computes H7/h6 fit at 50mm', () => {
    const result = callFitAnalysis({
      nominalSize: 50,
      holeFit: 'H7',
      shaftFit: 'h6'
    });

    expect(result.designation).toBe('H7/h6');
    // H7/h6 is a transition fit (min clearance = 0 when both at nominal)
    expect(['Clearance', 'Transition']).toContain(result.fit.type);
    // h6 shaft: upper deviation = 0 (shaft max = nominal)
    expect(result.shaft.maxDiameter).toBe(50);
    expect(result.shaft.minDiameter).toBeLessThan(50);
  });

  it('rejects lowercase hole code', () => {
    expect(() => callFitAnalysis({
      nominalSize: 25,
      holeFit: 'h7',
      shaftFit: 'g6'
    })).toThrow(/uppercase/);
  });

  it('rejects uppercase shaft code', () => {
    expect(() => callFitAnalysis({
      nominalSize: 25,
      holeFit: 'H7',
      shaftFit: 'G6'
    })).toThrow(/lowercase/);
  });

  it('works across size ranges', () => {
    // Small: 2mm
    const small = callFitAnalysis({ nominalSize: 2, holeFit: 'H7', shaftFit: 'g6' });
    expect(small.fit.type).toBe('Clearance');

    // Large: 200mm
    const large = callFitAnalysis({ nominalSize: 200, holeFit: 'H7', shaftFit: 'g6' });
    expect(large.fit.type).toBe('Clearance');

    // Tolerance should scale with size
    expect(large.hole.tolerance).toBeGreaterThan(small.hole.tolerance);
  });
});
