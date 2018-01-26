/* @flow */
import walk from 'walk';
import path from 'path';
import fs from 'fs';
import mime from 'mime-types';
import type PercyClient from 'percy-client';

const MAX_FILE_SIZE_BYTES = 15728640;
const DEFAULT_SKIPPED_ASSETS = [];

/*
 * Loader for assets that read from the file system.
 */
class FileSystemAssetLoader {
    constructor(options: {
        buildDir: string,
        mountPath?: string,
        skippedAssets?: string[]
    }) {
        this.options = options;
        this.options.skippedAssets =
            this.options.skippedAssets || DEFAULT_SKIPPED_ASSETS;
    }

    /*
     * Find all resources for a build.
     */
    async findBuildResources(
        percyClient: PercyClient
    ): Promise<PercyResource[]> {
        const options = this.options;
        const buildDir = options.buildDir;

        let mountPath = `${options.mountPath || ''}`;

        // Only add a / to the mountPath if it doesn't already end in one.
        if (mountPath.slice(-1) != '/') {
            mountPath = `${mountPath}/`;
        }

        const isDirectory = fs.statSync(buildDir).isDirectory();

        if (!isDirectory) {
            throw new Error(`${buildDir} is not a directory`);
        }

        const resources = [];
        let errors;

        walk.walkSync(buildDir, {
            followLinks: true,
            listeners: {
                file: (root, fileStats, next) => {
                    const absolutePath = path.join(root, fileStats.name);
                    let resourceUrl = absolutePath;
                    if (path.sep === '\\') {
                        // Windows: transform filesystem backslashes into forward-slashes for the URL.
                        resourceUrl = resourceUrl.replace(/\\/g, '/');
                    }

                    resourceUrl = resourceUrl.replace(buildDir, '');

                    if (resourceUrl.charAt(0) === '/') {
                        resourceUrl = resourceUrl.substr(1);
                    }

                    for (const assetPattern of options.skippedAssets) {
                        if (resourceUrl.match(assetPattern)) {
                            next();
                            return;
                        }
                    }
                    if (fs.statSync(absolutePath).size > MAX_FILE_SIZE_BYTES) {
                        return;
                    }

                    const content = fs.readFileSync(absolutePath);
                    resources.push(
                        percyClient.makeResource({
                            resourceUrl: encodeURI(
                                `${mountPath}${resourceUrl}`
                            ),
                            content,
                            mimetype: mime.lookup(resourceUrl)
                        })
                    );
                    next();
                },

                errors: (root, fileStats, next) => {
                    errors = fileStats;
                    next();
                }
            }
        });

        if (resources.length === 0 && errors) {
            throw errors;
        }

        return resources;
    }
}

export default FileSystemAssetLoader;
