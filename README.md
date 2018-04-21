# @percy/puppeteer

Percy integration for Google Puppeteer.

# Install

```
$ npm install puppeteer @percy/puppeteer --dev
```

# Usage

```js
import puppeteer from 'puppeteer';
import { Percy, FileSystemAssetLoader } from '@percy/puppeteer';

// Create a percy client
const percy = new Percy({
    loaders: [
        new FileSystemAssetLoader({
            buildDir: './some-local-folder',
            mountPath: '/public/'
        })
    ]
});

// Start a build
await percy.startBuild();


// Do some stuffs with puppeteer
const browser = await puppeteer.launch();
const page = await browser.newPage();
await page.goto('https://example.com');

// Take a screemshot
await percy.takeScreenshot('First Screenshot', page);

// Push the result to Percy
await percy.finalizeBuild();
```
