import expect from 'expect';
import puppeteer from 'puppeteer';
import helpers from '@percy/sdk-utils/test/helpers';
import percySnapshot from '../index.js';

describe('percySnapshot', () => {
  let browser, page;

  before(async function() {
    this.timeout(0);
    browser = await puppeteer.launch();
    await helpers.mockSite();
  });

  after(async () => {
    await browser.close();
    await helpers.closeSite();
  });

  beforeEach(async () => {
    await helpers.setup();

    // go to test site
    page = await browser.newPage();
    await page.goto('http://localhost:8000');
  });

  afterEach(async () => {
    await helpers.teardown();
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
    await helpers.testFailure('/percy/healthcheck');

    await percySnapshot(page, 'Snapshot 1');
    await percySnapshot(page, 'Snapshot 2');

    await expect(helpers.getRequests()).resolves.toEqual([
      ['/percy/healthcheck']
    ]);

    expect(helpers.logger.stderr).toEqual([]);
    expect(helpers.logger.stdout).toEqual([
      '[percy] Percy is not running, disabling snapshots'
    ]);
  });

  it('posts snapshots to the local percy server', async () => {
    await percySnapshot(page, 'Snapshot 1');
    await percySnapshot(page, 'Snapshot 2');

    await expect(helpers.getRequests()).resolves.toEqual([
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

    expect(helpers.logger.stdout).toEqual([]);
    expect(helpers.logger.stderr).toEqual([]);
  });

  it('handles snapshot failures', async () => {
    await helpers.testFailure('/percy/snapshot', 'failure');

    await percySnapshot(page, 'Snapshot 1');

    expect(helpers.logger.stdout).toEqual([]);
    expect(helpers.logger.stderr).toEqual([
      '[percy] Could not take DOM snapshot "Snapshot 1"',
      '[percy] Error: failure'
    ]);
  });
});
