const utils = require('@percy/sdk-utils');

// Collect client and environment information
const sdkPkg = require('./package.json');
const puppeteerPkg = require('puppeteer/package.json');
const CLIENT_INFO = `${sdkPkg.name}/${sdkPkg.version}`;
const ENV_INFO = `${puppeteerPkg.name}/${puppeteerPkg.version}`;
const log = utils.logger('puppeteer');

// Processes a single cross-origin frame to capture its snapshot and resources.
async function processFrame(page, frame, options, percyDOM) {
  const frameUrl = frame.url();

  /* istanbul ignore next: browser-executed iframe serialization */
  const iframeSnapshot = await frame.evaluate((opts) => {
    /* eslint-disable-next-line no-undef */
    return PercyDOM.serialize(opts);
  }, { ...options, enableJavascript: true });

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
  const crossOriginFrames = page.frames()
    .filter(frame => {
      const frameUrl = frame.url();
      if (!frameUrl || frameUrl === 'about:blank') return false;
      try {
        return new URL(frameUrl).origin !== pageUrl.origin;
      } catch {
        return false;
      }
    });

  // Inject Percy DOM into all cross-origin frames before processing them
  await Promise.all(crossOriginFrames.map(frame =>
    frame.evaluate(percyDOM).catch(e =>
      log.debug(`Failed to inject PercyDOM into frame ${frame.url()}: ${e.message}`)
    )
  ));

  const processedFrames = (await Promise.all(
    crossOriginFrames.map(frame =>
      processFrame(page, frame, options, percyDOM).catch(e => {
        log.debug(`Failed to process cross-origin frame ${frame.url()}: ${e.message}`);
        return null;
      })
    )
  )).filter(Boolean);

  if (processedFrames.length > 0) {
    domSnapshot.corsIframes = processedFrames;
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
