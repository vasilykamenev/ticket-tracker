import { describe, expect, it } from 'vitest';
import { PRIORITY_TONES, STATUS_BAR, STATUS_TONES, TYPE, type Tone } from '../../src/admin/tokens.js';

function luminance(hex: string): number {
  const channel = (i: number) => {
    const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

function contrast(tone: Tone): number {
  const [a, b] = [luminance(tone.color), luminance(tone.background)].sort((x, y) => y - x);
  return (a! + 0.05) / (b! + 0.05);
}

describe('design tokens', () => {
  it('keeps the text of every status and priority readable (WCAG AA, 4.5:1)', () => {
    for (const [name, tone] of [...Object.entries(STATUS_TONES), ...Object.entries(PRIORITY_TONES)]) {
      expect(contrast(tone), name).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('gives every workflow status its own color family: blue, indigo, yellow, green, red, grey', () => {
    expect(Object.keys(STATUS_TONES).sort()).toEqual(['CLOSED', 'IN_PROGRESS', 'NEW', 'RESOLVED', 'UNRESOLVED', 'WAITING_CUSTOMER']);
    const colors = Object.values(STATUS_TONES).map((t) => t.color);
    expect(new Set(colors).size).toBe(colors.length);
  });

  it('has a chart color for every status, different for each', () => {
    expect(Object.keys(STATUS_BAR).sort()).toEqual(Object.keys(STATUS_TONES).sort());
    expect(new Set(Object.values(STATUS_BAR)).size).toBe(Object.keys(STATUS_BAR).length);
  });

  it('never makes labels smaller than 12 px', () => {
    expect(TYPE.label).toBeGreaterThanOrEqual(12);
    expect(TYPE.small).toBeGreaterThanOrEqual(12);
  });
});
