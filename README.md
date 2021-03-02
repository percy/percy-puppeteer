# @percy/puppeteer
[![Version](https://img.shields.io/npm/v/@percy/puppeteer.svg)](https://npmjs.org/package/@percy/puppeteer)
![Test](https://github.com/percy/percy-puppeteer/workflows/Test/badge.svg)

[Percy](https://percy.io) visual testing for Google Puppeteer.

## Installation

Using yarn:

```sh-session
$ yarn add --dev @percy/cli @percy/puppeteer
```

Using npm:

```sh-session
$ npm install --save-dev @percy/cli @percy/puppeteer
```

## Usage

This is an example using the `percySnapshot` function. For other examples of `puppeteer`
usage, see the [Puppeteer docs](https://pptr.dev).

```javascript
const puppeteer = require('puppeteer');
const percySnapshot = require('@percy/puppeteer');

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.goto('http://example.com/', { waitUntil: 'networkidle2' });
  await percySnapshot(page, 'Example Site');

  await browser.close();
})();
```

Running the code above directly will result in the following logs:

```sh-session
$ node script.js
[percy] Percy is not running, disabling snapshots
```

When running with [`percy
exec`](https://github.com/percy/cli/tree/master/packages/cli-exec#percy-exec), and your project's
`PERCY_TOKEN`, a new Percy build will be created and snapshots will be uploaded to your project.

```sh-session
$ export PERCY_TOKEN=[your-project-token]
$ percy exec -- node script.js
[percy] Percy has started!
[percy] Created build #1: https://percy.io/[your-project]
[percy] Running "node script.js"
[percy] Snapshot taken "Example Site"
[percy] Stopping percy...
[percy] Finalized build #1: https://percy.io/[your-project]
[percy] Done!
```

## Configuration

`percySnapshot(page, name[, options])`

- `page` (**required**) - A `puppeteer` page instance
- `name` (**required**) - The snapshot name; must be unique to each snapshot
- `options` - Additional snapshot options (overrides any project options)
  - `options.widths` - An array of widths to take screenshots at
  - `options.minHeight` - The minimum viewport height to take screenshots at
  - `options.percyCSS` - Percy specific CSS only applied in Percy's rendering environment
  - `options.requestHeaders` - Headers that should be used during asset discovery
  - `options.enableJavaScript` - Enable JavaScript in Percy's rendering environment

## Upgrading

### Automatically with `@percy/migrate`

We built a tool to help automate migrating to the new CLI toolchain! Migrating 
can be done by running the following commands and following the prompts:

``` shell
$ npx @percy/migrate
? Are you currently using @percy/puppeteer? Yes
? Install @percy/cli (required to run percy)? Yes
? Migrate Percy config file? Yes
? Upgrade SDK to @percy/puppeteer@2.0.0? Yes
```

This will automatically run the changes described below for you.

### Manually

#### Import change

In `v1.x` there wasn't a default export of the package (only a named
export). With `v2.x` the named export is removed and there is only a default
export.

``` javascript
// old
import { percySnapshot } from '@percy/puppeteer';
const { percySnapshot } = require('@percy/puppeteer');

// new
import percySnapshot from '@percy/puppeteer';
const percySnapshot = require('@percy/puppeteer');
```

#### Migrating Config

If you have a previous Percy configuration file, migrate it to the newest version with the
[`config:migrate`](https://github.com/percy/cli/tree/master/packages/cli-config#percy-configmigrate-filepath-output) command:

```sh-session
$ percy config:migrate
```
