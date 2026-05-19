const utils = require('@percy/sdk-utils');

// Collect client and environment information
const sdkPkg = require('./package.json');
const puppeteerPkg = require('puppeteer/package.json');
const CLIENT_INFO = `${sdkPkg.name}/${sdkPkg.version}`;
const ENV_INFO = `${puppeteerPkg.name}/${puppeteerPkg.version}`;

// In-browser readiness invoker. Defined at module scope so the typeof
// guard branches are unit-testable in Node against a stubbed `PercyDOM`
// global — that's how we cover the body without `istanbul ignore`. The
// guard makes this a silent no-op against older CLIs that don't expose
// waitForReady (backward compat).
function browserWaitForReady(cfg) {
  /* eslint-disable-next-line no-undef */
  if (typeof PercyDOM !== 'undefined' && typeof PercyDOM.waitForReady === 'function') {
    /* eslint-disable-next-line no-undef */
    return PercyDOM.waitForReady(cfg);
  }
}

// Take a DOM snapshot and post it to the snapshot endpoint
async function percySnapshot(page, name, options) {
  if (!page) throw new Error('A Puppeteer `page` object is required.');
  if (!name) throw new Error('The `name` argument is required.');
  if (!(await utils.isPercyEnabled())) return;
  let log = utils.logger('puppeteer');

  try {
    // Inject the DOM serialization script
    await page.evaluate(await utils.fetchPercyDOM());

    // Readiness gate — runs before serialize when CLI supports it (PER-7348).
    // Diagnostics are captured and attached to domSnapshot so the CLI can log them.
    let readinessDiagnostics;
    const readinessConfig = options?.readiness || utils.percy?.config?.snapshot?.readiness || {};
    if (readinessConfig.preset !== 'disabled') {
      readinessDiagnostics = await page.evaluate(browserWaitForReady, readinessConfig).catch(err => {
        log.debug(`waitForReady failed, proceeding to serialize: ${err?.message || err}`);
      });
    }

    // Serialize and capture the DOM
    /* istanbul ignore next: no instrumenting injected code */
    let domSnapshot = await page.evaluate((options) => {
      /* eslint-disable-next-line no-undef */
      return PercyDOM.serialize(options);
    }, options);

    // Attach readiness diagnostics so the CLI can log timing and pass/fail
    if (readinessDiagnostics) {
      domSnapshot.readiness_diagnostics = readinessDiagnostics;
    }

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
module.exports.__test__ = { browserWaitForReady };
