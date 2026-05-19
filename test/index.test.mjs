import puppeteer from 'puppeteer';
import helpers from '@percy/sdk-utils/test/helpers';
import percySnapshot from '../index.js';

const { browserWaitForReady } = percySnapshot.__test__;

describe('percySnapshot', () => {
  let browser, page;

  beforeAll(async function() {
    // GitHub-hosted Ubuntu runners disable the Chromium SUID sandbox, so
    // puppeteer.launch() needs --no-sandbox to bring up the browser in CI.
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

  describe('readiness gate (PER-7348)', () => {
    const isReadinessEval = (args) => {
      const fn = args[0];
      return typeof fn === 'function' && fn.toString().includes('waitForReady');
    };
    const isSerializeEval = (args) => {
      const fn = args[0];
      return typeof fn === 'function' && fn.toString().includes('PercyDOM.serialize');
    };

    it('runs waitForReady before serialize by default', async () => {
      const spy = spyOn(page, 'evaluate').and.callThrough();

      await percySnapshot(page, 'readiness-happy-path');

      const calls = spy.calls.allArgs();
      const rIdx = calls.findIndex(isReadinessEval);
      const sIdx = calls.findIndex(isSerializeEval);
      expect(rIdx).toBeGreaterThanOrEqual(0);
      expect(sIdx).toBeGreaterThanOrEqual(0);
      expect(rIdx).toBeLessThan(sIdx);
    });

    it('passes readiness config through to waitForReady', async () => {
      const spy = spyOn(page, 'evaluate').and.callThrough();
      const readiness = { preset: 'strict', stabilityWindowMs: 500 };

      await percySnapshot(page, 'readiness-config', { readiness });

      const readinessCall = spy.calls.allArgs().find(isReadinessEval);
      expect(readinessCall).toBeDefined();
      expect(readinessCall[1]).toEqual(readiness);
    });

    it('skips waitForReady when preset is disabled', async () => {
      const spy = spyOn(page, 'evaluate').and.callThrough();

      await percySnapshot(page, 'readiness-disabled', { readiness: { preset: 'disabled' } });

      const readinessCall = spy.calls.allArgs().find(isReadinessEval);
      expect(readinessCall).toBeUndefined();
      expect(spy.calls.allArgs().find(isSerializeEval)).toBeDefined();
    });

    it('still runs serialize when waitForReady rejects', async () => {
      const origEvaluate = page.evaluate.bind(page);
      spyOn(page, 'evaluate').and.callFake((fn, ...rest) => {
        if (typeof fn === 'function' && fn.toString().includes('waitForReady')) {
          return Promise.reject(new Error('readiness boom'));
        }
        return origEvaluate(fn, ...rest);
      });

      await percySnapshot(page, 'readiness-reject');

      expect(helpers.logger.stderr).not.toEqual(jasmine.arrayContaining([
        '[percy] Could not take DOM snapshot "readiness-reject"'
      ]));
    });

    it('still runs serialize when waitForReady rejects with a non-Error', async () => {
      // Exercises the `err?.message || err` second branch: when the rejection
      // value has no `.message` (e.g. a plain string), we fall through to
      // stringifying the err itself.
      const origEvaluate = page.evaluate.bind(page);
      spyOn(page, 'evaluate').and.callFake((fn, ...rest) => {
        if (typeof fn === 'function' && fn.toString().includes('waitForReady')) {
          return Promise.reject('plain-string-rejection');
        }
        return origEvaluate(fn, ...rest);
      });

      await percySnapshot(page, 'readiness-reject-string');

      expect(helpers.logger.stderr).not.toEqual(jasmine.arrayContaining([
        '[percy] Could not take DOM snapshot "readiness-reject-string"'
      ]));
    });

    it('attaches diagnostics returned by waitForReady to domSnapshot', async () => {
      const diagnostics = { passed: true, timed_out: false, preset: 'balanced', total_duration_ms: 84, checks: {} };
      const domSnapshot = { html: '<html></html>' };
      spyOn(page, 'evaluate').and.callFake((fn) => {
        if (typeof fn === 'function' && fn.toString().includes('waitForReady')) {
          return Promise.resolve(diagnostics);
        }
        if (typeof fn === 'function' && fn.toString().includes('PercyDOM.serialize')) {
          return Promise.resolve(domSnapshot);
        }
        return Promise.resolve();
      });

      await percySnapshot(page, 'readiness-diagnostics');

      expect(domSnapshot.readiness_diagnostics).toEqual(diagnostics);
    });
  });
});

// Unit tests for the in-browser readiness invoker. These run in Node against
// a stubbed `PercyDOM` global so the typeof-guard branches are real
// statement/branch coverage — that's why index.js no longer needs
// `/* istanbul ignore next */` around the page.evaluate callback.
describe('browserWaitForReady', () => {
  afterEach(() => {
    delete globalThis.PercyDOM;
  });

  it('returns undefined when PercyDOM is undefined', () => {
    expect(browserWaitForReady({ preset: 'balanced' })).toBeUndefined();
  });

  it('returns undefined when PercyDOM lacks waitForReady', () => {
    globalThis.PercyDOM = {};
    expect(browserWaitForReady({ preset: 'balanced' })).toBeUndefined();
  });

  it('forwards config to PercyDOM.waitForReady and returns its value', async () => {
    const diagnostics = { passed: true, preset: 'strict' };
    const waitForReady = jasmine.createSpy('waitForReady')
      .and.returnValue(Promise.resolve(diagnostics));
    globalThis.PercyDOM = { waitForReady };

    const config = { preset: 'strict', stabilityWindowMs: 500 };
    const result = browserWaitForReady(config);

    expect(waitForReady).toHaveBeenCalledWith(config);
    await expectAsync(result).toBeResolvedTo(diagnostics);
  });
});
