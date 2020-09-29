const expect = require('expect');
const puppeteer = require('puppeteer');
const stdio = require('@percy/logger/test/helper');
const createTestServer = require('@percy/core/test/helpers/server');
const percySnapshot = require('..');

describe('percySnapshot', () => {
  let browser, page, percyServer, testServer;

  before(async function() {
    this.timeout(0);
    browser = await puppeteer.launch();
  });

  after(async () => {
    await browser.close();
  });

  beforeEach(async () => {
    // clear cached results
    percySnapshot.isPercyEnabled.reset();

    // mock percy server
    percyServer = await createTestServer({
      '/percy/dom.js': () => [200, 'application/javascript', (
        'window.PercyDOM = { serialize: () => document.documentElement.outerHTML }')],
      default: () => [200, 'application/json', { success: true }]
    }, 5338);

    // test site server
    testServer = await createTestServer({
      default: () => [200, 'text/html', 'Snapshot Me']
    });

    // go to test site
    page = await browser.newPage();
    await page.goto('http://localhost:8000');
  });

  afterEach(async () => {
    delete process.env.PERCY_LOGLEVEL;
    await percyServer.close();
    await testServer.close();
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

  it('disables snapshots when the API fails', async () => {
    percyServer.reply('/percy/dom.js', () => Promise.reject(new Error()));

    await stdio.capture(async () => {
      await percySnapshot(page, 'Snapshot 1');
      await percySnapshot(page, 'Snapshot 2');
    });

    expect(percyServer.requests).toEqual([
      ['/percy/dom.js']
    ]);

    expect(stdio[2]).toHaveLength(0);
    expect(stdio[1]).toEqual([
      '[percy] Percy is not running, disabling snapshots\n'
    ]);
  });

  it('disables snapshots when the API encounters an error', async () => {
    percyServer.reply('/percy/dom.js', req => req.connection.destroy());
    process.env.PERCY_LOGLEVEL = 'debug';

    await stdio.capture(async () => {
      await percySnapshot(page, 'Snapshot 1');
      await percySnapshot(page, 'Snapshot 2');
    });

    expect(percyServer.requests).toEqual([
      ['/percy/dom.js']
    ]);

    expect(stdio[2]).toEqual([
      expect.stringMatching(/\[percy] FetchError: .* reason: socket hang up\n/)
    ]);
    expect(stdio[1]).toEqual([
      '[percy] Percy is not running, disabling snapshots\n'
    ]);
  });

  it('disables snapshots when the API is the incorrect version', async () => {
    percyServer.version = '';

    await stdio.capture(async () => {
      await percySnapshot(page, 'Snapshot 1');
      await percySnapshot(page, 'Snapshot 2');
    });

    expect(percyServer.requests).toEqual([
      ['/percy/dom.js']
    ]);

    expect(stdio[2]).toHaveLength(0);
    expect(stdio[1]).toEqual([
      '[percy] Unsupported Percy CLI version, disabling snapshots\n'
    ]);
  });

  it('posts snapshots to the local percy server', async () => {
    await percySnapshot(page, 'Snapshot 1');
    await percySnapshot(page, 'Snapshot 2');

    expect(percyServer.requests).toEqual([
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
  });

  it('handles snapshot errors', async () => {
    percyServer.reply('/percy/snapshot', () => (
      [400, 'application/json', { success: false, error: 'testing' }]
    ));

    await stdio.capture(async () => {
      await percySnapshot(page, 'Snapshot 1');
    });

    expect(stdio[1]).toHaveLength(0);
    expect(stdio[2]).toEqual([
      '[percy] Could not take DOM snapshot "Snapshot 1"\n',
      '[percy] Error: testing\n'
    ]);
  });
});
