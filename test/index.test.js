const expect = require('expect');
const puppeteer = require('puppeteer');
const sdk = require('@percy/sdk-utils/test/helper');
const percySnapshot = require('..');

describe('percySnapshot', () => {
  let browser, page;

  before(async function() {
    this.timeout(0);
    browser = await puppeteer.launch();
    await sdk.testsite.mock();
  });

  after(async () => {
    await browser.close();
    await sdk.testsite.close();
  });

  beforeEach(async () => {
    await sdk.setup();

    // go to test site
    page = await browser.newPage();
    await page.goto('http://localhost:8000');
  });

  afterEach(async () => {
    await sdk.teardown();
    await page.close();
  });

  it('throws an error when a page is not provided', async () => {
    await expect(percySnapshot())
      .rejects.toThrow('A Puppeteer `page` object is required.');
  });

  it('throws an error when a name is not provided', async () => {
    await expect(percySnapshot(page))
      .rejects.toThrow('The `name` argument is required.');
  });

  it('disables snapshots when the healthcheck fails', async () => {
    sdk.test.failure('/percy/healthcheck');

    await percySnapshot(page, 'Snapshot 1');
    await percySnapshot(page, 'Snapshot 2');

    expect(sdk.server.requests).toEqual([
      ['/percy/healthcheck']
    ]);

    expect(sdk.logger.stderr).toEqual([]);
    expect(sdk.logger.stdout).toEqual([
      '[percy] Percy is not running, disabling snapshots\n'
    ]);
  });

  it('posts snapshots to the local percy server', async () => {
    await percySnapshot(page, 'Snapshot 1');
    await percySnapshot(page, 'Snapshot 2');

    expect(sdk.server.requests).toEqual([
      ['/percy/healthcheck'],
      ['/percy/dom.js'],
      ['/percy/snapshot', {
        name: 'Snapshot 1',
        url: 'http://localhost:8000/',
        domSnapshot: '<html><head></head><body>Snapshot Me</body></html>',
        clientInfo: expect.stringMatching(/@percy\/puppeteer\/.+/),
        environmentInfo: expect.stringMatching(/puppeteer\/.+/)
      }],
      ['/percy/snapshot', expect.objectContaining({
        name: 'Snapshot 2'
      })]
    ]);

    expect(sdk.logger.stdout).toEqual([]);
    expect(sdk.logger.stderr).toEqual([]);
  });

  it('handles snapshot failures', async () => {
    sdk.test.failure('/percy/snapshot', 'failure');

    await percySnapshot(page, 'Snapshot 1');

    expect(sdk.logger.stdout).toEqual([]);
    expect(sdk.logger.stderr).toEqual([
      '[percy] Could not take DOM snapshot "Snapshot 1"\n',
      '[percy] Error: failure\n'
    ]);
  });
});
