/* @flow */
import PercyClient from 'percy-client';
import PercyEnvironment from 'percy-client/dist/environment';

import packageJSON from '../package.json';
import type FileSystemAssetLoader from './FileSystemAssetLoader';

import * as url from 'url';

/*
 * Interface betwen the puppeteer browser and the percy API.
 */
class Percy {
  client: PercyClient;
  environment: PercyEnvironment;
  buildId: ?string;
  webUrl: ?string;
  loaders: FileSystemAssetLoader[];

  constructor({ loaders }: { loaders: FileSystemAssetLoader[] }) {
    const token = process.env.PERCY_TOKEN;
    const apiUrl = process.env.PERCY_API;
    const clientInfo = `@percy/puppeteer ${packageJSON.version}`;

    this.client = new PercyClient({ token, apiUrl, clientInfo });
    this.environment = new PercyEnvironment(process.env);
    this.loaders = loaders;
  }

  /*
     * Take a screenshot of current browser.
     */
  async snapshot(
    name: string,
    page: puppeteer.Page,
    options: {
      widths?: string[],
      enableJavaScript?: boolean,
      minimumHeight?: number,
    } = {},
  ): Promise<void> {
    if (!this.buildId) {
      return;
    }

    const pageUrl = page.url();
    const path = url.parse(pageUrl).path;

    await this.setBaseIfMissing(page, pageUrl);

    const snapshotContent = await page.content();

    const rootResource = this.client.makeResource({
      resourceUrl: path,
      content: snapshotContent,
      isRoot: true,
      mimetype: 'text/html',
    });

    const snapshotResponse = await this.client.createSnapshot(this.buildId, [rootResource], {
      name,
      widths: options.widths,
      enableJavaScript: options.enableJavaScript,
      minimumHeight: options.minimumHeight,
    });

    const snapshotId = snapshotResponse.body.data.id;
    const shaToResource = {};
    shaToResource[rootResource.sha] = rootResource;

    await this.uploadMissingResources(snapshotResponse, shaToResource);
    await this.client.finalizeSnapshot(snapshotId);
  }

  // If the page doesn't have a base, create one using baseUrl
  async setBaseIfMissing(page: puppeteer.Page, baseUrl: string): Promise<void> {
    const missingBase = await page.evaluate(() => document.querySelector('base') == null);
    if (missingBase) {
      const base = `<base href="${baseUrl}">`;
      await page.evaluate(base => {
        let head = document.querySelector('head');
        head.insertAdjacentHTML('afterbegin', base);
      }, base);
    }
  }

  /*
     * Start a new build.
     */
  async startBuild(): Promise<void> {
    if (this.buildId) {
      throw new Error('There is already an active build, call percy.finalizeBuild() first');
    }

    // List all assets
    const resources = await this.gatherBuildResources();

    // Create the build
    const buildResponse = await this.client.createBuild(this.environment.repo, { resources });
    this.buildId = buildResponse.body.data.id;
    this.webUrl = buildResponse.body.data.attributes['web-url'];

    // Upload the resources that do not exist in Percy
    const shaToResource = {};
    for (const resource of resources) {
      shaToResource[resource.sha] = resource;
    }

    await this.uploadMissingResources(buildResponse, shaToResource);
  }

  /*
     * Commit the build as finalized.
     */
  async finalizeBuild(): Promise<void> {
    if (!this.buildId) {
      throw new Error('No build started, call percy.startBuild() first');
    }

    await this.client.finalizeBuild(this.buildId);

    // eslint-disable-next-line no-console
    console.log(`Percy is now processing. You can view the visual diffs here: ${this.webUrl}`);

    this.buildId = null;
    this.webUrl = null;
  }

  /*
     * List all assets.
     */
  async gatherBuildResources(): Promise<PercyResource[]> {
    const listOfResources = await Promise.all(
      this.loaders.map(loader => loader.findBuildResources(this.client)),
    );

    return [].concat(...listOfResources);
  }

  /*
     * Upload missing resources.
     */
  async uploadMissingResources(
    response: *,
    shaToResource: { [string]: PercyResource },
  ): Promise<void> {
    const missingResources = parseMissingResources(response);
    const promises = [];
    if (missingResources.length > 0) {
      for (const missingResource of missingResources) {
        promises.push(
          this.client.uploadResource(this.buildId, shaToResource[missingResource.id].content),
        );
      }
    }

    await Promise.all(promises);
  }
}

/*
 * Get missing resources from the result of
 * percy.createBuild and percy.createSnapshot.
 */
function parseMissingResources(response) {
  return (
    (response.body.data &&
      response.body.data.relationships &&
      response.body.data.relationships['missing-resources'] &&
      response.body.data.relationships['missing-resources'].data) ||
    []
  );
}

export default Percy;
