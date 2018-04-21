# Releasing

1. `git checkout -b version-bump`
1. `yarn login`
1. `yarn version` - enter new version
1. `git push origin version-bump`
1. Issue a PR for `version-bump` and merge.
1. `git push --tags` (possibly wrong now, improve next time through)
1. Ensure tests have passed on that tag
1. [Update the release notes](https://github.com/percy/percy-pupeteer/releases) on GitHub
1. `yarn publish` (leave new version blank)
1. [Visit npm](https://www.npmjs.com/package/@percy/puppeteer) and see the new version is live

* Announce the new release,
   making sure to say "thank you" to the contributors
   who helped shape this version!
