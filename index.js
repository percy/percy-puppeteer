const utils = require('./_iframe_shim');
const {
  resolveMaxFrameDepth,
  resolveIgnoreSelectors,
  isUnsupportedIframeSrc
} = utils;

// Collect client and environment information
const sdkPkg = require('./package.json');
const puppeteerPkg = require('puppeteer/package.json');
const CLIENT_INFO = `${sdkPkg.name}/${sdkPkg.version}`;
const ENV_INFO = `${puppeteerPkg.name}/${puppeteerPkg.version}`;
const log = utils.logger('puppeteer');

// Walk the parentFrame chain to determine the iframe's nesting depth (1 for a
// top-level iframe, 2 for once-nested, ...).
function frameDepth(frame) {
  let depth = 0;
  let cur = frame.parentFrame ? frame.parentFrame() : null;
  while (cur) {
    depth++;
    cur = cur.parentFrame ? cur.parentFrame() : null;
  }
  return depth;
}

// True if the frame's URL also appears somewhere in its ancestor chain
// (A->B->A pattern). Pages that link to themselves through cross-origin
// gateways would otherwise be captured up to MAX_FRAME_DEPTH levels with
// duplicate frameUrl entries.
function isCyclicFrame(frame) {
  const url = frame.url ? frame.url() : null;
  if (!url) return false;
  let cur = frame.parentFrame ? frame.parentFrame() : null;
  while (cur) {
    if (cur.url && cur.url() === url) return true;
    cur = cur.parentFrame ? cur.parentFrame() : null;
  }
  return false;
}

// Processes a single cross-origin frame to capture its snapshot and resources.
// The iframe element holding this frame's percyElementId lives in the parent
// frame's DOM (not necessarily the top page) — important for nesting where the
// parent is itself a cross-origin frame.
async function processFrame(page, frame, options) {
  const frameUrl = frame.url();
  log.debug(`Processing cross-origin iframe (depth ${frameDepth(frame)}): ${frameUrl}`);

  // enableJavascript is intentionally forced to true to prevent the standard iframe
  // serialization logic from running; user-provided enableJavascript: false is not
  // applicable to cross-origin iframe serialization
  /* istanbul ignore next: browser-executed iframe serialization */
  const iframeSnapshot = await frame.evaluate((opts) => {
    /* eslint-disable-next-line no-undef */
    return PercyDOM.serialize(opts);
  }, { ...options, enableJavaScript: true });
  log.debug(`Serialized cross-origin iframe: ${frameUrl}`);

  // Resolve the iframe element from the *parent frame's* DOM. For top-level
  // iframes the parent is the main frame; for nested iframes it's the
  // immediately enclosing frame. Reading from the top page would miss nested
  // iframes whose <iframe> element lives inside another frame's document.
  const parentFrame = (frame.parentFrame && frame.parentFrame()) || page.mainFrame();
  // Match by exact src first; fall back to a normalized comparison that
  // tolerates only a trailing-slash difference. A naive `startsWith` would
  // mis-match siblings that share a URL prefix (e.g. `https://ads.com/` and
  // `https://ads.com/banner` — both pass `startsWith('https://ads.com/')` —
  // and the find() would return whichever is in the DOM first, swapping the
  // wrong percyElementId onto this frame's snapshot).
  /* istanbul ignore next: browser-executed evaluation function */
  const iframeData = await parentFrame.evaluate((fUrl) => {
    const norm = (s) => (s || '').replace(/\/+$/, '');
    const target = norm(fUrl);
    const iframes = Array.from(document.querySelectorAll('iframe'));
    const matchingIframe = iframes.find(iframe => iframe.src === fUrl) ||
      iframes.find(iframe => norm(iframe.src) === target);
    if (matchingIframe) {
      return {
        percyElementId: matchingIframe.getAttribute('data-percy-element-id')
      };
    }
  }, frameUrl);

  if (!iframeData?.percyElementId) {
    log.debug(`Skipping frame ${frameUrl}: no data-percy-element-id found`);
    return null;
  }

  log.debug(`Successfully captured cross-origin iframe: ${frameUrl} (percyElementId: ${iframeData.percyElementId})`);
  return {
    iframeData,
    iframeSnapshot,
    frameUrl
  };
}

async function captureSerializedDOM(page, options, percyDOMScript) {
  /* istanbul ignore next: no instrumenting injected code */
  let domSnapshot = await page.evaluate((options) => {
    /* eslint-disable-next-line no-undef */
    return PercyDOM.serialize(options);
  }, options);

  // page.frames() returns a flat list of every frame in the page tree (top
  // page + all descendants), so nested cross-origin iframes are already
  // included. We filter to cross-origin frames whose origin differs from
  // their parent frame's origin (same-origin descendants are inlined as
  // srcdoc by PercyDOM). The maxFrameDepth cap protects against runaway
  // recursion in malformed pages.
  const maxFrameDepth = resolveMaxFrameDepth(options);
  const ignoreSelectors = resolveIgnoreSelectors(options);
  const allFrames = page.frames();
  const mainFrame = (page.mainFrame && page.mainFrame()) || allFrames[0];
  log.debug(`Found ${allFrames.length} total frame(s) on page`);

  // Resolve per-frame `data-percy-ignore` and ignoreIframeSelectors flags from
  // the parent frame's DOM (where the <iframe> element actually lives) before
  // the cross-origin filter. Done in parallel since each is a single round-trip.
  const ignoreFlagsByFrame = new Map();
  await Promise.all(allFrames.map(async (frame) => {
    if (frame === mainFrame) return;
    try {
      const parent = (frame.parentFrame && frame.parentFrame()) || mainFrame;
      /* istanbul ignore next: browser-executed evaluate callback — the function
         body runs inside the page, never in the Jasmine Node process, so
         coverage instrumentation cannot observe it. Behavior is verified via
         the parent.evaluate spy stubs in the dataPercyIgnore /
         matchesIgnoreSelector tests above. */
      const flags = await parent.evaluate((fUrl, selectors) => {
        const norm = (s) => (s || '').replace(/\/+$/, '');
        const target = norm(fUrl);
        const iframes = Array.from(document.querySelectorAll('iframe'));
        const el = iframes.find(i => i.src === fUrl) || iframes.find(i => norm(i.src) === target);
        if (!el) return { dataPercyIgnore: false, matchesIgnoreSelector: false };
        let matches = false;
        if (selectors && selectors.length) {
          for (let j = 0; j < selectors.length; j++) {
            try { if (el.matches(selectors[j])) { matches = true; break; } } catch (e) { /* invalid selector */ }
          }
        }
        return {
          dataPercyIgnore: el.hasAttribute('data-percy-ignore'),
          matchesIgnoreSelector: matches
        };
      }, frame.url(), ignoreSelectors);
      ignoreFlagsByFrame.set(frame, flags);
    } catch (e) {
      // Couldn't resolve — leave entry absent so the filter falls through
      // to its other rules without false-skipping.
    }
  }));

  const crossOriginFrames = allFrames
    .filter(frame => {
      // Skip the main frame — only iframes are candidates here.
      if (frame === mainFrame) return false;

      const flags = ignoreFlagsByFrame.get(frame) || {};
      if (flags.dataPercyIgnore) {
        log.debug(`Skipping iframe marked with data-percy-ignore: ${frame.url()}`);
        return false;
      }
      if (flags.matchesIgnoreSelector) {
        log.debug(`Skipping iframe matching ignoreIframeSelectors: ${frame.url()}`);
        return false;
      }

      const frameUrl = frame.url();
      if (!frameUrl || isUnsupportedIframeSrc(frameUrl)) {
        if (frameUrl) log.debug(`Skipping unsupported iframe src: ${frameUrl}`);
        return false;
      }
      const depth = frameDepth(frame);
      if (depth > maxFrameDepth) {
        log.debug(`Skipping iframe at depth ${depth} (max ${maxFrameDepth}): ${frameUrl}`);
        return false;
      }
      if (isCyclicFrame(frame)) {
        log.debug(`Skipping cyclic iframe (${frameUrl} appears in ancestor chain)`);
        return false;
      }
      try {
        // Cross-origin relative to the immediate parent — that's the boundary
        // PercyDOM cannot cross with srcdoc inlining. For top-level iframes
        // this is page.url(); for nested ones it's the enclosing frame's URL.
        const parent = frame.parentFrame && frame.parentFrame();
        const parentUrl = (parent && parent.url && parent.url()) || page.url();
        const parentOrigin = parentUrl ? new URL(parentUrl).origin : null;
        const frameOrigin = new URL(frameUrl).origin;
        const isCrossOrigin = parentOrigin !== null && frameOrigin !== parentOrigin;
        if (!isCrossOrigin) log.debug(`Skipping same-origin iframe: ${frameUrl}`);
        return isCrossOrigin;
      } catch {
        log.debug(`Skipping iframe with invalid URL: ${frameUrl}`);
        return false;
      }
    });

  log.debug(`Found ${crossOriginFrames.length} cross-origin iframe(s) to process (across all depths)`);

  // Inject Percy DOM into cross-origin frames, track which succeed
  const injectResults = await Promise.all(crossOriginFrames.map(frame =>
    frame.evaluate(percyDOMScript)
      .then(() => {
        log.debug(`Injected PercyDOM into frame: ${frame.url()}`);
        return { frame, success: true };
      })
      .catch(e => {
        log.debug(`Failed to inject PercyDOM into frame ${frame.url()}: ${e.message}`);
        return { frame, success: false };
      })
  ));

  const injectableFrames = injectResults
    .filter(r => r.success)
    .map(r => r.frame);

  if (injectableFrames.length < crossOriginFrames.length) {
    log.debug(`PercyDOM injection failed for ${crossOriginFrames.length - injectableFrames.length} frame(s)`);
  }

  const processedFrames = (await Promise.all(
    injectableFrames.map(frame =>
      processFrame(page, frame, options).catch(e => {
        log.debug(`Failed to process cross-origin frame ${frame.url()}: ${e.message}`);
        return null;
      })
    )
  )).filter(Boolean);

  domSnapshot.corsIframes = processedFrames;
  if (processedFrames.length > 0) {
    log.debug(`Captured ${processedFrames.length} cross-origin iframe(s)`);
  }

  // Cookies are best-effort enrichment (used by the CLI to fetch cross-origin
  // iframe resources during asset discovery). page.cookies() is removed in
  // Puppeteer v23+ in favor of page.browserContext().cookies(); fall back so
  // a missing API never aborts the snapshot.
  let cookies;
  try {
    if (typeof page.cookies === 'function') {
      cookies = await page.cookies();
    } else if (typeof page.browserContext === 'function') {
      // Puppeteer v23+ returns context-wide cookies (not page-scoped). Filter
      // to the page's registrable origin so cross-domain cookies from other
      // tabs in the same context don't leak into the snapshot payload.
      const all = await page.browserContext().cookies();
      let pageHost = '';
      try { pageHost = new URL(page.url()).hostname; } catch (_) { /* ignore */ }
      cookies = pageHost
        ? all.filter(c => {
          if (!c || !c.domain) return false;
          const d = c.domain.replace(/^\./, '').toLowerCase();
          const h = pageHost.toLowerCase();
          return h === d || h.endsWith(`.${d}`);
        })
        : all;
    }
  } catch (e) {
    log.debug(`Could not collect cookies: ${e.message}`);
  }
  if (cookies && cookies.length > 0) {
    domSnapshot.cookies = cookies;
  }

  return domSnapshot;
}

// Use CDP to discover closed shadow roots and expose them to PercyDOM.serialize().
// Closed shadow roots are inaccessible from JS (element.shadowRoot === null),
// but CDP's DOM domain can pierce them. We resolve each closed shadow root to a
// JS object and store it in a WeakMap that clone-dom.js reads during serialization.
async function exposeClosedShadowRoots(page) {
  let client;
  try {
    client = await page.target().createCDPSession();
  } catch (err) {
    // Non-Chromium browser or CDP session unavailable
    log.debug('CDP session unavailable:', err.message);
    return;
  }

  try {
    await client.send('DOM.enable');

    // Performance note: DOM.getDocument with pierce:true traverses the entire DOM
    // including all shadow trees, which can be expensive for large apps. A future
    // optimization could add a cheap pre-check to skip this when no closed shadow
    // roots exist on the page.
    const { root } = await client.send('DOM.getDocument', {
      depth: -1,
      pierce: true
    });

    // Walk the CDP DOM tree to find closed shadow roots
    const closedPairs = [];
    function walkNodes(node) {
      // Skip nodes inside child frame documents — cross-frame closed shadow
      // roots are not yet supported (their execution context lacks the WeakMap)
      if (node.contentDocument) return;
      if (node.shadowRoots) {
        for (const sr of node.shadowRoots) {
          if (sr.shadowRootType === 'closed') {
            closedPairs.push({
              hostBackendNodeId: node.backendNodeId,
              shadowBackendNodeId: sr.backendNodeId
            });
          }
          walkNodes(sr);
        }
      }
      if (node.children) {
        for (const child of node.children) {
          walkNodes(child);
        }
      }
    }
    walkNodes(root);

    if (closedPairs.length === 0) {
      await client.send('DOM.disable');
      return;
    }

    log.debug(`Found ${closedPairs.length} closed shadow root(s), exposing via CDP`);

    // Create the WeakMap on the page (same key as preflight.js uses)
    /* istanbul ignore next: browser-executed code */
    await page.evaluate(() => {
      window.__percyClosedShadowRoots = window.__percyClosedShadowRoots || new WeakMap();
    });

    // For each pair, resolve both host element and shadow root to JS objects,
    // then store the mapping in the WeakMap
    for (const pair of closedPairs) {
      const { object: hostObj } = await client.send('DOM.resolveNode', {
        backendNodeId: pair.hostBackendNodeId
      });
      const { object: shadowObj } = await client.send('DOM.resolveNode', {
        backendNodeId: pair.shadowBackendNodeId
      });

      /* istanbul ignore next: CDP-injected function */
      await client.send('Runtime.callFunctionOn', {
        functionDeclaration: 'function(shadowRoot) { window.__percyClosedShadowRoots.set(this, shadowRoot); }',
        objectId: hostObj.objectId,
        arguments: [{ objectId: shadowObj.objectId }]
      });
    }

    await client.send('DOM.disable');
  } catch (err) {
    // Non-fatal — closed shadow DOM just won't be captured
    log.debug('Could not expose closed shadow roots via CDP:', err.message);
  } finally {
    /* istanbul ignore else: client is always set when this finally block is reached */
    if (client) {
      /* istanbul ignore next: swallow detach errors */
      await client.detach().catch(() => {});
    }
  }
}

// Take a DOM snapshot and post it to the snapshot endpoint
async function percySnapshot(page, name, options) {
  if (!page) throw new Error('A Puppeteer `page` object is required.');
  if (!name) throw new Error('The `name` argument is required.');
  if (!(await utils.isPercyEnabled())) return;

  try {
    // Inject the DOM serialization script
    const percyDOM = await utils.fetchPercyDOM();
    await page.evaluate(percyDOM);

    // Expose closed shadow roots via CDP before serialization so
    // PercyDOM.serialize() can access them through the WeakMap
    await exposeClosedShadowRoots(page);

    let domSnapshot = await captureSerializedDOM(page, options || {}, percyDOM);

    // Post the DOM to the snapshot endpoint with snapshot options and other info
    await utils.postSnapshot({
      ...options,
      environmentInfo: ENV_INFO,
      clientInfo: CLIENT_INFO,
      url: page.url(),
      domSnapshot,
      name
    });
  } catch (err) {
    log.error(`Could not take DOM snapshot "${name}"`);
    log.error(err);
  }
}

module.exports = percySnapshot;
// Exported for direct unit testing of the parentFrame-chain walkers.
module.exports.frameDepth = frameDepth;
module.exports.isCyclicFrame = isCyclicFrame;
