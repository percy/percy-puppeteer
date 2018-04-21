# @percy/puppeteer

Percy visual testing for Google Puppeteer.

# Beta Release

@percy/puppeteer is in early beta. It may contain bugs and sharp edges, and change in backwards-incompatible ways until v1.0.0 is released.

# Install

```
$ npm install puppeteer @percy/puppeteer --dev
```

# Usage

```js
import puppeteer from 'puppeteer';
import { Percy, FileSystemAssetLoader } from '@percy/puppeteer';

// Create a Percy client
const percy = new Percy({
    loaders: [
        new FileSystemAssetLoader({
            buildDir: './some-local-folder',
            mountPath: '/public/'
        })
    ]
});

// Start a Percy build
await percy.startBuild();

// Launch the browser and visit example.com
const browser = await puppeteer.launch();
const page = await browser.newPage();
await page.goto('https://example.com');

// Take a snapshot
await percy.snapshot('Snapshot of example.com', page);

// Tell Percy we're finished taking snapshots
await percy.finalizeBuild();

// Close the browser
browser.close();
```

# Acknowledgements
This package was originally forked from [percy-puppeteer](https://github.com/GitbookIO/percy-puppeteer), created by [Samy Pessé](https://twitter.com/SamyPesse) from [GitBook](https://www.gitbook.com/).  Thank you Samy!
