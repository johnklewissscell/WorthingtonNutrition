require("dotenv").config();
console.log("Starting server...");
process.on("exit", (code) => {
  console.log("PROCESS EXIT", code);
});

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION", err.message);
  process.exit(1);
});

process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION", err.message);
});

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

// Serve static files from the parent directory (MenuSite root)
app.use(express.static(path.join(__dirname, "..")));

const mappingsPath = path.join(__dirname, "mappings.json");
const offCachePath = path.join(__dirname, "off-cache.json");
let mappings = {};
let offCache = {};

try {
  if (fs.existsSync(mappingsPath))
    mappings = JSON.parse(fs.readFileSync(mappingsPath, "utf8") || "{}");
} catch (e) {
  console.warn("load mappings failed", e.message);
}
try {
  if (fs.existsSync(offCachePath))
    offCache = JSON.parse(fs.readFileSync(offCachePath, "utf8") || "{}");
} catch (e) {
  console.warn("load off cache failed", e.message);
}

function saveMappings() {
  try {
    fs.writeFileSync(mappingsPath, JSON.stringify(mappings, null, 2));
  } catch (e) {
    console.warn("saveMappings failed", e.message);
  }
}

function saveOffCache() {
  try {
    fs.writeFileSync(offCachePath, JSON.stringify(offCache, null, 2));
  } catch (e) {
    console.warn("saveOffCache failed", e.message);
  }
}

let fatSecretToken = null;
let fatSecretTokenExpiry = 0;

async function getFatSecretToken() {
  const now = Date.now();
  if (fatSecretToken && now < fatSecretTokenExpiry) return fatSecretToken;

  const clientId = process.env.FATSECRET_CLIENT_ID;
  const clientSecret = process.env.FATSECRET_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  try {
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const resp = await axios.post(
      "https://oauth.fatsecret.com/connect/token",
      "grant_type=client_credentials&scope=basic barcode",
      {
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      },
    );
    fatSecretToken = resp.data.access_token;
    fatSecretTokenExpiry = now + resp.data.expires_in * 1000 - 60000;
    return fatSecretToken;
  } catch (e) {
    console.warn("FatSecret Token Error:", e.message);
    return null;
  }
}

async function lookupFatSecretNutrition(upc) {
  const token = await getFatSecretToken();
  console.log("TOKEN EXISTS:", !!token);
  if (!token) {
    console.log("NO TOKEN");
    return { found: false };
  }
  try {
    console.log("SEARCHING BARCODE:", upc);
    const findResp = await axios.get(
      "https://platform.fatsecret.com/rest/food/barcode/find-by-id/v2",
      {
        params: {
          barcode: upc,
          format: "json",
          region: "US",
          language: "en",
          flag_default_serving: true,
        },
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );

    console.log("BARCODE RESPONSE:", JSON.stringify(findResp.data, null, 2));
    if (findResp.data?.food) {
      return {
        found: true,
        food: findResp.data.food,
      };
    }

    return { found: false };
    return { found: false };
  } catch (e) {
    console.warn("FatSecret Lookup Error:", e.message);
    return { found: false };
  }
}

async function searchFatSecretNutrition(query) {
  const token = await getFatSecretToken();
  if (!token) return { found: false };
  try {
    const searchResp = await axios.get(
      "https://platform.fatsecret.com/rest/server.api",
      {
        params: {
          method: "foods.search",
          search_expression: query,
          format: "json",
          max_results: 1,
        },
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    const foodId =
      searchResp.data?.foods?.food?.food_id ||
      searchResp.data?.foods?.food?.[0]?.food_id;
    if (!foodId) return { found: false };

    const getResp = await axios.get(
      "https://platform.fatsecret.com/rest/server.api",
      {
        params: { method: "food.get.v2", food_id: foodId, format: "json" },
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    if (getResp.data?.food) {
      const food = getResp.data.food;
      if (food.food_url)
        food.food_url = food.food_url.replace(
          "www.fatsecret.com",
          "foods.fatsecret.com",
        );
      return { found: true, food };
    }
    return { found: false };
  } catch (e) {
    return { found: false };
  }
}

async function lookupOpenFoodFacts(upc) {
  try {
    if (offCache && offCache[upc])
      return {
        found: true,
        source: "OpenFoodFacts",
        data: offCache[upc],
        raw: { fromCache: true },
      };
    const url = `https://world.openfoodfacts.org/api/v0/product/${encodeURIComponent(upc)}.json`;
    const resp = await axios.get(url, { timeout: 7000 });
    const raw = resp.data;
    if (raw && raw.status === 1 && raw.product) {
      offCache[upc] = raw.product;
      saveOffCache();
      return { found: true, source: "OpenFoodFacts", data: raw.product, raw };
    }
    try {
      const sUrl = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(upc)}&search_simple=1&json=1`;
      const sresp = await axios.get(sUrl, { timeout: 7000 });
      const sraw = sresp.data;
      if (sraw && sraw.products && sraw.products.length) {
        offCache[upc] = sraw.products[0];
        saveOffCache();
        return {
          found: true,
          source: "OpenFoodFacts",
          data: sraw.products[0],
          raw: sraw,
        };
      }
    } catch (e) {
      if (e.response && e.response.status === 429) {
        if (offCache && offCache[upc])
          return {
            found: true,
            source: "OpenFoodFacts",
            data: offCache[upc],
            raw: { fromCache: true, rateLimited: true },
          };
        return {
          found: false,
          source: "OpenFoodFacts",
          data: null,
          raw: null,
          error: "rate_limited",
        };
      }
    }
    return { found: false, source: "OpenFoodFacts", data: null, raw };
  } catch (err) {
    console.warn("OpenFoodFacts error", err.message);
    return {
      found: false,
      source: "OpenFoodFacts",
      data: null,
      raw: null,
      error: err.message,
    };
  }
}

async function lookupRetailerImagesServer(upc, name) {
  const terms = Array.from(new Set([upc, name].filter(Boolean)));
  const candidateSearches = [
    `https://www.walmart.com/search/?query=${encodeURIComponent(upc)}`,
    `https://www.target.com/s?searchTerm=${encodeURIComponent(upc)}`,
    `https://www.amazon.com/s?k=${encodeURIComponent(upc)}`,
    `https://www.barcodelookup.com/${encodeURIComponent(upc)}`,
    `https://www.upcitemdb.com/upc/${encodeURIComponent(upc)}`,
    `https://www.google.com/search?tbm=shop&q=${encodeURIComponent(upc)}`,
    ...terms.flatMap((term) => [
      `https://www.walmart.com/search/?query=${encodeURIComponent(term)}`,
      `https://www.target.com/s?searchTerm=${encodeURIComponent(term)}`,
      `https://www.amazon.com/s?k=${encodeURIComponent(term)}`,
      `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(term)}`,
    ]),
  ];
  const images = [];
  for (const url of candidateSearches) {
    try {
      const r = await axios.get(url, {
        headers: {
          "Accept-Language": "en-US,en;q=0.9",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
        },
        timeout: 7000,
      });
      const html = r.data || "";
      console.log(url);
      console.log(images);
      const m = html.match(
        /<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["'][^>]*>/i,
      );
      if (m && m[1]) images.push(m[1]);
      const m2 = html.match(
        /<link[^>]+rel=["']image_src["'][^>]*href=["']([^"']+)["'][^>]*>/i,
      );
      if (m2 && m2[1]) images.push(m2[1]);
      const jmatch = html.match(
        /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i,
      );
      if (jmatch && jmatch[1]) {
        try {
          const jd = JSON.parse(jmatch[1]);
          if (jd && jd.image) {
            if (Array.isArray(jd.image)) images.push(...jd.image);
            else images.push(jd.image);
          }
        } catch (e) {}
      }
      const dynamicImages = html.matchAll(
        /data-a-dynamic-image=["']({[^"']+})["']/gi,
      );
      for (const match of dynamicImages) {
        const decoded = match[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&");
        try {
          images.push(...Object.keys(JSON.parse(decoded)));
        } catch (e) {}
      }
      const imageUrls = html.matchAll(
        /https?:\/\/[^"'\\\s>]+?\.(?:jpg|jpeg|png|webp)(?:\?[^"'\\\s>]*)?/gi,
      );
      for (const match of imageUrls) {
        images.push(match[0]);
      }
    } catch (e) {}
    if (images.length) break;
  }
  return Array.from(new Set(images))
    .filter(Boolean)
    .filter((src) => !/sprite|logo|favicon|transparent|pixel/i.test(src))
    .slice(0, 8);
}

async function lookupUPCItemDB(upc) {
  try {
    const resp = await axios.get(
      `https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(upc)}`,
      { timeout: 7000 },
    );
    const raw = resp.data;
    if (raw && raw.items && raw.items.length)
      return { found: true, source: "UPCItemDB", data: raw.items[0], raw };
    return { found: false, source: "UPCItemDB", data: null, raw };
  } catch (e) {
    console.warn("UPCItemDB error", e.message);
    return {
      found: false,
      source: "UPCItemDB",
      data: null,
      raw: null,
      error: e.message,
    };
  }
}

function getNutrientValue(nutrients, nutrientIds, namePattern) {
  const list = Array.isArray(nutrients) ? nutrients : [];
  const match = list.find((item) => {
    const nutrient = item.nutrient || item;
    const id = nutrient.number || nutrient.id || item.nutrientId;
    const name = nutrient.name || item.nutrientName || "";
    return nutrientIds.includes(String(id)) || namePattern.test(name);
  });

  return Math.round(Number(match?.amount || match?.value || 0));
}

function convertUSDANutrition(food) {
  const nutrients = food.foodNutrients || [];
  const servingSize = food.servingSize || food.householdServingFullText || "";
  const servingUnit = food.servingSizeUnit || "";
  const servingDescription =
    food.householdServingFullText ||
    (servingSize
      ? `${servingSize}${servingUnit ? " " + servingUnit : ""}`
      : "per serving");

  return {
    food_id: food.fdcId ? `usda-${food.fdcId}` : "usda-" + Date.now(),
    food_name: food.description || food.lowercaseDescription || "USDA Food",
    food_type: food.dataType || "USDA",
    brand_name: food.brandOwner || food.brandName || "",
    servings: {
      serving: [
        {
          serving_description: servingDescription,
          calories: getNutrientValue(
            nutrients,
            ["1008", "2047", "2048"],
            /energy|calorie/i,
          ),
          fat: getNutrientValue(nutrients, ["1004"], /\bfat\b|total lipid/i),
          saturated_fat: getNutrientValue(nutrients, ["1258"], /saturated/i),
          carbohydrate: getNutrientValue(nutrients, ["1005"], /carbohydrate/i),
          sugar: getNutrientValue(nutrients, ["2000", "1063"], /sugar/i),
          protein: getNutrientValue(nutrients, ["1003"], /protein/i),
          sodium: getNutrientValue(nutrients, ["1093"], /sodium/i),
          fiber: getNutrientValue(nutrients, ["1079"], /fiber/i),
        },
      ],
    },
  };
}

async function lookupUSDANutrition(query) {
  if (!query) return { found: false };

  try {
    const apiKey = process.env.USDA_API_KEY || "DEMO_KEY";
    const params = new URLSearchParams({
      api_key: apiKey,
      query,
      pageSize: "5",
    });
    params.append("dataType", "Branded");
    params.append("dataType", "Foundation");
    params.append("dataType", "SR Legacy");

    const resp = await axios.get(
      `https://api.nal.usda.gov/fdc/v1/foods/search?${params.toString()}`,
      { timeout: 8000 },
    );
    const foods = resp.data && resp.data.foods;
    const first =
      Array.isArray(foods) && foods.find((food) => food.foodNutrients?.length);
    if (!first) return { found: false, raw: resp.data };

    return {
      found: true,
      food: convertUSDANutrition(first),
      foodUrl: first.fdcId
        ? `https://fdc.nal.usda.gov/fdc-app.html#/food-details/${first.fdcId}/nutrients`
        : null,
      raw: first,
    };
  } catch (e) {
    console.warn("USDA nutrition error", e.message);
    return { found: false, error: e.message };
  }
}

app.get("/product", async (req, res) => {
  try {
    const upc = (req.query.upc || "").trim();
    const debug = req.query.debug === "1" || req.query.debug === "true";
    if (!upc) return res.status(400).json({ error: "Missing UPC" });
    const attempts = [];
    let final = {};

    try {
      if (fs.existsSync(mappingsPath))
        mappings = JSON.parse(fs.readFileSync(mappingsPath, "utf8") || "{}");
    } catch (e) {}

    const variants = Array.from(
      new Set(
        [
          upc,
          upc.replace(/^0+/, ""),
          upc.slice(-12),
          "0" + upc,
          "00" + upc,
          upc.length > 1 ? upc.slice(1) : upc,
        ].filter(Boolean),
      ),
    );
    let manual = null;
    let matched = null;
    for (const v of variants) {
      if (mappings[v]) {
        manual = mappings[v];
        matched = v;
        break;
      }
    }
    const hasManual =
      manual && manual.data && Object.keys(manual.data).length > 0;
    if (hasManual) {
      attempts.push({
        source: "manual",
        found: true,
        data: manual.data,
        matched,
      });
      final = { ...manual.data };
    }

    // FatSecret product metadata
    for (const v of variants) {
      const fsRes = await lookupFatSecretNutrition(v);

      if (fsRes.found && fsRes.food) {
        final.product_name = final.product_name || fsRes.food.food_name || "";

        final.brands = final.brands || fsRes.food.brand_name || "";

        break;
      }
    }

    // Walmart image lookup
    if (!final.images || final.images.length === 0) {
      for (const v of variants) {
        const imgs = await lookupRetailerImagesServer(
          v,
          final.product_name || "",
        );

        attempts.push({
          variant: v,
          source: "walmart",
          images: imgs,
        });

        if (imgs && imgs.length) {
          final.images = imgs;
          break;
        }
      }
    }

    const productFound = final.product_name || (final.images && final.images.length);

    if (debug) {
      return res.json({
        found: !!productFound,
        attempts,
        final,
      });
    }

    if (!productFound) {
      return res.json({ found: false });
    }

    return res.json({
      found: true,
      source: "FatSecret + Walmart",
      product: final,
    });

    const found = final.product_name || (final.images && final.images.length);
    if (debug) return res.json({ found: !!found, attempts, final });
    if (!found) return res.json({ found: false });
    return res.json({
      found: true,
      source: hasManual ? "manual+off" : "off",
      product: final,
    });
  } catch (e) {
    console.error("product error", e.message);
    return res.status(500).json({ error: "Server error" });
  }
});

// Convert Open Food Facts nutrition data to the popup's nutrition format.
function convertOFFNutrition(product, searchTerm = "") {
  if (!product) return createGenericNutrition(searchTerm);
  try {
    const nutriments = product.nutriments || {};
    const serving = {
      serving_description: product.serving_size
        ? `${product.serving_size}${product.serving_size_unit || ""}`
        : "per 100g",
      calories: Math.round(
        product.energy_kcal || nutriments["energy-kcal"] || 0,
      ),
      fat: Math.round(nutriments.fat || 0),
      saturated_fat: Math.round(nutriments["saturated-fat"] || 0),
      carbohydrate: Math.round(nutriments.carbohydrates || 0),
      sugar: Math.round(nutriments.sugars || 0),
      protein: Math.round(nutriments.proteins || 0),
      sodium: Math.round((nutriments.sodium || 0) * 1000), // convert g to mg
      fiber: Math.round(nutriments.fiber || 0),
    };
    const result = {
      food_id: product.code || "off-" + Date.now(),
      food_name: product.product_name || searchTerm || "Unknown Product",
      food_type: "user food",
      brand_name: product.brands || "",
      servings: {
        serving: [serving],
      },
    };
    console.log(
      "Converted OFF product:",
      result.food_name,
      "calories:",
      serving.calories,
    );
    return result;
  } catch (e) {
    console.error("Error converting Open Food Facts nutrition:", e.message);
    return createGenericNutrition(searchTerm);
  }
}

// Fallback generic nutrition when no data available
function createGenericNutrition(productName = "Product") {
  return {
    food_id: "generic-" + Date.now(),
    food_name: productName || "Unknown Product",
    food_type: "generic food",
    brand_name: "",
    servings: {
      serving: [
        {
          serving_description: "per serving",
          calories: 0,
          fat: 0,
          saturated_fat: 0,
          carbohydrate: 0,
          sugar: 0,
          protein: 0,
          sodium: 0,
          fiber: 0,
        },
      ],
    },
  };
}

app.get("/nutrition", async (req, res) => {
  const upc = (req.query.upc || req.query.barcode || "").trim();
  const name = (req.query.name || "").trim();
  const brand = (req.query.brand || "").trim();
  const searchTerm = `${brand} ${name}`.trim();

  try {
    if (upc) {
      const variants = Array.from(
        new Set(
          [
            upc,
            upc.replace(/^0+/, ""),
            upc.slice(-12),
            upc.padStart(12, "0"),
            upc.padStart(13, "0"),
            upc.padStart(14, "0"),
          ].filter(Boolean),
        ),
      );

      for (const v of variants) {
        try {
          const fsResult = await lookupFatSecretNutrition(v);
          if (fsResult?.found && fsResult?.food && fsResult.food.servings) {
            return res.json({
              found: true,
              food: fsResult.food,
              foodUrl: fsResult.food.food_url,
              source: "FatSecret Barcode API",
            });
          }
        } catch (e) {}
      }
    }

    if (searchTerm) {
      const fsSearch = await searchFatSecretNutrition(searchTerm);
      if (fsSearch?.found && fsSearch?.food) {
        return res.json({
          found: true,
          food: fsSearch.food,
          foodUrl:
            fsSearch.food.food_url ||
            `https://foods.fatsecret.com/calories-nutrition/search?q=${encodeURIComponent(searchTerm)}`,
          source: "FatSecret (Search)",
        });
      }
    }

    return res.json({
      found: true,
      food: createGenericNutrition(searchTerm || upc || "Product"),
      foodUrl: `https://foods.fatsecret.com/calories-nutrition/search?q=${encodeURIComponent(searchTerm || upc || "Product")}`,
      source: "FatSecret Fallback Search",
    });
  } catch (e) {
    console.error("Critical nutrition endpoint error:", e.message); // Log critical errors
    return res.json({
      found: true,
      food: createGenericNutrition(searchTerm || upc || "Product"),
      foodUrl: `https://foods.fatsecret.com/calories-nutrition/search?q=${encodeURIComponent(searchTerm || upc || "Product")}`,
      source: "FatSecret Error Fallback Search",
    });
  }
});

app.get("/mappings", (req, res) => {
  try {
    if (fs.existsSync(mappingsPath)) {
      const raw = fs.readFileSync(mappingsPath, "utf8");
      const current = raw ? JSON.parse(raw) : {};
      return res.json(current);
    }
  } catch (e) {
    console.warn("Failed to read mappings.json", e.message);
  }
  return res.json({});
});

app.post("/mappings", (req, res) => {
  const { upc, source, data } = req.body || {};
  if (!upc || !data)
    return res.status(400).json({ error: "Missing upc or data" });
  try {
    if (fs.existsSync(mappingsPath)) {
      const raw = fs.readFileSync(mappingsPath, "utf8");
      mappings = raw ? JSON.parse(raw) : {};
    }
  } catch (e) {
    console.warn("read mappings failed", e.message);
  }
  mappings[upc] = { source: source || "manual", data };
  saveMappings();
  return res.json({ ok: true, mapping: mappings[upc] });
});

app.delete("/mappings", (req, res) => {
  const upc = req.query.upc || (req.body && req.body.upc);
  if (!upc) return res.status(400).json({ error: "Missing upc" });
  try {
    if (fs.existsSync(mappingsPath)) {
      const raw = fs.readFileSync(mappingsPath, "utf8");
      mappings = raw ? JSON.parse(raw) : {};
    }
  } catch (e) {}
  if (!mappings[upc]) return res.status(404).json({ error: "Not found" });
  delete mappings[upc];
  saveMappings();
  return res.json({ ok: true });
});

let PORT = process.env.PORT || 3000;
let listeningFlag = false;
let server = null;

function startServer(port) {
  server = app.listen(port, () => {
    listeningFlag = true;
    console.log("Server running on port", port);
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.log(`Port ${port} is in use, trying ${port + 1}...`);
      server.close();
      startServer(port + 1);
    } else {
      console.error("SERVER ERROR:", err.message);
      process.exit(1);
    }
  });
}

startServer(PORT);

// Keep server alive
process.on("SIGTERM", () => {
  console.log("SIGTERM received, closing server");
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  console.log("SIGINT received, closing server");
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});

if (!process.env.DEBUG_NO_KEEPALIVE) {
  setInterval(() => {
    if (!listeningFlag && Date.now() % 10000 === 0) {
      console.log("[watchdog] Server listening:", listeningFlag);
    }
  }, 10000);
}
