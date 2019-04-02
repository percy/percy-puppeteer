const should = require('chai').should()
const puppeteer = require('puppeteer')
const httpServer = require('http-server')
const { percySnapshot } = require('../dist')

describe('@percy/puppeteer SDK', function() {
  const PORT = 8000
  const TEST_URL = `http://localhost:${PORT}`

  let server = null
  let browser = null
  let page = null

  before(async function() {
    // Start local server to host app under test.
    server = httpServer.createServer({ root: `${__dirname}/testapp` })
    server.listen(PORT)

    // Create a new Puppeteer browser instance.
    browser = await puppeteer.launch({
      headless: true,
      timeout: 10000,
      ignoreHTTPSErrors: true,
      args: [
        '--disable-gpu',
        '--no-sandbox',
        // This option is helpful in low-memory environments, but does not work on Windows.
        // '--single-process'
        '--disable-dev-profile',
      ],
    })
    page = await browser.newPage()
  })

  after(async function() {
    // Close the Puppeteer session.
    browser.close()

    // Shut down the HTTP server.
    server.close()
  })

  describe('with local app', async function() {
    beforeEach(async function() {
      await page.goto(TEST_URL)
    })

    afterEach(async function() {
      // Clear local storage to start always with a clean slate.
      await page.evaluate(() => localStorage.clear())
    })

    it('snapshots with provided name', async function() {
      await percySnapshot(page, this.test.fullTitle())
    })

    it('snapshots with provided name and widths', async function() {
      await percySnapshot(page, this.test.fullTitle(), {
        widths: [768, 992, 1200],
      })
    })

    it('snapshots with minHeight', async function() {
      await percySnapshot(page, this.test.fullTitle(), { minHeight: 2000 })
    })

    it('takes multiple snapshots in one test', async function() {
      // Add a todo.
      await page.type('.new-todo', 'A thing to accomplish')
      await page.keyboard.press('Enter')
      let itemsLeft = await page.evaluate(
        () => document.querySelector('.todo-count').textContent
      )
      itemsLeft.should.eq('1 item left')
      await percySnapshot(page, `${this.test.fullTitle()} #1`)

      await page.click('input.toggle')
      itemsLeft = await page.evaluate(
        () => document.querySelector('.todo-count').textContent
      )
      itemsLeft.should.eq('0 items left')
      await percySnapshot(page, `${this.test.fullTitle()} #2`)
    })
  })

  describe('with large dom', async function() {
    it('snapshots without error', async function() {
      await page.goto(`${TEST_URL}/very-large-dom.html`)
      await percySnapshot(page, this.test.fullTitle())
    })
  })

  describe('with live sites', async function() {
    it('snapshots HTTPS website', async function() {
      await page.goto('https://polaris.shopify.com/')
      await percySnapshot(page, this.test.fullTitle(), {
        widths: [768, 992, 1200],
      })
    })

    it('snapshots website with strict CSP', async function() {
      await page.setBypassCSP(true)
      await page.goto('https://buildkite.com/')
      await percySnapshot(page, this.test.fullTitle(), {
        widths: [768, 992, 1200],
      })
      await page.setBypassCSP(false)
    })

    // The CSP on Github as of 2/4/2019 is strict enough that we can't inject
    // our JS into the page, making snapshotting not possible. Customers running
    // into this problem can work around it by calling page.setBypassCSP(true) before
    // navigating to the site to snapshot.
    it('handles gracefully site that forbids script injection', async function() {
      await page.goto('https://github.com/percy/percy-puppeteer')
      await percySnapshot(page, this.test.fullTitle())
    })
  })
})
