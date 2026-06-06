// Browser driver for run-vip-re-os. Launches headless Chromium and screenshots a
// URL. Uses @sparticuz/chromium because its browser binary ships INSIDE the npm
// package — the agent sandbox's egress allowlist blocks cdn.playwright.dev and
// apt, but npm is allowed, so this is the only Chromium that installs here.
//
// Setup (once):  npm i @sparticuz/chromium puppeteer-core
// Run:           node .claude/skills/run-vip-re-os/browser-shot.cjs <url> <outfile>
//   defaults:    url=http://localhost:3000/login  outfile=/tmp/app-shot.png
//
// Reachability (verified in-sandbox): localhost is NOT proxied and works when the
// dev server is up; *.vercel.app returns the proxy "Host not in allowlist" page.
// ignoreHTTPSErrors is on because the egress proxy does TLS interception with an
// untrusted CA (otherwise: net::ERR_CERT_AUTHORITY_INVALID).
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

const url = process.argv[2] || 'http://localhost:3000/login';
const out = process.argv[3] || '/tmp/app-shot.png';

(async () => {
  const browser = await puppeteer.launch({
    args: [...chromium.args, '--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors'],
    defaultViewport: { width: 1280, height: 900 },
    executablePath: await chromium.executablePath(),
    headless: true,
    acceptInsecureCerts: true,
  });
  try {
    const page = await browser.newPage();
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await new Promise((r) => setTimeout(r, 3000)); // let client-side render settle
    console.log('status:', resp && resp.status());
    console.log('title:', await page.title());
    const clickables = await page.$$eval('button, a', (els) =>
      els.map((e) => e.innerText.trim()).filter(Boolean).slice(0, 20));
    console.log('clickables:', JSON.stringify(clickables));
    await page.screenshot({ path: out, fullPage: true });
    console.log('screenshot:', out);
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error('LAUNCH-ERR:', e.message); process.exit(1); });
