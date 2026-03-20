import { z } from 'zod';

/**
 * Engineering Calculation Tools
 * Pure computation — no SolidWorks needed, testable on any platform.
 */

// ── ISO 286 Standard Tolerance Grades (IT) ──────────────────────────────
// Fundamental tolerances in micrometers for nominal size ranges.
// Key: [minDia, maxDia, IT01, IT0, IT1, ..., IT18]
const IT_TABLE: Array<{ min: number; max: number; grades: number[] }> = [
  { min: 0,   max: 3,    grades: [0.3, 0.5, 0.8, 1.2, 2, 3, 4, 6, 10, 14, 25, 40, 60, 100, 140, 250, 400, 600, 1000, 1400] },
  { min: 3,   max: 6,    grades: [0.4, 0.6, 1,   1.5, 2.5, 4, 5, 8, 12, 18, 30, 48, 75, 120, 180, 300, 480, 750, 1200, 1800] },
  { min: 6,   max: 10,   grades: [0.4, 0.6, 1,   1.5, 2.5, 4, 6, 9, 15, 22, 36, 58, 90, 150, 220, 360, 580, 900, 1500, 2200] },
  { min: 10,  max: 18,   grades: [0.5, 0.8, 1.2, 2,   3, 5, 8, 11, 18, 27, 43, 70, 110, 180, 270, 430, 700, 1100, 1800, 2700] },
  { min: 18,  max: 30,   grades: [0.6, 1,   1.5, 2.5, 4, 6, 9, 13, 21, 33, 52, 84, 130, 210, 330, 520, 840, 1300, 2100, 3300] },
  { min: 30,  max: 50,   grades: [0.6, 1,   1.5, 2.5, 4, 7, 11, 16, 25, 39, 62, 100, 160, 250, 390, 620, 1000, 1600, 2500, 3900] },
  { min: 50,  max: 80,   grades: [0.8, 1.2, 2,   3,   5, 8, 13, 19, 30, 46, 74, 120, 190, 300, 460, 740, 1200, 1900, 3000, 4600] },
  { min: 80,  max: 120,  grades: [1,   1.5, 2.5, 4,   6, 10, 15, 22, 35, 54, 87, 140, 220, 350, 540, 870, 1400, 2200, 3500, 5400] },
  { min: 120, max: 180,  grades: [1.2, 2,   3.5, 5,   8, 12, 18, 25, 40, 63, 100, 160, 250, 400, 630, 1000, 1600, 2500, 4000, 6300] },
  { min: 180, max: 250,  grades: [2,   3,   4.5, 7,   10, 14, 20, 29, 46, 72, 115, 185, 290, 460, 720, 1150, 1850, 2900, 4600, 7200] },
  { min: 250, max: 315,  grades: [2.5, 4,   6,   8,   12, 16, 23, 32, 52, 81, 130, 210, 320, 520, 810, 1300, 2100, 3200, 5200, 8100] },
  { min: 315, max: 400,  grades: [3,   5,   7,   9,   13, 18, 25, 36, 57, 89, 140, 230, 360, 570, 890, 1400, 2300, 3600, 5700, 8900] },
  { min: 400, max: 500,  grades: [4,   6,   8,   10,  15, 20, 27, 40, 63, 97, 155, 250, 400, 630, 970, 1550, 2500, 4000, 6300, 9700] },
];

// Fundamental deviation lookup for common shaft and hole letter codes (micrometers)
// Simplified subset covering the most common fits
function getFundamentalDeviation(letter: string, nominalSize: number, isHole: boolean): number {
  // For uppercase (holes): the deviation is the lower deviation
  // For lowercase (shafts): the deviation is the upper deviation

  // Common hole deviations (lower deviation in μm)
  const holeDeviations: Record<string, (d: number) => number> = {
    'A': (d) => +(265 + 1.3 * d),
    'B': (d) => +(140 + 0.85 * d),
    'C': (d) => +(52 + 0.2 * d),
    'D': (d) => +(16 * Math.pow(d, 0.44)),
    'E': (d) => +(11 * Math.pow(d, 0.41)),
    'F': (d) => +(5.5 * Math.pow(d, 0.41)),
    'G': (d) => +(2.5 * Math.pow(d, 0.34)),
    'H': () => 0,
    'JS': () => 0, // symmetric — handled separately
    'J': (d) => -(0.5 * getITValue(d, 6)), // approximate
    'K': (d) => -(0.6 * getITValue(d, 6)),
    'M': (d) => -(getITValue(d, 6) - getITValue(d, 7)),
    'N': (d) => -(5 * Math.pow(d, 0.34)),
    'P': (d) => -(getITValue(d, 7) + 1.3 * Math.pow(d, 0.34)),
  };

  const shaftDeviations: Record<string, (d: number) => number> = {
    'a': (d) => -(265 + 1.3 * d),
    'b': (d) => -(140 + 0.85 * d),
    'c': (d) => -(52 + 0.2 * d),
    'd': (d) => -(16 * Math.pow(d, 0.44)),
    'e': (d) => -(11 * Math.pow(d, 0.41)),
    'f': (d) => -(5.5 * Math.pow(d, 0.41)),
    'g': (d) => -(2.5 * Math.pow(d, 0.34)),
    'h': () => 0,
    'js': () => 0,
    'j': (d) => +(0.5 * getITValue(d, 5)),
    'k': (d) => +(0.6 * getITValue(d, 6)),
    'm': (d) => +(getITValue(d, 6) - getITValue(d, 7)),
    'n': (d) => +(5 * Math.pow(d, 0.34)),
    'p': (d) => +(getITValue(d, 7) + 1.3 * Math.pow(d, 0.34)),
    'r': (d) => +(getITValue(d, 7) + 2.5 * Math.pow(d, 0.34)),
    's': (d) => +(getITValue(d, 7) + 3.5 * Math.pow(d, 0.41)),
  };

  const lookup = isHole ? holeDeviations : shaftDeviations;
  const fn = lookup[letter];
  if (!fn) {
    throw new Error(`Unknown fit letter: ${letter}. Supported: ${Object.keys(lookup).join(', ')}`);
  }
  return fn(nominalSize);
}

function getITValue(nominalSize: number, gradeIndex: number): number {
  const row = IT_TABLE.find(r => nominalSize > r.min && nominalSize <= r.max);
  if (!row) throw new Error(`Nominal size ${nominalSize}mm outside supported range (0-500mm)`);
  return row.grades[gradeIndex] || 0;
}

function getToleranceForGrade(nominalSize: number, grade: number): number {
  // grade 01 = index 0, grade 0 = index 1, grade 1 = index 2, etc.
  let index: number;
  if (grade === -1) index = 0;      // IT01
  else if (grade === 0) index = 1;   // IT0
  else index = grade + 1;            // IT1..IT18

  return getITValue(nominalSize, index);
}

// Parse fit designation like "H7" into { letter: 'H', grade: 7 }
function parseFitCode(code: string): { letter: string; grade: number } {
  const match = code.match(/^([A-Za-z]{1,2})(\d+)$/);
  if (!match) throw new Error(`Invalid fit code: "${code}". Expected format like H7, g6, js5`);
  return { letter: match[1], grade: parseInt(match[2]) };
}

export const toleranceStackAnalysisTool = {
    name: 'tolerance_stack_analysis',
    description: 'NO SOLIDWORKS NEEDED — runs on any platform. 1D tolerance stack-up analysis using worst-case and RSS (root sum of squares) methods',
    inputSchema: z.object({
      dimensions: z.array(z.object({
        name: z.string().describe('Dimension label'),
        nominal: z.number().describe('Nominal value in mm'),
        plusTolerance: z.number().describe('Upper tolerance (+) in mm'),
        minusTolerance: z.number().describe('Lower tolerance (-) in mm, enter as positive'),
        direction: z.enum(['+', '-']).describe('+ adds to gap, - subtracts from gap')
      })).min(1),
      targetGap: z.object({
        name: z.string().default('Gap'),
        min: z.number().optional().describe('Minimum acceptable gap in mm'),
        max: z.number().optional().describe('Maximum acceptable gap in mm')
      }).optional()
    }),
    handler: (args: any) => {
      const dims = args.dimensions;

      // Nominal gap
      let nominalGap = 0;
      for (const dim of dims) {
        nominalGap += dim.direction === '+' ? dim.nominal : -dim.nominal;
      }

      // Worst-case analysis
      let wcMax = 0;
      let wcMin = 0;
      for (const dim of dims) {
        if (dim.direction === '+') {
          wcMax += dim.nominal + dim.plusTolerance;
          wcMin += dim.nominal - dim.minusTolerance;
        } else {
          wcMax -= dim.nominal - dim.minusTolerance;
          wcMin -= dim.nominal + dim.plusTolerance;
        }
      }

      // RSS (statistical) analysis
      // Mean gap = sum of means considering direction
      let meanGap = 0;
      let sumVariance = 0;
      const contributions: Array<{ name: string; nominal: number; tolerance: number; varianceContribution: number; percentContribution: number }> = [];

      for (const dim of dims) {
        const mean = dim.nominal + (dim.plusTolerance - dim.minusTolerance) / 2;
        const halfRange = (dim.plusTolerance + dim.minusTolerance) / 2;
        // Assume 3-sigma process: tolerance = 3*sigma, so sigma = halfRange/3
        const variance = Math.pow(halfRange / 3, 2);

        meanGap += dim.direction === '+' ? mean : -mean;
        sumVariance += variance;

        contributions.push({
          name: dim.name,
          nominal: dim.nominal,
          tolerance: halfRange * 2,
          varianceContribution: variance,
          percentContribution: 0 // filled below
        });
      }

      const totalVariance = sumVariance;
      for (const c of contributions) {
        c.percentContribution = totalVariance > 0
          ? Math.round(c.varianceContribution / totalVariance * 10000) / 100
          : 0;
      }

      const rssStdDev = Math.sqrt(totalVariance);
      const rssMin = meanGap - 3 * rssStdDev;
      const rssMax = meanGap + 3 * rssStdDev;

      // Pass/fail check
      let passFail: any = null;
      if (args.targetGap) {
        const target = args.targetGap;
        passFail = {
          name: target.name || 'Gap',
          worstCase: {
            pass: (target.min === undefined || wcMin >= target.min) && (target.max === undefined || wcMax <= target.max),
            min: wcMin,
            max: wcMax
          },
          statistical: {
            pass: (target.min === undefined || rssMin >= target.min) && (target.max === undefined || rssMax <= target.max),
            min: rssMin,
            max: rssMax
          }
        };
      }

      return {
        nominal: Math.round(nominalGap * 10000) / 10000,
        worstCase: {
          min: Math.round(wcMin * 10000) / 10000,
          max: Math.round(wcMax * 10000) / 10000,
          range: Math.round((wcMax - wcMin) * 10000) / 10000
        },
        statistical: {
          mean: Math.round(meanGap * 10000) / 10000,
          stdDev: Math.round(rssStdDev * 10000) / 10000,
          min3sigma: Math.round(rssMin * 10000) / 10000,
          max3sigma: Math.round(rssMax * 10000) / 10000,
          range3sigma: Math.round((rssMax - rssMin) * 10000) / 10000
        },
        contributions: contributions.sort((a, b) => b.percentContribution - a.percentContribution),
        passFail
      };
    }
  };

export const fitAnalysisTool = {
    name: 'fit_analysis',
    description: 'NO SOLIDWORKS NEEDED — runs on any platform. ISO 286 shaft/hole fit calculator. Given a nominal size and fit designation, returns limits, clearance/interference, and fit type.',
    inputSchema: z.object({
      nominalSize: z.number().min(0.001).max(500).describe('Nominal diameter in mm'),
      holeFit: z.string().describe('Hole fit code (e.g. H7, H8, G7)'),
      shaftFit: z.string().describe('Shaft fit code (e.g. g6, h6, k6, p6)')
    }),
    handler: (args: any) => {
      const d = args.nominalSize;
      const hole = parseFitCode(args.holeFit);
      const shaft = parseFitCode(args.shaftFit);

      // Validate letter case
      if (hole.letter !== hole.letter.toUpperCase()) {
        throw new Error(`Hole fit must use uppercase letter (got "${hole.letter}")`);
      }
      if (shaft.letter !== shaft.letter.toLowerCase()) {
        throw new Error(`Shaft fit must use lowercase letter (got "${shaft.letter}")`);
      }

      // Get tolerances in micrometers
      const holeTolerance = getToleranceForGrade(d, hole.grade);
      const shaftTolerance = getToleranceForGrade(d, shaft.grade);

      // Get fundamental deviations in micrometers
      const holeEI = getFundamentalDeviation(hole.letter, d, true); // lower deviation
      const shaftEs = getFundamentalDeviation(shaft.letter, d, false); // upper deviation

      // Hole: EI = lower deviation, ES = EI + tolerance
      let holeMin: number, holeMax: number;
      if (hole.letter === 'JS') {
        // JS: symmetric about zero
        holeMin = -holeTolerance / 2;
        holeMax = holeTolerance / 2;
      } else {
        holeMin = holeEI;
        holeMax = holeEI + holeTolerance;
      }

      // Shaft: es = upper deviation, ei = es - tolerance
      let shaftMax: number, shaftMin: number;
      if (shaft.letter === 'js') {
        shaftMax = shaftTolerance / 2;
        shaftMin = -shaftTolerance / 2;
      } else {
        shaftMax = shaftEs;
        shaftMin = shaftEs - shaftTolerance;
      }

      // Convert to mm
      const holeLimits = {
        min: Math.round((d + holeMin / 1000) * 10000) / 10000,
        max: Math.round((d + holeMax / 1000) * 10000) / 10000,
        tolerance: Math.round(holeTolerance) / 1000
      };

      const shaftLimits = {
        min: Math.round((d + shaftMin / 1000) * 10000) / 10000,
        max: Math.round((d + shaftMax / 1000) * 10000) / 10000,
        tolerance: Math.round(shaftTolerance) / 1000
      };

      // Clearance = hole - shaft (positive = clearance, negative = interference)
      const maxClearance = (holeMax - shaftMin) / 1000;
      const minClearance = (holeMin - shaftMax) / 1000;

      // Determine fit type
      let fitType: string;
      if (minClearance > 0) {
        fitType = 'Clearance';
      } else if (maxClearance < 0) {
        fitType = 'Interference';
      } else {
        fitType = 'Transition';
      }

      return {
        designation: `${args.holeFit}/${args.shaftFit}`,
        nominalSize: d,
        hole: {
          code: args.holeFit,
          minDiameter: holeLimits.min,
          maxDiameter: holeLimits.max,
          tolerance: Math.round(holeLimits.tolerance * 10000) / 10000
        },
        shaft: {
          code: args.shaftFit,
          minDiameter: shaftLimits.min,
          maxDiameter: shaftLimits.max,
          tolerance: Math.round(shaftLimits.tolerance * 10000) / 10000
        },
        fit: {
          type: fitType,
          maxClearance: Math.round(maxClearance * 10000) / 10000,
          minClearance: Math.round(minClearance * 10000) / 10000,
          maxInterference: minClearance < 0 ? Math.round(-minClearance * 10000) / 10000 : 0,
          minInterference: maxClearance < 0 ? Math.round(-maxClearance * 10000) / 10000 : 0
        }
      };
    }
  };

export const engineeringCalcTools = [toleranceStackAnalysisTool, fitAnalysisTool];
