import expect from 'expect';
import puppeteer from 'puppeteer';
import helpers from '@percy/sdk-utils/test/helpers';
import percySnapshot from '../index.js';

describe('percySnapshot', () => {
  let browser, page;

  before(async function() {
    this.timeout(0);
    browser = await puppeteer.launch();
  });

  after(async () => {
    await browser.close();
  });

  beforeEach(async () => {
    await helpers.setupTest();
    page = await browser.newPage();
    await page.goto(helpers.testSnapshotURL);
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
    await helpers.test('error', '/percy/healthcheck');

    await percySnapshot(page, 'Snapshot 1');
    await percySnapshot(page, 'Snapshot 2');

    expect(await helpers.get('logs')).toEqual(expect.arrayContaining([
      'Percy is not running, disabling snapshots'
    ]));
  });

  it('posts snapshots to the local percy server', async () => {
    await percySnapshot(page, 'Snapshot 1');
    await percySnapshot(page, 'Snapshot 2');

    expect(await helpers.get('logs')).toEqual(expect.arrayContaining([
      'Snapshot found: Snapshot 1',
      'Snapshot found: Snapshot 2',
      `- url: ${helpers.testSnapshotURL}`,
      expect.stringMatching(/clientInfo: @percy\/puppeteer\/.+/),
      expect.stringMatching(/environmentInfo: puppeteer\/.+/)
    ]));
  });

  it('handles snapshot failures', async () => {
    await helpers.test('error', '/percy/snapshot');

    await percySnapshot(page, 'Snapshot 1');

    expect(await helpers.get('logs')).toEqual(expect.arrayContaining([
      'Could not take DOM snapshot "Snapshot 1"'
    ]));
  });
});
