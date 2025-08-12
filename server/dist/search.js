import puppeteer from 'puppeteer';
function extractGoogleResultHref(href) {
    try {
        const url = new URL(href);
        if (url.hostname.endsWith('google.com') && url.pathname === '/url') {
            const real = url.searchParams.get('q');
            return real || null;
        }
        return href;
    }
    catch {
        return null;
    }
}
export async function googleTopLinks(query) {
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    try {
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36');
        await page.setViewport({ width: 1200, height: 900 });
        // Avoid country redirect and consent where possible
        await page.goto('https://www.google.com/ncr', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => { });
        const q = encodeURIComponent(query);
        const searchUrl = `https://www.google.com/search?q=${q}&hl=en&gl=us&num=10&nfpr=1&pws=0`;
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        // Try to accept consent if present
        try {
            const btn = await page.$('form[action*="consent"] button, #L2AGLb, button[aria-label="Accept all"], button:has-text("I agree")');
            if (btn) {
                await btn.click({ delay: 50 }).catch(() => { });
                await new Promise((r) => setTimeout(r, 800));
            }
        }
        catch { }
        // Wait for results area
        await page.waitForSelector('#search a h3', { timeout: 12000 }).catch(() => { });
        const links = await page.$$eval('#search a', (anchors) => {
            const out = [];
            for (const aEl of anchors) {
                const h3 = aEl.querySelector('h3');
                if (!h3)
                    continue;
                const href = aEl.href;
                if (href)
                    out.push(href);
                if (out.length >= 10)
                    break;
            }
            return out;
        });
        const normalized = [];
        for (const href of links) {
            const real = extractGoogleResultHref(href);
            if (real && !normalized.includes(real))
                normalized.push(real);
            if (normalized.length >= 5)
                break;
        }
        return normalized;
    }
    finally {
        await browser.close().catch(() => { });
    }
}
async function ddgTopLinks(query) {
    const q = encodeURIComponent(query);
    const url = `https://html.duckduckgo.com/html/?q=${q}`;
    const res = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9'
        }
    });
    const html = await res.text();
    // Very lightweight extraction: links in results typically have class "result__a"
    const links = [];
    const regex = /<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["']/gi;
    let m;
    while ((m = regex.exec(html)) && links.length < 5) {
        const href = m[1];
        if (href && !links.includes(href))
            links.push(href);
    }
    return links;
}
export async function topLinksWithFallback(query) {
    try {
        return await googleTopLinks(query);
    }
    catch {
        return await ddgTopLinks(query);
    }
}
//# sourceMappingURL=search.js.map