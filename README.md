# MenuSite — Product Nutrition & Mapping

This workspace provides a small static frontend and a lightweight Node/Express lookup server to retrieve product metadata (OpenFoodFacts) and nutrition (FatSecret). It also includes an in-page overlay UI for adding/deleting UPC mappings and inserting products into the page.

**Repository layout**
- [index.html](index.html) — static frontend shell that loads `index.js` and injects the overlay.
- [index.js](index.js) — frontend renderer: loads mappings and displays product cards; calls `/product` and `/nutrition` on the server.
- [styles.css](styles.css) — basic styles for the page and popup UI.
- [extension-overlay.js](extension-overlay.js) — in-page overlay for managing mappings, scanning barcodes, and inserting products into the page. Prefers server lookups and falls back to OpenFoodFacts/page-scrape when server is unavailable.
- [fatsecret-server/server.js](fatsecret-server/server.js) — Express server exposing `/product`, `/nutrition`, `/mappings` endpoints and a small retailer-scrape helper to find images.
- [fatsecret-server/mappings.json] — persisted manual mappings (created at runtime).
- [fatsecret-server/package.json] — server dependencies and start script.

**High-level flow**
- The overlay and `index.js` request product metadata from the server at `/product?upc=...`.
- The server attempts a cascade: OpenFoodFacts metadata (preferred), retailer/manufacturer page scraping for images, and FatSecret lookup for nutrition where applicable.
- Nutrition is sourced from FatSecret via the server `/nutrition?name=...&brand=...` endpoint which uses FatSecret OAuth and the `foods.search` and `food.get.v3` methods.
- If the server is unavailable, the overlay falls back to client-side OpenFoodFacts API requests and page-scraping via AllOrigins proxy.

**Endpoints**
- **GET** `/product?upc=<UPC>&debug=1` — Returns `{ found, source, product }` when found. Product object includes `product_name`, `brands`, `ingredients_text`, and `images` (array or single string depending on source). With `debug=1` the server returns `attempts` and `final` debug structure.
- **GET** `/nutrition?name=<name>&brand=<brand>&upc=<upc>` — Returns FatSecret nutrition details when matched; response `{ found, food }`.
- **GET** `/mappings` — Returns saved manual mappings from `mappings.json`.
- **POST** `/mappings` — Body `{ upc, data }` to save manual mapping.
- **DELETE** `/mappings?upc=<UPC>` — Delete mapping.

**Why OpenFoodFacts + retailer images?**
- OpenFoodFacts (OFF) is used for public metadata: product name, brands, ingredients and low-res images when available.
- Retailer/manufacturer pages are scraped server-side (og:image, image_src, JSON-LD) to get higher-quality product shots (Walmart, Target, Kroger, Instacart, Google Shopping, etc.). The server attempts multiple sources and returns deduplicated images.
- FatSecret remains the authoritative nutrition source and is fetched server-side to avoid exposing credentials in the client.

**Client-side behavior**
- The static page loads mappings (server first, then localStorage). For each mapping it calls `/product?upc=...` and normalizes the returned `product` into the card used by `index.js`.
- The overlay (`extension-overlay.js`) provides: Add, Fetch, Remove, Scan, and Manual Assistant (upload image / enter name). It saves mappings server-side if reachable, otherwise to localStorage.
- The overlay now prefers server `/product` for lookups; if server is unreachable it uses OpenFoodFacts client API and page-scrape fallback.

**How to run the server (local dev)**
1. Install dependencies in the server folder:
```bash
cd fatsecret-server
npm install
```
2. Create a `.env` file in `fatsecret-server` with your FatSecret credentials:
```
FATSECRET_CLIENT_ID=your_client_id
FATSECRET_CLIENT_SECRET=your_client_secret
PORT=3000
```
3. Start the server:
```bash
node server.js
# or if package.json includes a start script
npm start
```
4. Open the static site (serve from any static host), e.g. with VS Code Live Server or `npx serve` from the repo root, then load `index.html` (e.g. http://127.0.0.1:5500).

**Quick tests**
- Debug a product lookup from server:
```bash
# replace UPC with the code you want to test
curl "http://localhost:3000/product?upc=041196910014&debug=1"
```
- Check nutrition lookup:
```bash
curl "http://localhost:3000/nutrition?upc=041196910014&debug=1"
```

**Notes & troubleshooting**
- CORS: the server enables CORS for client requests on common dev hosts. If you host the static page on a different origin, ensure CORS rules are acceptable.
- AllOrigins proxy is used as a fallback for client-side scraping; it is a public proxy and can be rate-limited.
- UPCItemDB trial API is unreliable; this codebase now treats UPCItemDB as optional and prefers OFF + retailer scraping.
- If nutrition lookups fail, verify `.env` FatSecret credentials and that your server has outbound internet access.

**Files to inspect first when debugging**
- [fatsecret-server/server.js](fatsecret-server/server.js)
- [extension-overlay.js](extension-overlay.js)
- [index.js](index.js)

---
README written on May 27, 2026.
