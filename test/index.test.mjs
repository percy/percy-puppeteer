import puppeteer from 'puppeteer';
import helpers from '@percy/sdk-utils/test/helpers';
import percySnapshot from '../index.js';

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
    // The readiness call sends a STRING script (from sdk-utils.waitForReadyScript);
    // serialize sends a FUNCTION reference. That difference lets us identify each call.
    const isReadinessEval = (args) => typeof args[0] === 'string' && args[0].includes('PercyDOM.waitForReady');
    const isSerializeEval = (args) => typeof args[0] === 'function' && args[0].toString().includes('PercyDOM.serialize');

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

    it('inlines the readiness config as JSON into the script sent to the browser', async () => {
      const spy = spyOn(page, 'evaluate').and.callThrough();
      const readiness = { preset: 'strict', stabilityWindowMs: 500 };

      await percySnapshot(page, 'readiness-config', { readiness });

      const readinessCall = spy.calls.allArgs().find(isReadinessEval);
      expect(readinessCall).toBeDefined();
      // sdk-utils.waitForReadyScript inlines the config via JSON.stringify
      // rather than passing it as a separate page.evaluate argument.
      expect(readinessCall[0]).toContain('"preset":"strict"');
      expect(readinessCall[0]).toContain('"stabilityWindowMs":500');
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
      spyOn(page, 'evaluate').and.callFake((script, ...rest) => {
        if (typeof script === 'string' && script.includes('PercyDOM.waitForReady')) {
          return Promise.reject(new Error('readiness boom'));
        }
        return origEvaluate(script, ...rest);
      });

      await percySnapshot(page, 'readiness-reject');

      expect(helpers.logger.stderr).not.toEqual(jasmine.arrayContaining([
        '[percy] Could not take DOM snapshot "readiness-reject"'
      ]));
    });

    it('still runs serialize when waitForReady rejects with a non-Error', async () => {
      // Covers the `err?.message || err` second branch: a string rejection
      // has no `.message`, so logging falls through to stringifying err itself.
      const origEvaluate = page.evaluate.bind(page);
      spyOn(page, 'evaluate').and.callFake((script, ...rest) => {
        if (typeof script === 'string' && script.includes('PercyDOM.waitForReady')) {
          return Promise.reject('plain-string-rejection');
        }
        return origEvaluate(script, ...rest);
      });

      await percySnapshot(page, 'readiness-reject-string');

      expect(helpers.logger.stderr).not.toEqual(jasmine.arrayContaining([
        '[percy] Could not take DOM snapshot "readiness-reject-string"'
      ]));
    });

    it('attaches diagnostics returned by waitForReady to domSnapshot', async () => {
      const diagnostics = { passed: true, timed_out: false, preset: 'balanced', total_duration_ms: 84, checks: {} };
      const domSnapshot = { html: '<html></html>' };
      spyOn(page, 'evaluate').and.callFake((script) => {
        if (typeof script === 'string' && script.includes('PercyDOM.waitForReady')) {
          return Promise.resolve(diagnostics);
        }
        if (typeof script === 'function' && script.toString().includes('PercyDOM.serialize')) {
          return Promise.resolve(domSnapshot);
        }
        return Promise.resolve();
      });

      await percySnapshot(page, 'readiness-diagnostics');

      expect(domSnapshot.readiness_diagnostics).toEqual(diagnostics);
    });
  });
});
