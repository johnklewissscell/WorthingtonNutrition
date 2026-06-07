const fetch = require('node-fetch');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

function ua() {
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
}

async function fetchPage(url) {
  const res = await fetch(url, { headers: { 'User-Agent': ua() } });
  if (!res.ok) throw new Error('Fetch failed: ' + res.status);
  return await res.text();
}

async function findFirstAsinFromSearch(query) {
  const url = `https://www.amazon.com/s?k=${encodeURIComponent(query)}`;
  const html = await fetchPage(url);
  const $ = cheerio.load(html);
  // Amazon renders results with data-asin attributes on result containers
  const el = $('div[data-asin]').filter((i, el) => $(el).attr('data-asin')).first();
  const asin = el.attr('data-asin');
  return asin || null;
}

async function scrapeProductPageForImage(url) {
  const html = await fetchPage(url);
  const $ = cheerio.load(html);

  // Try meta og:image
  const og = $('meta[property="og:image"]').attr('content');
  if (og) return og;

  // Try landing image data-a-dynamic-image JSON
  const imgTag = $('#imgTagWrapperId img#landingImage');
  const dyn = imgTag.attr('data-a-dynamic-image');
  if (dyn) {
    try {
      const obj = JSON.parse(dyn);
      // object keys are URLs with widths
      const urls = Object.keys(obj || {});
      if (urls.length) return urls[0];
    } catch (e) {}
  }

  // Fallback to any large imgs on page
  const other = $('img').map((i, el) => $(el).attr('src')).get().filter(Boolean);
  return other.length ? other[0] : null;
}

async function downloadImage(url, destPath) {
  const res = await fetch(url, { headers: { 'User-Agent': ua() } });
  if (!res.ok) throw new Error('Image fetch failed: ' + res.status);
  const buffer = await res.buffer();
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, buffer);
}

async function run() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    console.log('Usage: node amazon.js --asin <ASIN> | --query "search terms"');
    process.exit(1);
  }

  let asin = null;
  let query = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--asin' && argv[i+1]) { asin = argv[i+1]; i++; }
    else if (argv[i] === '--query' && argv[i+1]) { query = argv[i+1]; i++; }
  }

  try {
    if (!asin && query) {
      asin = await findFirstAsinFromSearch(query);
      if (!asin) throw new Error('Could not find ASIN from search');
      console.log('Found ASIN:', asin);
    }

    if (!asin) throw new Error('ASIN is required');

    const prodUrl = `https://www.amazon.com/dp/${asin}`;
    console.log('Fetching product page:', prodUrl);
    const imgUrl = await scrapeProductPageForImage(prodUrl);
    if (!imgUrl) {
      console.log('No image found on Amazon page.');
      process.exit(2);
    }

    console.log('Image URL:', imgUrl);
    const out = path.join(__dirname, '..', 'images', `${asin}.jpg`);
    await downloadImage(imgUrl, out);
    console.log('Saved to', out);
  } catch (err) {
    console.error('Error:', err && err.message ? err.message : err);
    process.exit(3);
  }
}

if (require.main === module) run();

module.exports = { findFirstAsinFromSearch, scrapeProductPageForImage };
