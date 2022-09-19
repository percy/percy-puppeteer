import puppeteer from 'puppeteer';
import helpers from '@percy/sdk-utils/test/helpers';
import percySnapshot from '../index.js';

describe('percySnapshot', () => {
  let browser, page, stdout, stderr;

  let ANSI_REG = new RegExp('[\\u001B\\u009B][[\\]()#;?]*(' +
    '(?:(?:[a-zA-Z\\d]*(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)|' +
    '(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))', 'g');

  let captureLogs = acc => msg => {
    msg = msg.replace(/\r\n/g, '\n');
    msg = msg.replace(ANSI_REG, '');
    acc.push(msg.replace(/\n$/, ''));
  };

  beforeAll(async function() {
    browser = await puppeteer.launch();
  });

  afterAll(async () => {
    await browser.close();
  });

  beforeEach(async () => {
    stdout = [];
    stderr = [];

    spyOn(process.stdout, 'write').and.callFake(captureLogs(stdout));
    spyOn(process.stderr, 'write').and.callFake(captureLogs(stderr));

    await helpers.setupTest();
    page = await browser.newPage();
    await page.goto(helpers.testSnapshotURL);
  });

  it('throws an error when a page is not provided', async () => {
    await expectAsync(percySnapshot())
      .toBeRejectedWith(new Error('A Puppeteer `page` object is required.'));
  });

  it('throws an error when a name is not provided', async () => {
    await expectAsync(percySnapshot(page))
      .toBeRejectedWith(new Error('The `name` argument is required.'));
  });

  it('disables snapshots when the healthcheck fails', async () => {
    await helpers.test('error', '/percy/healthcheck');

    await percySnapshot(page, 'Snapshot 1');
    await percySnapshot(page, 'Snapshot 2');
    expect(stdout).toEqual(jasmine.arrayContaining([
      '[percy] Percy is not running, disabling snapshots'
    ]));
  });

  it('posts snapshots to the local percy server', async () => {
    await percySnapshot(page, 'Snapshot 1');
    await percySnapshot(page, 'Snapshot 2');

    expect(await helpers.get('logs')).toEqual(jasmine.arrayContaining([
      'Snapshot found: Snapshot 1',
      'Snapshot found: Snapshot 2',
      `- url: ${helpers.testSnapshotURL}`,
      jasmine.stringMatching(/clientInfo: @percy\/puppeteer\/.+/),
      jasmine.stringMatching(/environmentInfo: puppeteer\/.+/)
    ]));
  });

  it('handles snapshot failures', async () => {
    await helpers.test('error', '/percy/snapshot');

    await percySnapshot(page, 'Snapshot 1');

    expect(stderr).toEqual(jasmine.arrayContaining([
      '[percy] Could not take DOM snapshot "Snapshot 1"'
    ]));
  });
});
