/* @flow */
import PercyClient from 'percy-client';
import PercyEnvironment from 'percy-client/dist/environment';

import packageJSON from '../package.json';
import type FileSystemAssetLoader from './FileSystemAssetLoader';

/*
 * Interface betwen the puppeteer browser and the percy API.
 */
class PuppeteerPercy {
    client: PercyClient;
    environment: PercyEnvironment;
    buildId: ?string;
    loaders: FileSystemAssetLoader[];

    constructor({ loaders }: { loaders: FileSystemAssetLoader[] }) {
        const token = process.env.PERCY_TOKEN;
        const apiUrl = process.env.PERCY_API;
        const clientInfo = `percy-puppeteer ${packageJSON.version}`;

        this.client = new PercyClient({ token, apiUrl, clientInfo });
        this.environment = new PercyEnvironment(process.env);
        this.loaders = loaders;
    }

    /*
     * Take a screenshot of current browser.
     */
    async takeScreenshot(
        name: string,
        page: puppeteer.Page,
        options: {
            widths?: string[],
            enableJavaScript?: boolean,
            minimumHeight?: number
        } = {}
    ): Promise<void> {
        if (!this.buildId) {
            return;
        }

        const source = await page.content();

        const rootResource = this.client.makeResource({
            resourceUrl: page.url(),
            content: source,
            isRoot: true,
            mimetype: 'text/html'
        });

        const snapshotResponse = await this.client.createSnapshot(
            this.buildId,
            [rootResource],
            {
                name,
                widths: options.widths,
                enableJavaScript: options.enableJavaScript,
                minimumHeight: options.minimumHeight
            }
        );

        const snapshotId = snapshotResponse.body.data.id;
        const shaToResource = {};
        shaToResource[rootResource.sha] = rootResource;

        await this.uploadMissingResources(snapshotResponse, shaToResource);
        await this.client.finalizeSnapshot(snapshotId);
    }

    /*
     * Start a new build.
     */
    async startBuild(): Promise<void> {
        if (this.buildId) {
            throw new Error(
                'There is already an active build, call puppeteerPercy.finalizeBuild() first'
            );
        }

        // List all assets
        const resources = await this.gatherBuildResources();

        // Create the build
        const buildResponse = await this.client.createBuild(
            this.environment.repo,
            { resources }
        );
        this.buildId = buildResponse.body.data.id;

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
            throw new Error(
                'No build started, call puppeteerPercy.startBuild() first'
            );
        }

        await this.client.finalizeBuild(this.buildId);
        this.buildId = null;
    }

    /*
     * List all assets.
     */
    async gatherBuildResources(): Promise<PercyResource[]> {
        const listOfResources = await Promise.all(
            this.loaders.map(loader => loader.findBuildResources(this.client))
        );

        return [].concat(...listOfResources);
    }

    /*
     * Upload missing resources.
     */
    async uploadMissingResources(
        response: *,
        shaToResource: { [string]: PercyResource }
    ): Promise<void> {
        const missingResources = parseMissingResources(response);
        const promises = [];
        if (missingResources.length > 0) {
            for (const missingResource of missingResources) {
                promises.push(
                    this.client.uploadResource(
                        this.buildId,
                        shaToResource[missingResource.id].content
                    )
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

export default PuppeteerPercy;
