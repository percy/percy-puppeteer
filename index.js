const utils = require('@percy/sdk-utils');

// Collect client and environment information
const sdkPkg = require('./package.json');
const puppeteerPkg = require('puppeteer/package.json');
const CLIENT_INFO = `${sdkPkg.name}/${sdkPkg.version}`;
const ENV_INFO = `${puppeteerPkg.name}/${puppeteerPkg.version}`;
const log = utils.logger('puppeteer');

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

function isUnsupportedIframeSrc(src) {
  /* istanbul ignore next: defensive guard — callers already filter falsy URLs */
  if (!src) return true;
  return UNSUPPORTED_IFRAME_SRCS.some(prefix => src === prefix || src.startsWith(prefix));
}

// Processes a single cross-origin frame to capture its snapshot and resources.
async function processFrame(page, frame, options) {
  const frameUrl = frame.url();
  log.debug(`Processing cross-origin iframe: ${frameUrl}`);

  // enableJavascript is intentionally forced to true to prevent the standard iframe
  // serialization logic from running; user-provided enableJavascript: false is not
  // applicable to cross-origin iframe serialization
  /* istanbul ignore next: browser-executed iframe serialization */
  const iframeSnapshot = await frame.evaluate((opts) => {
    /* eslint-disable-next-line no-undef */
    return PercyDOM.serialize(opts);
  }, { ...options, enableJavascript: true });
  log.debug(`Serialized cross-origin iframe: ${frameUrl}`);

  // Get the iframe's element data from the main page context
  /* istanbul ignore next: browser-executed evaluation function */
  const iframeData = await page.evaluate((fUrl) => {
    const iframes = Array.from(document.querySelectorAll('iframe'));
    const matchingIframe = iframes.find(iframe => iframe.src.startsWith(fUrl));
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

async function captureSerializedDOM(page, options, percyDOM) {
  /* istanbul ignore next: no instrumenting injected code */
  let domSnapshot = await page.evaluate((options) => {
    /* eslint-disable-next-line no-undef */
    return PercyDOM.serialize(options);
  }, options);

  // Process cross-origin iframes
  const pageUrl = new URL(page.url());
  const allFrames = page.frames();
  log.debug(`Found ${allFrames.length} total frame(s) on page`);

  const crossOriginFrames = allFrames
    .filter(frame => {
      const frameUrl = frame.url();
      if (!frameUrl || isUnsupportedIframeSrc(frameUrl)) {
        if (frameUrl) log.debug(`Skipping unsupported iframe src: ${frameUrl}`);
        return false;
      }
      try {
        const isCrossOrigin = new URL(frameUrl).origin !== pageUrl.origin;
        if (!isCrossOrigin) log.debug(`Skipping same-origin iframe: ${frameUrl}`);
        return isCrossOrigin;
      } catch {
        log.debug(`Skipping iframe with invalid URL: ${frameUrl}`);
        return false;
      }
    });

  log.debug(`Found ${crossOriginFrames.length} cross-origin iframe(s) to process`);

  // Inject Percy DOM into cross-origin frames, track which succeed
  const injectResults = await Promise.all(crossOriginFrames.map(frame =>
    frame.evaluate(percyDOM)
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

  // Capture cookies
  // Note: page.cookies() is deprecated in Puppeteer v23+ in favor of
  // page.browserContext().cookies(). Cookies are only used by the CLI
  // for fetching cross-origin iframe resources during asset discovery.
  const cookies = await page.cookies();
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
