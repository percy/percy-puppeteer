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

// Take a screenshot
await percy.takeScreenshot('First Screenshot', page);

// Push the result to Percy
await percy.finalizeBuild();
```

# Acknowledgements
This package was originally forked from [percy-puppeteer](https://github.com/GitbookIO/percy-puppeteer), created by [Samy Pessé](https://twitter.com/SamyPesse) from [GitBook](https://www.gitbook.com/).  Thank you Samy!
