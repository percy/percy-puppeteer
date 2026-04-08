import puppeteer from 'puppeteer';
import helpers from '@percy/sdk-utils/test/helpers';
import percySnapshot from '../index.js';

describe('percySnapshot', () => {
  let browser, page;

  beforeAll(async function() {
    browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
  });

  afterAll(async () => {
    await browser.close();
  });

  beforeEach(async () => {
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
    expect(helpers.logger.stdout).toEqual(jasmine.arrayContaining([
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

    expect(helpers.logger.stderr).toEqual(jasmine.arrayContaining([
      '[percy] Could not take DOM snapshot "Snapshot 1"'
    ]));
  });
});

describe('cross-origin iframe handling', () => {
  let mockPage;

  beforeEach(async () => {
    await helpers.setupTest();
  });

  function buildMockPage({ pageUrl, pageHtml, frames = [] }) {
    const mainFrame = {
      url: () => pageUrl
    };

    const mockFrames = frames.map(f => ({
      url: () => f.url,
      evaluate: jasmine.createSpy(`frame.evaluate(${f.url})`).and.callFake(async (fn, ...args) => {
        // If fn is a string (percyDOM script injection), return undefined
        if (typeof fn === 'string') return undefined;
        // If fn is a function (PercyDOM.serialize call), return the iframe snapshot
        return f.snapshot || { html: '<html><body>iframe content</body></html>', resources: [], warnings: [] };
      })
    }));

    mockPage = {
      url: () => pageUrl,
      evaluate: jasmine.createSpy('page.evaluate').and.callFake(async (fn, ...args) => {
        // First call: inject percyDOM script (string)
        if (typeof fn === 'string') return undefined;
        // Function calls
        const fnStr = fn.toString();
        if (fnStr.includes('PercyDOM.serialize')) {
          return { html: pageHtml, resources: [], warnings: [] };
        }
        // Looking up iframe element by URL (processFrame's page.evaluate)
        if (fnStr.includes('querySelectorAll') && fnStr.includes('iframe')) {
          const frameUrl = args[0];
          const matchingFrame = frames.find(f => f.url.startsWith(frameUrl) || frameUrl.startsWith(f.url));
          if (matchingFrame) {
            return { percyElementId: matchingFrame.percyElementId || `percy-ele-${frames.indexOf(matchingFrame)}` };
          }
          return undefined;
        }
        return undefined;
      }),
      frames: () => [mainFrame, ...mockFrames],
      cookies: jasmine.createSpy('cookies').and.returnValue(Promise.resolve([]))
    };

    return mockPage;
  }

  it('does not add corsIframes when no cross-origin iframes exist', async () => {
    const page = buildMockPage({
      pageUrl: 'https://example.com/',
      pageHtml: '<html><body><p>No iframes</p></body></html>',
      frames: []
    });

    await percySnapshot(page, 'No Iframes');

    expect(await helpers.get('logs')).toEqual(jasmine.arrayContaining([
      'Snapshot found: No Iframes'
    ]));
  });

  it('does not add corsIframes for same-origin iframes', async () => {
    const page = buildMockPage({
      pageUrl: 'https://example.com/',
      pageHtml: '<html><body><iframe src="https://example.com/child"></iframe></body></html>',
      frames: [{ url: 'https://example.com/child' }]
    });

    await percySnapshot(page, 'Same Origin Iframe');

    expect(await helpers.get('logs')).toEqual(jasmine.arrayContaining([
      'Snapshot found: Same Origin Iframe'
    ]));
  });

  it('adds corsIframes for cross-origin iframes', async () => {
    const page = buildMockPage({
      pageUrl: 'https://example.com/',
      pageHtml: '<html><body><iframe src="https://other.com/embed"></iframe></body></html>',
      frames: [{
        url: 'https://other.com/embed',
        percyElementId: 'percy-iframe-1',
        snapshot: { html: '<html><body>cross-origin content</body></html>', resources: [], warnings: [] }
      }]
    });

    await percySnapshot(page, 'Cross Origin Iframe');

    expect(await helpers.get('logs')).toEqual(jasmine.arrayContaining([
      'Snapshot found: Cross Origin Iframe'
    ]));

    // Verify percyDOM was injected into the cross-origin frame
    const crossFrame = page.frames()[1];
    expect(crossFrame.evaluate).toHaveBeenCalled();
  });

  it('handles multiple cross-origin iframes', async () => {
    const page = buildMockPage({
      pageUrl: 'https://example.com/',
      pageHtml: '<html><body><iframe src="https://a.com/"></iframe><iframe src="https://b.com/"></iframe></body></html>',
      frames: [
        { url: 'https://a.com/', percyElementId: 'percy-iframe-a', snapshot: { html: '<html>A</html>', resources: [], warnings: [] } },
        { url: 'https://b.com/', percyElementId: 'percy-iframe-b', snapshot: { html: '<html>B</html>', resources: [], warnings: [] } }
      ]
    });

    await percySnapshot(page, 'Multiple Cross Origin');

    expect(await helpers.get('logs')).toEqual(jasmine.arrayContaining([
      'Snapshot found: Multiple Cross Origin'
    ]));

    // Both frames should have had percyDOM injected
    expect(page.frames()[1].evaluate).toHaveBeenCalled();
    expect(page.frames()[2].evaluate).toHaveBeenCalled();
  });

  it('skips about:blank frames', async () => {
    const blankFrame = {
      url: () => 'about:blank',
      evaluate: jasmine.createSpy('blank.evaluate')
    };

    const page = buildMockPage({
      pageUrl: 'https://example.com/',
      pageHtml: '<html><body>test</body></html>',
      frames: []
    });

    // Manually add about:blank frame
    const origFrames = page.frames;
    page.frames = () => [...origFrames(), blankFrame];

    await percySnapshot(page, 'Blank Frame Skip');

    expect(blankFrame.evaluate).not.toHaveBeenCalled();
  });

  it('continues gracefully when frame injection fails', async () => {
    const failingFrame = {
      url: () => 'https://cross.example.com/',
      evaluate: jasmine.createSpy('failing.evaluate').and.rejectWith(new Error('cross-origin access denied'))
    };

    const page = buildMockPage({
      pageUrl: 'https://example.com/',
      pageHtml: '<html><body><iframe src="https://cross.example.com/"></iframe></body></html>',
      frames: []
    });

    const origFrames = page.frames;
    page.frames = () => [...origFrames(), failingFrame];

    await expectAsync(percySnapshot(page, 'Frame Error Graceful')).not.toBeRejected();
  });

  it('captures cookies along with the snapshot', async () => {
    const page = buildMockPage({
      pageUrl: 'https://example.com/',
      pageHtml: '<html><body>test</body></html>',
      frames: []
    });

    page.cookies.and.returnValue(Promise.resolve([
      { name: 'session', value: 'abc123', domain: 'example.com' }
    ]));

    await percySnapshot(page, 'With Cookies');

    expect(await helpers.get('logs')).toEqual(jasmine.arrayContaining([
      'Snapshot found: With Cookies'
    ]));
    expect(page.cookies).toHaveBeenCalled();
  });
});
