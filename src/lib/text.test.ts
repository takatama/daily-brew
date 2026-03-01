import { describe, expect, it } from 'vitest';
import {
  hashString,
  jaccardSimilarity,
  normalizeTitle,
  normalizeUrl,
  tokenizeTitle,
} from './text';

describe('normalizeUrl', () => {
  it('trims, lowercases, and strips trailing slash', () => {
    expect(normalizeUrl('  HTTPS://Example.com/Path/  ')).toBe(
      'https://example.com/path',
    );
  });

  it('handles url without trailing slash', () => {
    expect(normalizeUrl('https://example.com')).toBe('https://example.com');
  });
});

describe('normalizeTitle', () => {
  it('lowercases and replaces non-alphanumeric with spaces', () => {
    expect(normalizeTitle('Hello, World! 2024')).toBe('hello world 2024');
  });

  it('collapses multiple spaces', () => {
    expect(normalizeTitle('  foo   bar  ')).toBe('foo bar');
  });

  it('handles Japanese characters', () => {
    expect(normalizeTitle('コーヒー新製品!')).toBe('コーヒー新製品');
  });
});

describe('tokenizeTitle', () => {
  it('splits into tokens and filters single-char tokens', () => {
    const tokens = tokenizeTitle('a big coffee event');
    expect(tokens).toEqual(new Set(['big', 'coffee', 'event']));
  });

  it('returns empty set for empty string', () => {
    expect(tokenizeTitle('')).toEqual(new Set());
  });
});

describe('jaccardSimilarity', () => {
  it('returns 1 for identical sets', () => {
    const s = new Set(['coffee', 'news']);
    expect(jaccardSimilarity(s, s)).toBe(1);
  });

  it('returns 0 for disjoint sets', () => {
    const a = new Set(['coffee']);
    const b = new Set(['tea']);
    expect(jaccardSimilarity(a, b)).toBe(0);
  });

  it('returns 0 when either set is empty', () => {
    expect(jaccardSimilarity(new Set(), new Set(['a']))).toBe(0);
    expect(jaccardSimilarity(new Set(['a']), new Set())).toBe(0);
  });

  it('computes correct similarity for overlapping sets', () => {
    const a = new Set(['coffee', 'news', 'today']);
    const b = new Set(['coffee', 'news', 'event']);
    // intersection=2, union=4
    expect(jaccardSimilarity(a, b)).toBe(0.5);
  });
});

describe('hashString', () => {
  it('produces a deterministic hash', () => {
    const h1 = hashString('test');
    const h2 = hashString('test');
    expect(h1).toBe(h2);
  });

  it('starts with n_ prefix', () => {
    expect(hashString('hello')).toMatch(/^n_[0-9a-f]+$/);
  });

  it('produces different hashes for different inputs', () => {
    expect(hashString('a')).not.toBe(hashString('b'));
  });
});
