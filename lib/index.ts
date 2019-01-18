import { clientInfo } from './environment'
import { agentJsFilename, isAgentRunning, postSnapshot } from '@percy/agent'
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

  if (! await isAgentRunning()) {
    return
  }

  const domSnapshot = await page.evaluate(function(name: string, options: any, clientInfo: string) {
    const percyAgentClient = new PercyAgent({ clientInfo, handleAgentCommunication: false })
    return percyAgentClient.snapshot(name, options)
  }, name, options, clientInfo())

  const url = await page.evaluate(() => { return document.URL })
  await postDomSnapshot(name, domSnapshot, url, options)
}

async function postDomSnapshot(name: string, domSnapshot: any, url: string, options: any) {
  const postSuccess = await postSnapshot({
    name,
    url,
    domSnapshot,
    clientInfo: clientInfo(),
    ...options
  })
  if (!postSuccess) {
    console.log(`[percy] Error posting snapshot to agent`)
  }
}
