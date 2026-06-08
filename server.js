require('dotenv').config();
const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;
const fetch = require('node-fetch');
const USDA_KEY = process.env.USDA_API_KEY || '3Ct6FsnZlKucaYQhWH15HSYAm0OZrT0AznUd433C';

// Allow cross-origin requests for local testing (file:// or other origins)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.use(express.static(path.join(__dirname)));

const mappings = {
  "041196910014": {
    data: {
      product_name: "Sample Product",
      brand_name: "Sample Brand",
      description: "This is a mock product used for local testing.",
      images: ["https://placehold.jp/24/cccccc/ffffff/300x300.png?text=Sample"]
    }
  }
};

app.get('/mappings', (req, res) => {
  res.json(mappings);
});

app.get('/product', (req, res) => {
  const upc = req.query.upc;
  if (upc && mappings[upc]) {
    return res.json({ found: true, product: mappings[upc].data });
  }
  res.json({ found: false });
});

app.get('/nutrition', async (req, res) => {
  const upc = req.query.upc;

  // Simple mock response used as a fallback.
  const sampleFood = {
    brand_name: "Sample Brand",
    food_name: "Sample Product",
    servings: {
      serving: {
        serving_description: "1 package (100g)",
        calories: 250,
        fat: 10,
        saturated_fat: 2,
        carbohydrate: 30,
        sugar: 12,
        protein: 5,
        sodium: 200
      }
    },
    food_url: "https://fdc.nal.usda.gov/fdc-app.html#/food-details/1102657/nutrients"
  };

  if (upc && mappings[upc]) {
    return res.json({ found: true, food: sampleFood, foodUrl: sampleFood.food_url, source: 'mock' });
  }

  const nameToSearch = (req.query.name || '').trim();

  if (USDA_KEY && nameToSearch) {
    try {
      const q = encodeURIComponent(nameToSearch);
      const url = `https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${USDA_KEY}&query=${q}&pageSize=1`;
      const r = await fetch(url);
      const data = await r.json();

      if (data && Array.isArray(data.foods) && data.foods.length > 0) {
        const f = data.foods[0];
        const normalized = {
          brand_name: f.brandOwner || f.brandName || '',
          food_name: f.description || f.foodName || nameToSearch,
          servings: f.servingSize ? { serving: { serving_description: `${f.servingSize} ${f.servingSizeUnit || ''}` } } : {},
          food_url: `https://fdc.nal.usda.gov/fdc-app.html#/food-details/${f.fdcId}/nutrients`,
          usda_raw: f
        };

        return res.json({ found: true, food: normalized, foodUrl: normalized.food_url, source: 'usda' });
      }
    } catch (err) {
      console.error('USDA lookup failed:', err && err.message ? err.message : err);
    }
  }

  // simple sample fallback if name contained 'sample'
  const name = (req.query.name || '').toLowerCase();
  if (name && name.includes('sample')) {
    return res.json({ found: true, food: sampleFood, foodUrl: sampleFood.food_url, source: 'mock' });
  }

  res.json({ found: false });
});

app.listen(PORT, () => {
  console.log(`Mock server running on http://localhost:${PORT}`);
});
