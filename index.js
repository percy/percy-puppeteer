const utils = require('@percy/sdk-utils');

// Collect client and environment information
const sdkPkg = require('./package.json');
const puppeteerPkg = require('puppeteer/package.json');
const CLIENT_INFO = `${sdkPkg.name}/${sdkPkg.version}`;
const ENV_INFO = `${puppeteerPkg.name}/${puppeteerPkg.version}`;

// Take a DOM snapshot and post it to the snapshot endpoint
async function percySnapshot(page, name, options) {
  if (!page) throw new Error('A Puppeteer `page` object is required.');
  if (!name) throw new Error('The `name` argument is required.');
  if (!(await utils.isPercyEnabled())) return;
  let log = utils.logger('puppeteer');

  try {
    // Inject the DOM serialization script
    await page.evaluate(await utils.fetchPercyDOM());

    // Readiness gate (PER-7348). Helpers from @percy/sdk-utils 1.31.14+;
    // typeof guards fall back to local resolution so a stale lockfile-pinned
    // sdk-utils version degrades to a no-op instead of crashing the snapshot.
    let readinessDiagnostics;
    const readinessDisabled = typeof utils.isReadinessDisabled === 'function'
      ? utils.isReadinessDisabled(options)
      : ((options?.readiness || utils.percy?.config?.snapshot?.readiness)?.preset === 'disabled');
    if (!readinessDisabled && typeof utils.waitForReadyScript === 'function') {
      const readinessConfig = typeof utils.getReadinessConfig === 'function'
        ? utils.getReadinessConfig(options)
        : { ...(utils.percy?.config?.snapshot?.readiness || {}), ...(options?.readiness || {}) };
      readinessDiagnostics = await page.evaluate(
        utils.waitForReadyScript(readinessConfig)
      ).catch(err => {
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
    if (readinessDiagnostics && domSnapshot && typeof domSnapshot === 'object') {
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
