import { SpecReporter } from 'jasmine-spec-reporter';

jasmine.DEFAULT_TIMEOUT_INTERVAL = 10000;
const env = jasmine.getEnv();

// allow re-spying
env.allowRespy(true);
env.clearReporters();
env.addReporter(
  new SpecReporter({
    spec: { displayPending: true },
    summary: { displayPending: false }
  })
);

if (process.env.DUMP_FAILED_TEST_LOGS) {
  // add a spec reporter to dump failed logs
  env.addReporter({
    specDone: async ({ status }) => {
      if (status === 'failed') {
        let helpers = await import('@percy/cli-command/test/helpers');
        helpers.logger.dump();
      }
    }
  });
}
