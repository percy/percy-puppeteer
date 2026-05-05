import {
  UNSUPPORTED_IFRAME_SRCS,
  DEFAULT_MAX_FRAME_DEPTH,
  HARD_MAX_FRAME_DEPTH,
  resolveMaxFrameDepth,
  resolveIgnoreSelectors,
  isUnsupportedIframeSrc
} from '../iframe-utils.js';

describe('iframe-utils', () => {
  describe('UNSUPPORTED_IFRAME_SRCS', () => {
    it('exposes the list of unsupported src prefixes', () => {
      expect(UNSUPPORTED_IFRAME_SRCS).toEqual([
        'about:',
        'javascript:',
        'data:',
        'blob:',
        'vbscript:',
        'chrome:',
        'chrome-extension:'
      ]);
    });
  });

  describe('isUnsupportedIframeSrc', () => {
    it('returns true for falsy inputs', () => {
      expect(isUnsupportedIframeSrc(null)).toBe(true);
      expect(isUnsupportedIframeSrc(undefined)).toBe(true);
      expect(isUnsupportedIframeSrc('')).toBe(true);
    });

    it('matches lowercase prefixes', () => {
      expect(isUnsupportedIframeSrc('about:blank')).toBe(true);
      expect(isUnsupportedIframeSrc('javascript:void(0)')).toBe(true);
      expect(isUnsupportedIframeSrc('data:text/html,x')).toBe(true);
    });

    it('matches uppercase variants via toLowerCase coercion', () => {
      expect(isUnsupportedIframeSrc('JavaScript:alert(1)')).toBe(true);
      expect(isUnsupportedIframeSrc('DATA:foo')).toBe(true);
    });

    it('returns false for normal http URLs', () => {
      expect(isUnsupportedIframeSrc('https://example.com')).toBe(false);
      expect(isUnsupportedIframeSrc('http://x.test/path')).toBe(false);
    });
  });

  describe('resolveMaxFrameDepth', () => {
    it('returns DEFAULT_MAX_FRAME_DEPTH when option absent', () => {
      expect(resolveMaxFrameDepth()).toBe(DEFAULT_MAX_FRAME_DEPTH);
      expect(resolveMaxFrameDepth({})).toBe(DEFAULT_MAX_FRAME_DEPTH);
    });

    it('falls back when value is invalid', () => {
      expect(resolveMaxFrameDepth({ maxIframeDepth: NaN })).toBe(DEFAULT_MAX_FRAME_DEPTH);
      expect(resolveMaxFrameDepth({ maxIframeDepth: 0 })).toBe(DEFAULT_MAX_FRAME_DEPTH);
      expect(resolveMaxFrameDepth({ maxIframeDepth: -5 })).toBe(DEFAULT_MAX_FRAME_DEPTH);
      expect(resolveMaxFrameDepth({ maxIframeDepth: 'foo' })).toBe(DEFAULT_MAX_FRAME_DEPTH);
    });

    it('caps at HARD_MAX_FRAME_DEPTH', () => {
      expect(resolveMaxFrameDepth({ maxIframeDepth: 100 })).toBe(HARD_MAX_FRAME_DEPTH);
    });

    it('passes valid values through', () => {
      expect(resolveMaxFrameDepth({ maxIframeDepth: 7 })).toBe(7);
    });
  });

  describe('resolveIgnoreSelectors', () => {
    it('returns [] when option absent', () => {
      expect(resolveIgnoreSelectors()).toEqual([]);
      expect(resolveIgnoreSelectors({})).toEqual([]);
    });

    it('returns [] for non-array input', () => {
      expect(resolveIgnoreSelectors({ ignoreIframeSelectors: 'not-an-array' })).toEqual([]);
    });

    it('drops non-string and whitespace-only entries', () => {
      expect(resolveIgnoreSelectors({
        ignoreIframeSelectors: ['.x', '', '  ', null, 42, '.y']
      })).toEqual(['.x', '.y']);
    });
  });
});
