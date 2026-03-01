import { describe, expect, it } from 'vitest';
import type { NewsItem } from '../types';
import {
  isBlockedByHistory,
  selectNextCandidate,
  updateHistory,
} from './candidates';

function makeItem(overrides: Partial<NewsItem> = {}): NewsItem {
  return {
    id: 'test-id',
    title: 'Test Coffee News',
    summary: 'A summary',
    url: 'https://example.com/article',
    source: 'Test Source',
    publishedAt: null,
    generatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('isBlockedByHistory', () => {
  it('blocks when URL matches', () => {
    const candidate = makeItem({ url: 'https://example.com/article' });
    const history = [makeItem({ url: 'https://example.com/article/' })];
    expect(isBlockedByHistory(candidate, history)).toBe(true);
  });

  it('blocks when title matches exactly', () => {
    const candidate = makeItem({ title: 'Coffee News', url: 'https://a.com' });
    const history = [makeItem({ title: 'Coffee News!', url: 'https://b.com' })];
    expect(isBlockedByHistory(candidate, history)).toBe(true);
  });

  it('blocks when title is substring', () => {
    const candidate = makeItem({
      title: 'Coffee News Today',
      url: 'https://a.com',
    });
    const history = [
      makeItem({ title: 'Coffee News Today is Great', url: 'https://b.com' }),
    ];
    expect(isBlockedByHistory(candidate, history)).toBe(true);
  });

  it('blocks when jaccard similarity is high', () => {
    const candidate = makeItem({
      title: 'New Coffee Brewing Method Released',
      url: 'https://a.com',
    });
    const history = [
      makeItem({
        title: 'New Coffee Brewing Method Announced',
        url: 'https://b.com',
      }),
    ];
    expect(isBlockedByHistory(candidate, history)).toBe(true);
  });

  it('does not block for different content', () => {
    const candidate = makeItem({
      title: 'Coffee Roasting Guide',
      url: 'https://a.com',
    });
    const history = [
      makeItem({ title: 'Tea Brewing Festival', url: 'https://b.com' }),
    ];
    expect(isBlockedByHistory(candidate, history)).toBe(false);
  });
});

describe('selectNextCandidate', () => {
  it('returns null for empty candidates', () => {
    expect(selectNextCandidate([], [], 5)).toBeNull();
  });

  it('returns first candidate when history is empty', () => {
    const candidates = [
      makeItem({ id: '1' }),
      makeItem({ id: '2', url: 'https://other.com' }),
    ];
    expect(selectNextCandidate(candidates, [], 5)?.id).toBe('1');
  });

  it('skips candidates blocked by history', () => {
    const candidates = [
      makeItem({ id: '1', url: 'https://example.com/a' }),
      makeItem({ id: '2', url: 'https://example.com/b', title: 'Different' }),
    ];
    const history = [makeItem({ url: 'https://example.com/a' })];
    expect(selectNextCandidate(candidates, history, 5)?.id).toBe('2');
  });

  it('falls back to relaxed history when all are blocked', () => {
    const candidates = [
      makeItem({ id: '1', url: 'https://a.com', title: 'Alpha' }),
      makeItem({ id: '2', url: 'https://b.com', title: 'Beta' }),
    ];
    const history = [
      makeItem({ url: 'https://a.com', title: 'Alpha' }),
      makeItem({ url: 'https://b.com', title: 'Beta' }),
    ];
    // With historySize=2, relaxed uses history.slice(0,1), so '2' should be unblocked
    const result = selectNextCandidate(candidates, history, 2);
    expect(result?.id).toBe('2');
  });
});

describe('updateHistory', () => {
  it('prepends picked item and trims to historySize', () => {
    const history = [
      makeItem({ id: 'old1', url: 'https://old1.com' }),
      makeItem({ id: 'old2', url: 'https://old2.com' }),
    ];
    const picked = makeItem({ id: 'new', url: 'https://new.com' });
    const updated = updateHistory(history, picked, 2);
    expect(updated).toHaveLength(2);
    expect(updated[0].id).toBe('new');
    expect(updated[1].id).toBe('old1');
  });

  it('removes duplicate URL from history', () => {
    const history = [makeItem({ id: 'dup', url: 'https://dup.com' })];
    const picked = makeItem({ id: 'dup-new', url: 'https://dup.com' });
    const updated = updateHistory(history, picked, 5);
    expect(updated).toHaveLength(1);
    expect(updated[0].id).toBe('dup-new');
  });
});
