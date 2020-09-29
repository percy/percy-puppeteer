const fetch = require('node-fetch');

// Collect client and environment information
const sdkPkg = require('./package.json');
const puppeteerPkg = require('puppeteer/package.json');
const CLIENT_INFO = `${sdkPkg.name}/${sdkPkg.version}`;
const ENV_INFO = `${puppeteerPkg.name}/${puppeteerPkg.version}`;

// Maybe get the CLI API address and loglevel from the environment
const { PERCY_CLI_API = 'http://localhost:5338/percy' } = process.env;

// log helper for colored labels and errors
function log(level, msg) {
  let l = { debug: 0, info: 1, error: 2, quiet: 3 };
  let LEVEL = process.env.PERCY_LOGLEVEL || 'info';
  if (LEVEL == null || l[level] < l[LEVEL]) return;
  let c = (n, s) => `\u001b[${n}m${s}\u001b[39m`;

  if (level === 'error' || msg.stack) {
    msg = (LEVEL === 'debug' && msg.stack) || msg.toString();
    console.error(`[${c(35, 'percy')}] ${c(31, msg)}`);
  } else {
    console.log(`[${c(35, 'percy')}] ${msg}`);
  }
}

let PERCY_DOM_SCRIPT;
let PERCY_CORE_VERSION;

// Test helper to reset cached results
isPercyEnabled.reset = () => {
  PERCY_DOM_SCRIPT = null;
  PERCY_CORE_VERSION = null;
};

// Check if Percy is enabled while caching the @percy/dom script
async function isPercyEnabled() {
  if (PERCY_CORE_VERSION == null) {
    try {
      let r = await fetch(`${PERCY_CLI_API}/dom.js`);
      if (!r.ok) throw new Error(r.statusText);
      PERCY_CORE_VERSION = r.headers.get('x-percy-core-version') || '0';
      PERCY_DOM_SCRIPT = await r.text();
    } catch (err) {
      PERCY_CORE_VERSION = '';
      log('debug', err);
    }

    if (!PERCY_CORE_VERSION) {
      log('info', 'Percy is not running, disabling snapshots');
    } else if (parseInt(PERCY_CORE_VERSION) !== 1) {
      log('info', 'Unsupported Percy CLI version, disabling snapshots');
      PERCY_CORE_VERSION = '';
    }
  }

  return !!PERCY_CORE_VERSION;
}

// Take a DOM snapshot and post it to the snapshot endpoint
async function percySnapshot(page, name, options) {
  if (!page) throw new Error('A Puppeteer `page` object is required.');
  if (!name) throw new Error('The `name` argument is required.');
  if (!(await isPercyEnabled())) return;

  try {
    // Inject the DOM serialization script
    await page.evaluate(PERCY_DOM_SCRIPT);

    // Serialize and capture the DOM
    /* istanbul ignore next: no instrumenting injected code */
    let domSnapshot = await page.evaluate(options => {
      /* eslint-disable-next-line no-undef */
      return PercyDOM.serialize(options);
    }, options);

    // Post the DOM to the snapshot endpoint with snapshot options and other info
    let response = await fetch(`${PERCY_CLI_API}/snapshot`, {
      method: 'POST',
      body: JSON.stringify({
        ...options,
        environmentInfo: ENV_INFO,
        clientInfo: CLIENT_INFO,
        url: page.url(),
        domSnapshot,
        name
      })
    });

    // Handle errors
    let { success, error } = await response.json();
    if (!success) throw new Error(error);
  } catch (err) {
    log('error', `Could not take DOM snapshot "${name}"`);
    log('error', err);
  }
}

module.exports = percySnapshot;
module.exports.isPercyEnabled = isPercyEnabled;
