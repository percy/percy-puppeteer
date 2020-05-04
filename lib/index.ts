import { clientInfo } from './environment'
let { agentJsFilename, isAgentRunning, postSnapshot } = require('@percy/agent/dist/utils/sdk-utils')
import { Page } from 'playwright'

declare var PercyAgent: any;

/**
 * A function to take a Percy snapshot from a playwright test or script. To use in your tests:
 *   const { percySnapshot } = require('@percy/playwright')
 *
 *   const browser = await playwright.launch()
 *   const page = await browser.newPage()
 *   await page.goto(<your.test.url>)
 *   await percySnapshot(page, <your snapshot name>, <maybe options>)
 *
 * @param page Playwright Page object that we are snapshotting. Required.
 * @param name Name of the snapshot that we're taking. Required.
 * @param options Additional options, e.g. '{widths: [768, 992, 1200]}'. Optional.
 */
export async function percySnapshot(page: Page, name: string, options: any = {}) {
  if (!page) {
    throw new Error("playwright 'page' object must be provided.")
  }
  if (!name) {
    throw new Error("'name' must be provided. In Mocha, this.test.fullTitle() is a good default.")
  }

  try {
    await page.addScriptTag({
      path: agentJsFilename()
    })
  } catch (err) {
    console.log(`[percy] Could not take snapshot named '${name}', maybe due to stringent CSPs. Try page.setBypassCSP(true).`)
    return
  }

  if (! await isAgentRunning()) {
    return
  }

  const domSnapshot = await page.evaluate(function(opts: {name: string, options: any}) {
    const percyAgentClient = new PercyAgent({ handleAgentCommunication: false })
    return percyAgentClient.snapshot(opts.name, opts.options)
  }, {name, options})

  await postDomSnapshot(name, domSnapshot, page.url(), options)
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
    console.log(`[percy] Error posting snapshot to agent.`)
  }
}
