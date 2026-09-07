import { describe, expect, it } from 'vitest';
import { resolveCountry } from './countries.js';

describe('country extraction', () => {
  it.each([
    [' Poland ', 'Poland'], ['poland', 'Poland'], ['Warsaw, Poland', 'Poland'],
    ['New York, NY, USA', 'United States'], ['UK', 'United Kingdom'],
    ['London, England', 'United Kingdom'], ['Türkiye', 'Turkey'], ['Cape Verde', 'Cabo Verde'],
    ['Berlin (Germany)', 'Germany'], ['Poland / Poland', 'Poland']
  ])('resolves %s as %s', (value, country) => {
    expect(resolveCountry(value)).toBe(country);
  });

  it.each([null, '', '   ', 'Unknown', 'None', 'N/A', 'Remote', 'London', 'Indiana', 'Probably Poland', 'Morocco / Luxembourg'])('keeps uncertain locations unknown: %s', (value) => {
    expect(resolveCountry(value)).toBeNull();
  });
});
