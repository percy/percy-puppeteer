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
  if (!src) return true;
  return UNSUPPORTED_IFRAME_SRCS.some(prefix => src === prefix || src.startsWith(prefix));
}

// Processes a single cross-origin frame to capture its snapshot and resources.
async function processFrame(page, frame, options, percyDOM) {
  const frameUrl = frame.url();
  log.debug(`Processing cross-origin iframe: ${frameUrl}`);

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
      processFrame(page, frame, options, percyDOM).catch(e => {
        log.debug(`Failed to process cross-origin frame ${frame.url()}: ${e.message}`);
        return null;
      })
    )
  )).filter(Boolean);

  if (processedFrames.length > 0) {
    domSnapshot.corsIframes = processedFrames;
    log.debug(`Captured ${processedFrames.length} cross-origin iframe(s)`);
  }

  // Capture cookies
  const cookies = await page.cookies();
  if (cookies && cookies.length > 0) {
    domSnapshot.cookies = cookies;
  }

  return domSnapshot;
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
