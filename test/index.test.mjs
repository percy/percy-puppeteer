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
  let lastPostedSnapshot;

  beforeEach(async () => {
    await helpers.setupTest();
    lastPostedSnapshot = null;
  });

  function buildMockPage({ pageUrl, pageHtml, frames = [] }) {
    // The lookup function used both by page.evaluate and by mainFrame.evaluate
    // when processFrame asks "which iframe element corresponds to this frame URL".
    // Real Puppeteer Frame objects expose .evaluate; tests need to as well so
    // processFrame's parentFrame.evaluate(...) call resolves correctly.
    const lookupIframeData = (fnStr, args) => {
      if (fnStr.includes('querySelectorAll') && fnStr.includes('iframe')) {
        const frameUrl = args[0];
        const matchingFrame = frames.find(f => f.url.startsWith(frameUrl) || frameUrl.startsWith(f.url));
        if (matchingFrame && matchingFrame.percyElementId) {
          return { percyElementId: matchingFrame.percyElementId };
        }
        return undefined;
      }
      return undefined;
    };

    const mainFrame = {
      url: () => pageUrl,
      parentFrame: () => null,
      evaluate: jasmine.createSpy('mainFrame.evaluate').and.callFake(async (fn, ...args) => {
        if (typeof fn === 'string') return undefined;
        return lookupIframeData(fn.toString(), args);
      })
    };

    const mockFrames = frames.map(f => {
      const frameObj = {
        url: () => f.url,
        // For top-level test frames, treat the main frame as the parent.
        parentFrame: () => mainFrame,
        evaluate: jasmine.createSpy(`frame.evaluate(${f.url})`).and.callFake(async (fn, ...args) => {
          if (typeof fn === 'string') return undefined;
          return f.snapshot || { html: '<html><body>iframe content</body></html>', resources: [], warnings: [] };
        })
      };
      return frameObj;
    });

    mockPage = {
      url: () => pageUrl,
      mainFrame: () => mainFrame,
      evaluate: jasmine.createSpy('page.evaluate').and.callFake(async (fn, ...args) => {
        if (typeof fn === 'string') return undefined;
        const fnStr = fn.toString();
        if (fnStr.includes('PercyDOM.serialize')) {
          return { html: pageHtml, resources: [], warnings: [] };
        }
        return lookupIframeData(fnStr, args);
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

    const logs = await helpers.get('logs');
    expect(logs).toEqual(jasmine.arrayContaining([
      'Snapshot found: No Iframes'
    ]));

    // Verify no corsIframes key in the posted snapshot
    const requestLogs = logs.join('\n');
    expect(requestLogs).not.toContain('corsIframes');
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

    // Same-origin frame should not have been evaluated for PercyDOM injection
    const sameOriginFrame = page.frames()[1];
    expect(sameOriginFrame.evaluate).not.toHaveBeenCalled();
  });

  it('adds corsIframes for cross-origin iframes with correct payload', async () => {
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

    // Verify the frame.evaluate was called with PercyDOM.serialize options including enableJavaScript
    const serializeCalls = crossFrame.evaluate.calls.allArgs()
      .filter(args => typeof args[0] === 'function');
    expect(serializeCalls.length).toBe(1);
    expect(serializeCalls[0][1]).toEqual(jasmine.objectContaining({ enableJavaScript: true }));
  });

  it('captures nested cross-origin iframes (cross-origin inside cross-origin)', async () => {
    // Mock a 3-level frame tree: page (example.com) -> outer (other.com) -> inner (deep.com)
    // page.frames() returns the flat list including the nested grandchild.
    const page = buildMockPage({
      pageUrl: 'https://example.com/',
      pageHtml: '<html><body><iframe src="https://other.com/outer"></iframe></body></html>',
      frames: [{
        url: 'https://other.com/outer',
        percyElementId: 'percy-outer',
        snapshot: { html: '<html>outer</html>', resources: [], warnings: [] }
      }]
    });

    const outerFrame = page.frames()[1];
    const innerFrame = {
      url: () => 'https://deep.com/inner',
      parentFrame: () => outerFrame,
      evaluate: jasmine.createSpy('inner.evaluate').and.callFake(async (fn, ...args) => {
        if (typeof fn === 'string') return undefined;
        // PercyDOM.serialize inside the inner cross-origin frame
        return { html: '<html>inner</html>', resources: [], warnings: [] };
      })
    };
    // The outer frame's DOM is what we look up the *inner* iframe element in.
    outerFrame.evaluate = jasmine.createSpy('outer.evaluate').and.callFake(async (fn, ...args) => {
      if (typeof fn === 'string') return undefined;
      const fnStr = fn.toString();
      if (fnStr.includes('PercyDOM.serialize')) {
        return { html: '<html>outer</html>', resources: [], warnings: [] };
      }
      if (fnStr.includes('querySelectorAll') && fnStr.includes('iframe')) {
        const u = args[0];
        if (u === 'https://deep.com/inner' || 'https://deep.com/inner'.startsWith(u)) {
          return { percyElementId: 'percy-inner' };
        }
      }
      return undefined;
    });

    const origFrames = page.frames;
    page.frames = () => [...origFrames(), innerFrame];

    await percySnapshot(page, 'Nested CORS');

    // Both outer and inner cross-origin frames should have been evaluated for PercyDOM.serialize
    const outerSerializeCalls = outerFrame.evaluate.calls.allArgs()
      .filter(args => typeof args[0] === 'function' && args[0].toString().includes('PercyDOM.serialize'));
    const innerSerializeCalls = innerFrame.evaluate.calls.allArgs()
      .filter(args => typeof args[0] === 'function' && args[0].toString().includes('PercyDOM.serialize'));
    expect(outerSerializeCalls.length).toBe(1);
    expect(innerSerializeCalls.length).toBe(1);
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

    const origFrames = page.frames;
    page.frames = () => [...origFrames(), blankFrame];

    await percySnapshot(page, 'Blank Frame Skip');

    expect(blankFrame.evaluate).not.toHaveBeenCalled();
  });

  it('skips data: URI frames', async () => {
    const dataFrame = {
      url: () => 'data:text/html,<h1>Hello</h1>',
      evaluate: jasmine.createSpy('data.evaluate')
    };

    const page = buildMockPage({
      pageUrl: 'https://example.com/',
      pageHtml: '<html><body>test</body></html>',
      frames: []
    });

    const origFrames = page.frames;
    page.frames = () => [...origFrames(), dataFrame];

    await percySnapshot(page, 'Data Frame Skip');

    expect(dataFrame.evaluate).not.toHaveBeenCalled();
  });

  it('skips javascript: URI frames', async () => {
    const jsFrame = {
      url: () => 'javascript:void(0)',
      evaluate: jasmine.createSpy('js.evaluate')
    };

    const page = buildMockPage({
      pageUrl: 'https://example.com/',
      pageHtml: '<html><body>test</body></html>',
      frames: []
    });

    const origFrames = page.frames;
    page.frames = () => [...origFrames(), jsFrame];

    await percySnapshot(page, 'JS Frame Skip');

    expect(jsFrame.evaluate).not.toHaveBeenCalled();
  });

  it('skips blob: URI frames', async () => {
    const blobFrame = {
      url: () => 'blob:https://example.com/abc-123',
      evaluate: jasmine.createSpy('blob.evaluate')
    };

    const page = buildMockPage({
      pageUrl: 'https://example.com/',
      pageHtml: '<html><body>test</body></html>',
      frames: []
    });

    const origFrames = page.frames;
    page.frames = () => [...origFrames(), blobFrame];

    await percySnapshot(page, 'Blob Frame Skip');

    expect(blobFrame.evaluate).not.toHaveBeenCalled();
  });

  it('skips chrome-extension: frames', async () => {
    const extFrame = {
      url: () => 'chrome-extension://abcdef/popup.html',
      evaluate: jasmine.createSpy('ext.evaluate')
    };

    const page = buildMockPage({
      pageUrl: 'https://example.com/',
      pageHtml: '<html><body>test</body></html>',
      frames: []
    });

    const origFrames = page.frames;
    page.frames = () => [...origFrames(), extFrame];

    await percySnapshot(page, 'Extension Frame Skip');

    expect(extFrame.evaluate).not.toHaveBeenCalled();
  });

  it('skips frames with missing percyElementId', async () => {
    const page = buildMockPage({
      pageUrl: 'https://example.com/',
      pageHtml: '<html><body><iframe src="https://other.com/no-id"></iframe></body></html>',
      frames: [{
        url: 'https://other.com/no-id',
        percyElementId: null,
        snapshot: { html: '<html><body>no id</body></html>', resources: [], warnings: [] }
      }]
    });

    await percySnapshot(page, 'Missing Percy Element Id');

    expect(await helpers.get('logs')).toEqual(jasmine.arrayContaining([
      'Snapshot found: Missing Percy Element Id'
    ]));

    // Frame should have been evaluated (injection + serialize), but result should be dropped
    const crossFrame = page.frames()[1];
    expect(crossFrame.evaluate).toHaveBeenCalled();
  });

  it('does not process frames where PercyDOM injection failed', async () => {
    let evaluateCallCount = 0;
    const failingFrame = {
      url: () => 'https://cross.example.com/',
      evaluate: jasmine.createSpy('failing.evaluate').and.callFake(async () => {
        evaluateCallCount++;
        if (evaluateCallCount === 1) {
          // First call is PercyDOM injection — fail it
          throw new Error('cross-origin access denied');
        }
        // Should never reach here — if injection failed, serialize should not be called
        return { html: '<html>should not appear</html>', resources: [], warnings: [] };
      })
    };

    const page = buildMockPage({
      pageUrl: 'https://example.com/',
      pageHtml: '<html><body><iframe src="https://cross.example.com/"></iframe></body></html>',
      frames: []
    });

    const origFrames = page.frames;
    page.frames = () => [...origFrames(), failingFrame];

    await expectAsync(percySnapshot(page, 'Frame Injection Failure')).not.toBeRejected();

    // Only the injection call should have been made, not the serialize call
    expect(evaluateCallCount).toBe(1);
  });

  it('continues gracefully when frame processing fails after injection', async () => {
    let evaluateCallCount = 0;
    const failingFrame = {
      url: () => 'https://cross.example.com/',
      evaluate: jasmine.createSpy('failing.evaluate').and.callFake(async (fn) => {
        evaluateCallCount++;
        if (evaluateCallCount === 1) {
          // First call: PercyDOM injection succeeds
          return undefined;
        }
        // Second call: PercyDOM.serialize fails
        throw new Error('serialize failed');
      })
    };

    const page = buildMockPage({
      pageUrl: 'https://example.com/',
      pageHtml: '<html><body><iframe src="https://cross.example.com/"></iframe></body></html>',
      frames: []
    });

    const origFrames = page.frames;
    page.frames = () => [...origFrames(), failingFrame];

    await expectAsync(percySnapshot(page, 'Frame Process Failure')).not.toBeRejected();

    expect(await helpers.get('logs')).toEqual(jasmine.arrayContaining([
      'Snapshot found: Frame Process Failure'
    ]));
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

  it('skips frames with empty string URL', async () => {
    const emptyFrame = {
      url: () => '',
      evaluate: jasmine.createSpy('empty.evaluate')
    };

    const page = buildMockPage({
      pageUrl: 'https://example.com/',
      pageHtml: '<html><body>test</body></html>',
      frames: []
    });

    const origFrames = page.frames;
    page.frames = () => [...origFrames(), emptyFrame];

    await percySnapshot(page, 'Empty URL Frame Skip');

    expect(emptyFrame.evaluate).not.toHaveBeenCalled();
  });

  it('handles frames with invalid URLs gracefully', async () => {
    const invalidFrame = {
      url: () => 'not-a-valid-url',
      evaluate: jasmine.createSpy('invalid.evaluate')
    };

    const page = buildMockPage({
      pageUrl: 'https://example.com/',
      pageHtml: '<html><body>test</body></html>',
      frames: []
    });

    const origFrames = page.frames;
    page.frames = () => [...origFrames(), invalidFrame];

    await expectAsync(percySnapshot(page, 'Invalid URL Frame')).not.toBeRejected();

    // Frame with invalid URL should not be processed
    expect(invalidFrame.evaluate).not.toHaveBeenCalled();
  });
});

describe('closed shadow root handling', () => {
  beforeEach(async () => {
    await helpers.setupTest();
  });

  function buildShadowDOMMockPage({ pageUrl, pageHtml, cdpSession }) {
    return {
      url: () => pageUrl,
      evaluate: jasmine.createSpy('page.evaluate').and.callFake(async (fn) => {
        if (typeof fn === 'string') return undefined;
        if (typeof fn === 'function' && fn.toString().includes('PercyDOM.serialize')) {
          return { html: pageHtml, resources: [], warnings: [] };
        }
        return undefined;
      }),
      frames: () => [{ url: () => pageUrl }],
      cookies: jasmine.createSpy('cookies').and.returnValue(Promise.resolve([])),
      target: () => ({
        createCDPSession: cdpSession
          ? jasmine.createSpy('createCDPSession').and.returnValue(Promise.resolve(cdpSession))
          : jasmine.createSpy('createCDPSession').and.throwError('Not Chromium')
      })
    };
  }

  it('succeeds when createCDPSession throws (non-Chromium browser)', async () => {
    const page = buildShadowDOMMockPage({
      pageUrl: 'https://example.com/',
      pageHtml: '<html><body>no cdp</body></html>',
      cdpSession: null
    });

    await percySnapshot(page, 'Non-Chromium Snapshot');

    expect(await helpers.get('logs')).toEqual(jasmine.arrayContaining([
      'Snapshot found: Non-Chromium Snapshot'
    ]));
  });

  it('disables DOM and returns when no closed shadow roots are found', async () => {
    const mockClient = {
      send: jasmine.createSpy('send').and.callFake(async (method) => {
        if (method === 'DOM.enable') return;
        if (method === 'DOM.getDocument') {
          return {
            root: {
              backendNodeId: 1,
              children: [
                {
                  backendNodeId: 2,
                  shadowRoots: [
                    { backendNodeId: 3, shadowRootType: 'open', children: [] }
                  ],
                  children: []
                }
              ]
            }
          };
        }
        if (method === 'DOM.disable') return;
      }),
      detach: jasmine.createSpy('detach').and.returnValue(Promise.resolve())
    };

    const page = buildShadowDOMMockPage({
      pageUrl: 'https://example.com/',
      pageHtml: '<html><body>open shadow only</body></html>',
      cdpSession: mockClient
    });

    await percySnapshot(page, 'No Closed Shadows');

    expect(await helpers.get('logs')).toEqual(jasmine.arrayContaining([
      'Snapshot found: No Closed Shadows'
    ]));
    expect(mockClient.send).toHaveBeenCalledWith('DOM.enable');
    expect(mockClient.send).toHaveBeenCalledWith('DOM.getDocument', { depth: -1, pierce: true });
    expect(mockClient.send).toHaveBeenCalledWith('DOM.disable');
    expect(mockClient.send).not.toHaveBeenCalledWith('DOM.resolveNode', jasmine.anything());
    expect(mockClient.detach).toHaveBeenCalled();
  });

  it('exposes closed shadow roots via CDP', async () => {
    const mockClient = {
      send: jasmine.createSpy('send').and.callFake(async (method, params) => {
        if (method === 'DOM.enable') return;
        if (method === 'DOM.getDocument') {
          return {
            root: {
              backendNodeId: 1,
              children: [
                {
                  backendNodeId: 10,
                  shadowRoots: [
                    { backendNodeId: 20, shadowRootType: 'closed', children: [] }
                  ],
                  children: []
                }
              ]
            }
          };
        }
        if (method === 'DOM.resolveNode') {
          return { object: { objectId: `obj-${params.backendNodeId}` } };
        }
        if (method === 'Runtime.callFunctionOn') return;
        if (method === 'DOM.disable') return;
      }),
      detach: jasmine.createSpy('detach').and.returnValue(Promise.resolve())
    };

    const page = buildShadowDOMMockPage({
      pageUrl: 'https://example.com/',
      pageHtml: '<html><body>closed shadow</body></html>',
      cdpSession: mockClient
    });

    await percySnapshot(page, 'Closed Shadow Roots');

    expect(await helpers.get('logs')).toEqual(jasmine.arrayContaining([
      'Snapshot found: Closed Shadow Roots'
    ]));
    expect(mockClient.send).toHaveBeenCalledWith('DOM.enable');
    expect(mockClient.send).toHaveBeenCalledWith('DOM.getDocument', { depth: -1, pierce: true });
    expect(mockClient.send).toHaveBeenCalledWith('DOM.resolveNode', { backendNodeId: 10 });
    expect(mockClient.send).toHaveBeenCalledWith('DOM.resolveNode', { backendNodeId: 20 });
    expect(mockClient.send).toHaveBeenCalledWith('Runtime.callFunctionOn', jasmine.objectContaining({
      objectId: 'obj-10',
      arguments: [{ objectId: 'obj-20' }]
    }));
    expect(mockClient.send).toHaveBeenCalledWith('DOM.disable');
    expect(mockClient.detach).toHaveBeenCalled();
  });

  it('catches CDP errors and still succeeds with snapshot', async () => {
    const mockClient = {
      send: jasmine.createSpy('send').and.callFake(async (method) => {
        if (method === 'DOM.enable') return;
        if (method === 'DOM.getDocument') {
          throw new Error('CDP DOM.getDocument failed');
        }
      }),
      detach: jasmine.createSpy('detach').and.returnValue(Promise.resolve())
    };

    const page = buildShadowDOMMockPage({
      pageUrl: 'https://example.com/',
      pageHtml: '<html><body>cdp error</body></html>',
      cdpSession: mockClient
    });

    await percySnapshot(page, 'CDP Error Snapshot');

    expect(await helpers.get('logs')).toEqual(jasmine.arrayContaining([
      'Snapshot found: CDP Error Snapshot'
    ]));
    expect(mockClient.detach).toHaveBeenCalled();
  });

  it('handles multiple closed shadow roots', async () => {
    const mockClient = {
      send: jasmine.createSpy('send').and.callFake(async (method, params) => {
        if (method === 'DOM.enable') return;
        if (method === 'DOM.getDocument') {
          return {
            root: {
              backendNodeId: 1,
              children: [
                {
                  backendNodeId: 10,
                  shadowRoots: [
                    { backendNodeId: 20, shadowRootType: 'closed', children: [] }
                  ],
                  children: []
                },
                {
                  backendNodeId: 30,
                  shadowRoots: [
                    { backendNodeId: 40, shadowRootType: 'closed', children: [] }
                  ],
                  children: []
                }
              ]
            }
          };
        }
        if (method === 'DOM.resolveNode') {
          return { object: { objectId: `obj-${params.backendNodeId}` } };
        }
        if (method === 'Runtime.callFunctionOn') return;
        if (method === 'DOM.disable') return;
      }),
      detach: jasmine.createSpy('detach').and.returnValue(Promise.resolve())
    };

    const page = buildShadowDOMMockPage({
      pageUrl: 'https://example.com/',
      pageHtml: '<html><body>multiple closed</body></html>',
      cdpSession: mockClient
    });

    await percySnapshot(page, 'Multiple Closed Shadows');

    expect(await helpers.get('logs')).toEqual(jasmine.arrayContaining([
      'Snapshot found: Multiple Closed Shadows'
    ]));

    // DOM.resolveNode called for each host and shadow pair (2 pairs = 4 calls)
    const resolveNodeCalls = mockClient.send.calls.allArgs()
      .filter(args => args[0] === 'DOM.resolveNode');
    expect(resolveNodeCalls.length).toBe(4);
    expect(resolveNodeCalls).toEqual(jasmine.arrayContaining([
      ['DOM.resolveNode', { backendNodeId: 10 }],
      ['DOM.resolveNode', { backendNodeId: 20 }],
      ['DOM.resolveNode', { backendNodeId: 30 }],
      ['DOM.resolveNode', { backendNodeId: 40 }]
    ]));

    // Runtime.callFunctionOn called once per pair
    const callFunctionOnCalls = mockClient.send.calls.allArgs()
      .filter(args => args[0] === 'Runtime.callFunctionOn');
    expect(callFunctionOnCalls.length).toBe(2);
  });

  it('recurses into nested shadow roots (open containing closed)', async () => {
    const mockClient = {
      send: jasmine.createSpy('send').and.callFake(async (method, params) => {
        if (method === 'DOM.enable') return;
        if (method === 'DOM.getDocument') {
          return {
            root: {
              backendNodeId: 1,
              children: [
                {
                  backendNodeId: 10,
                  shadowRoots: [
                    {
                      backendNodeId: 20,
                      shadowRootType: 'open',
                      children: [
                        {
                          backendNodeId: 30,
                          shadowRoots: [
                            { backendNodeId: 40, shadowRootType: 'closed', children: [] }
                          ],
                          children: []
                        }
                      ]
                    }
                  ],
                  children: []
                }
              ]
            }
          };
        }
        if (method === 'DOM.resolveNode') {
          return { object: { objectId: `obj-${params.backendNodeId}` } };
        }
        if (method === 'Runtime.callFunctionOn') return;
        if (method === 'DOM.disable') return;
      }),
      detach: jasmine.createSpy('detach').and.returnValue(Promise.resolve())
    };

    const page = buildShadowDOMMockPage({
      pageUrl: 'https://example.com/',
      pageHtml: '<html><body>nested shadow</body></html>',
      cdpSession: mockClient
    });

    await percySnapshot(page, 'Nested Shadow Roots');

    expect(await helpers.get('logs')).toEqual(jasmine.arrayContaining([
      'Snapshot found: Nested Shadow Roots'
    ]));

    // The closed shadow root (40) nested inside the open one (20) should be found
    expect(mockClient.send).toHaveBeenCalledWith('DOM.resolveNode', { backendNodeId: 30 });
    expect(mockClient.send).toHaveBeenCalledWith('DOM.resolveNode', { backendNodeId: 40 });
    expect(mockClient.send).toHaveBeenCalledWith('Runtime.callFunctionOn', jasmine.objectContaining({
      objectId: 'obj-30',
      arguments: [{ objectId: 'obj-40' }]
    }));

    // Only one pair should be found (the closed one, not the open one)
    const callFunctionOnCalls = mockClient.send.calls.allArgs()
      .filter(args => args[0] === 'Runtime.callFunctionOn');
    expect(callFunctionOnCalls.length).toBe(1);
  });

  it('skips closed shadow roots inside child frame documents', async () => {
    const mockClient = {
      send: jasmine.createSpy('send').and.callFake(async (method, params) => {
        if (method === 'DOM.enable') return;
        if (method === 'DOM.getDocument') {
          return {
            root: {
              backendNodeId: 1,
              children: [
                {
                  // An iframe node with contentDocument — should be skipped
                  backendNodeId: 50,
                  contentDocument: {
                    backendNodeId: 51,
                    children: [
                      {
                        backendNodeId: 60,
                        shadowRoots: [
                          { backendNodeId: 70, shadowRootType: 'closed', children: [] }
                        ],
                        children: []
                      }
                    ]
                  },
                  children: []
                }
              ]
            }
          };
        }
        if (method === 'DOM.resolveNode') {
          return { object: { objectId: `obj-${params.backendNodeId}` } };
        }
        if (method === 'Runtime.callFunctionOn') return;
      }),
      detach: jasmine.createSpy('detach').and.returnValue(Promise.resolve())
    };

    const page = buildShadowDOMMockPage({
      pageUrl: 'https://example.com/',
      pageHtml: '<html><body>iframe with closed shadow</body></html>',
      cdpSession: mockClient
    });

    await percySnapshot(page, 'Iframe Shadow Roots Skipped');

    expect(await helpers.get('logs')).toEqual(jasmine.arrayContaining([
      'Snapshot found: Iframe Shadow Roots Skipped'
    ]));

    // The closed shadow root inside the iframe contentDocument should NOT be processed
    const callFunctionOnCalls = mockClient.send.calls.allArgs()
      .filter(args => args[0] === 'Runtime.callFunctionOn');
    expect(callFunctionOnCalls.length).toBe(0);
  });
});
