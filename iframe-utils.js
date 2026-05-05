// Constants and helpers used across cross-origin iframe handling.
// Kept in a dedicated module so the same definitions don't drift between
// SDKs (puppeteer, playwright, nightwatch, cypress, webdriverio, protractor).

const UNSUPPORTED_IFRAME_SRCS = [
  'about:blank',
  'about:srcdoc',
  'javascript:',
  'data:',
  'blob:',
  'vbscript:',
  'chrome:',
  'chrome-extension:'
];

const DEFAULT_MAX_FRAME_DEPTH = 10;
const HARD_MAX_FRAME_DEPTH = 25;

function resolveMaxFrameDepth(options = {}) {
  const raw = options.maxIframeDepth ?? DEFAULT_MAX_FRAME_DEPTH;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_FRAME_DEPTH;
  return Math.min(n, HARD_MAX_FRAME_DEPTH);
}

function resolveIgnoreSelectors(options = {}) {
  const list = options.ignoreIframeSelectors ?? [];
  return Array.isArray(list) ? list.filter(s => typeof s === 'string' && s.trim()) : [];
}

function isUnsupportedIframeSrc(src) {
  /* istanbul ignore next: defensive guard — callers already filter falsy URLs */
  if (!src) return true;
  const lower = String(src).toLowerCase();
  return UNSUPPORTED_IFRAME_SRCS.some(prefix => lower === prefix || lower.startsWith(prefix));
}

module.exports = {
  UNSUPPORTED_IFRAME_SRCS,
  DEFAULT_MAX_FRAME_DEPTH,
  HARD_MAX_FRAME_DEPTH,
  resolveMaxFrameDepth,
  resolveIgnoreSelectors,
  isUnsupportedIframeSrc
};
