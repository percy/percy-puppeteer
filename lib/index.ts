import { clientInfo } from './environment'
import { agentJsFilename } from '@percy/agent'
import { Page } from 'puppeteer'

declare var PercyAgent: any;

/**
 * A function to take a Percy snapshot from a Puppeteer test or script. To use in your tests:
 *   const { percySnapshot } = require('@percy/puppeteer')
 *
 *   const browser = await puppeteer.launch()
 *   const page = await browser.newPage()
 *   await page.goto(<your.test.url>)
 *   await percySnapshot(page, <your snapshot name>, <maybe options>)
 *
 * @param page Puppeteer Page object that we are snapshotting. Required.
 * @param name Name of the snapshot that we're taking. Required.
 * @param options Additional options, e.g. '{widths: [768, 992, 1200]}'. Optional.
 */
export async function percySnapshot(page: Page, name: string, options: any = {}) {
  if (!page) {
    throw new Error("Puppeteer 'page' object must be provided.")
  }
  if (!name) {
    throw new Error("'name' must be provided. In Mocha, this.test.fullTitle() is a good default.")
  }
  await page.addScriptTag({
    path: agentJsFilename()
  })
  await page.evaluate(function(name: string, options: any, clientInfo: string) {
    const percyAgentClient = new PercyAgent({ clientInfo })
    percyAgentClient.snapshot(name, options)
  }, name, options, clientInfo())
}
