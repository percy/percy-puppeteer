import Axios from 'axios'
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

  if (!isAgentRunning()) {
    return
  }

  const domSnapshot = await page.evaluate(function(name: string, options: any, clientInfo: string) {
    const percyAgentClient = new PercyAgent({ clientInfo, handleAgentCommunication: false })
    return percyAgentClient.snapshot(name, options)
  }, name, options, clientInfo())

  const url = await page.evaluate(() => { return document.URL })
  await postDomSnapshot(name, domSnapshot, url, options)
}

async function isAgentRunning() {
  await Axios({
    method: 'get',
    url: 'http://localhost:5338/percy/healthcheck',
  } as any).then(() => {
    return true
  }).catch((error) => {
    return false
  })
}

async function postDomSnapshot(name: string, domSnapshot: any, url: string, options: any) {
  await Axios({
    method: 'post',
    url: 'http://localhost:5338/percy/snapshot',
    data: {
        name,
        url,
        enableJavaScript: options.enableJavaScript,
        widths: options.widths,
        minHeight: options.minHeight,
        clientInfo: clientInfo(),
        domSnapshot,
      }
  } as any).catch((error) => {
    console.log(`[percy] Error posting snapshot: ${error}`)
  })
}
