// Local shim: extends @percy/sdk-utils with helpers the published 1.31.14-beta.3
// does not yet export. SDK code expects these names; we provide them locally
// until sdk-utils is updated.
const utils = require('@percy/sdk-utils');

const BROWSER_INTERNAL_PREFIXES = [
  'about:', 'chrome:', 'chrome-extension:', 'devtools:',
  'edge:', 'opera:', 'view-source:', 'data:', 'javascript:', 'blob:'
];

const DEFAULT_MAX_IFRAME_DEPTH = utils.DEFAULT_MAX_IFRAME_DEPTH ?? 3;
const HARD_MAX_IFRAME_DEPTH = utils.HARD_MAX_IFRAME_DEPTH ?? 10;

// Floor + clamp to [1, HARD] with the canonical default for invalid/<1 input.
// Prefer sdk-utils.clampIframeDepth (the source of truth — it floors floats and
// owns the 3/10 defaults) and fall back to a local floor matching its contract.
function clampFrameDepth(raw) {
  if (typeof utils.clampIframeDepth === 'function') return utils.clampIframeDepth(raw);
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_IFRAME_DEPTH;
  return Math.min(Math.floor(n), HARD_MAX_IFRAME_DEPTH);
}

// Resolve from per-snapshot options first, then the global .percy.yml config
// (percy.config.snapshot.maxIframeDepth), then the default. Matches
// percy-nightwatch's resolveMaxFrameDepth. Floats are floored via clampFrameDepth.
function resolveMaxFrameDepth(options = {}) {
  const requested = options.maxFrameDepth ?? options.maxIframeDepth ??
    utils?.percy?.config?.snapshot?.maxIframeDepth;
  return clampFrameDepth(requested ?? DEFAULT_MAX_IFRAME_DEPTH);
}

function normalize(sel) {
  if (!sel) return [];
  if (Array.isArray(sel)) return sel.filter(s => typeof s === 'string' && s.length);
  if (typeof sel === 'string') return sel ? [sel] : [];
  return [];
}

// Per-snapshot options first, then global config (ignoreIframeSelectors), then
// empty. Matches percy-nightwatch's resolveIgnoreSelectors.
function resolveIgnoreSelectors(options = {}) {
  const sel = options.ignoreIframeSelectors ?? options.ignoreSelectors ??
    utils?.percy?.config?.snapshot?.ignoreIframeSelectors;
  return normalize(sel);
}

function normalizeIgnoreSelectors(options = {}) {
  return normalize(options.ignoreIframeSelectors ?? options.ignoreSelectors);
}

function isUnsupportedIframeSrc(src) {
  if (!src) return true;
  const s = String(src).toLowerCase();
  return BROWSER_INTERNAL_PREFIXES.some(p => s.startsWith(p));
}

module.exports = Object.assign({}, utils, {
  resolveMaxFrameDepth: utils.resolveMaxFrameDepth || resolveMaxFrameDepth,
  resolveIgnoreSelectors: utils.resolveIgnoreSelectors || resolveIgnoreSelectors,
  normalizeIgnoreSelectors: utils.normalizeIgnoreSelectors || normalizeIgnoreSelectors,
  isUnsupportedIframeSrc: utils.isUnsupportedIframeSrc || isUnsupportedIframeSrc
});
