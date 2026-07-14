require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const cors = require('cors');
const nodemailer = require('nodemailer');
const Database = require('better-sqlite3');

const {
  PORT = 3000,
  SHOPIFY_STORE_DOMAIN,
  SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET,
  SHOPIFY_API_VERSION = '2025-01',
  STOREFRONT_URL = '',
  STORE_LOGO_URL = '',
  DATABASE_PATH = './data/hotspots.db',
  SMTP_HOST = '',
  SMTP_PORT = '587',
  SMTP_USER = '',
  SMTP_PASS = '',
  SMTP_FROM = '',
  NOTIFY_EMAIL = '',
} = process.env;

// ---------------------------------------------------------------------------
// DB
// ---------------------------------------------------------------------------
fs.mkdirSync(path.dirname(DATABASE_PATH), { recursive: true });
const db = new Database(DATABASE_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS vehicles (
    id TEXT PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    image_url TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS hotspots (
    id TEXT PRIMARY KEY,
    vehicle_id TEXT NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
    sort_order INTEGER DEFAULT 0,
    x REAL NOT NULL,
    y REAL NOT NULL,
    label TEXT DEFAULT '',
    desc TEXT DEFAULT '',
    product_id TEXT,
    product_handle TEXT,
    product_title TEXT,
    product_price TEXT,
    product_image TEXT,
    variant_id TEXT
  );
`);

// Safe migration: add taxonomy columns to vehicles if this DB predates them
// (so it doesn't break on an already-deployed volume with existing data).
{
  const cols = db.prepare("PRAGMA table_info(vehicles)").all().map((c) => c.name);
  const addCol = (name, def) => {
    if (!cols.includes(name)) db.exec(`ALTER TABLE vehicles ADD COLUMN ${name} ${def}`);
  };
  addCol('make', 'TEXT');
  addCol('model', 'TEXT');
  addCol('submodel', 'TEXT');
  addCol('year_from', 'INTEGER');
  addCol('year_to', 'INTEGER');
}

// Same for hotspots — add the fields needed for collection/multi-product mode.
{
  const cols = db.prepare("PRAGMA table_info(hotspots)").all().map((c) => c.name);
  const addCol = (name, def) => {
    if (!cols.includes(name)) db.exec(`ALTER TABLE hotspots ADD COLUMN ${name} ${def}`);
  };
  addCol('mode', "TEXT DEFAULT 'single'");
  addCol('collection_id', 'TEXT');
  addCol('collection_handle', 'TEXT');
  addCol('collection_title', 'TEXT');
  addCol('variant_title', 'TEXT');
}

// Curated / collection product lists for a hotspot in 'multi' or 'collection' mode.
db.exec(`
  CREATE TABLE IF NOT EXISTS hotspot_products (
    id TEXT PRIMARY KEY,
    hotspot_id TEXT NOT NULL REFERENCES hotspots(id) ON DELETE CASCADE,
    sort_order INTEGER DEFAULT 0,
    product_id TEXT,
    product_handle TEXT,
    product_title TEXT,
    product_price TEXT,
    product_image TEXT,
    variant_id TEXT
  );
`);
{
  const cols = db.prepare("PRAGMA table_info(hotspot_products)").all().map((c) => c.name);
  if (!cols.includes('variant_title')) {
    db.exec('ALTER TABLE hotspot_products ADD COLUMN variant_title TEXT');
  }
}

// Fetch a vehicle's hotspots with their curated/collection product lists attached.
function getHotspotsForVehicle(vehicleId) {
  const hotspots = db
    .prepare('SELECT * FROM hotspots WHERE vehicle_id = ? ORDER BY sort_order ASC')
    .all(vehicleId);
  const getProducts = db.prepare(
    'SELECT * FROM hotspot_products WHERE hotspot_id = ? ORDER BY sort_order ASC'
  );
  return hotspots.map((h) => ({ ...h, products: getProducts.all(h.id) }));
}

const slugify = (s) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'vehicle';
const newId = () => crypto.randomBytes(8).toString('hex');

// ---------------------------------------------------------------------------
// Shopify Admin API (Client Credentials Grant — same pattern as Frikkie)
// ---------------------------------------------------------------------------
let cachedToken = null;
let cachedTokenExpiry = 0;

async function getShopifyToken() {
  if (cachedToken && Date.now() < cachedTokenExpiry) return cachedToken;
  const res = await fetch(`https://${SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  });
  if (!res.ok) throw new Error('Shopify token exchange failed: ' + (await res.text()));
  const data = await res.json();
  cachedToken = data.access_token;
  // Tokens from this grant last 24h — refresh a little early.
  cachedTokenExpiry = Date.now() + 23 * 60 * 60 * 1000;
  return cachedToken;
}

async function shopifyGraphQL(query, variables = {}) {
  const token = await getShopifyToken();
  const res = await fetch(
    `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query, variables }),
    }
  );
  const json = await res.json();
  if (json.errors) throw new Error('Shopify GraphQL error: ' + JSON.stringify(json.errors));
  return json.data;
}

// Search products by title for the admin hotspot picker.
async function searchShopifyProducts(q) {
  const data = await shopifyGraphQL(
    `query($q: String!) {
      products(first: 12, query: $q) {
        edges {
          node {
            id
            title
            handle
            featuredImage { url }
            variants(first: 25) { edges { node { id title price } } }
          }
        }
      }
    }`,
    { q: q ? `title:*${q}*` : '' }
  );
  return data.products.edges.map(({ node }) => {
    const variants = node.variants.edges.map(({ node: v }) => ({
      variantId: v.id,
      title: v.title,
      price: v.price,
    }));
    return {
      productId: node.id,
      title: node.title,
      handle: node.handle,
      image: node.featuredImage ? node.featuredImage.url : null,
      variantId: variants[0] ? variants[0].variantId : null,
      price: variants[0] ? variants[0].price : null,
      variants,
    };
  });
}

// Look up a single product's variants (used when the admin wants to switch
// which variant a hotspot points at, after already picking a product).
async function getProductVariants(productId) {
  const data = await shopifyGraphQL(
    `query($id: ID!) {
      product(id: $id) {
        variants(first: 100) { edges { node { id title price } } }
      }
    }`,
    { id: productId }
  );
  if (!data.product) return [];
  return data.product.variants.edges.map(({ node: v }) => ({
    variantId: v.id,
    title: v.title,
    price: v.price,
  }));
}

// Look up one specific variant directly — used on refresh so a hotspot
// pointing at a non-default variant gets THAT variant's current price/title,
// not the product's first variant.
async function getVariantDetails(variantId) {
  const data = await shopifyGraphQL(
    `query($id: ID!) {
      productVariant(id: $id) {
        title
        price
        image { url }
        product { title featuredImage { url } }
      }
    }`,
    { id: variantId }
  );
  return data.productVariant;
}

// Search collections by title for the admin hotspot picker.
async function searchShopifyCollections(q) {
  const data = await shopifyGraphQL(
    `query($q: String!) {
      collections(first: 12, query: $q) {
        edges { node { id title handle image { url } } }
      }
    }`,
    { q: q ? `title:*${q}*` : '' }
  );
  return data.collections.edges.map(({ node }) => ({
    collectionId: node.id,
    title: node.title,
    handle: node.handle,
    image: node.image ? node.image.url : null,
  }));
}

// Pull products belonging to a collection, for caching against a hotspot.
async function getCollectionProducts(collectionId, limit = 20) {
  const data = await shopifyGraphQL(
    `query($id: ID!, $first: Int!) {
      collection(id: $id) {
        products(first: $first) {
          edges { node {
            id
            title
            handle
            featuredImage { url }
            variants(first: 1) { edges { node { id title price } } }
          } }
        }
      }
    }`,
    { id: collectionId, first: limit }
  );
  if (!data.collection) return [];
  return data.collection.products.edges.map(({ node }) => ({
    productId: node.id,
    title: node.title,
    handle: node.handle,
    image: node.featuredImage ? node.featuredImage.url : null,
    variantId: node.variants.edges[0] ? node.variants.edges[0].node.id : null,
    variantTitle: node.variants.edges[0] ? node.variants.edges[0].node.title : null,
    price: node.variants.edges[0] ? node.variants.edges[0].node.price : null,
  }));
}

// Upload the vehicle PNG to Shopify Files so it survives Railway redeploys.
// Flow: stagedUploadsCreate -> PUT the bytes to the returned URL -> fileCreate
// -> poll until Shopify finishes processing and hands back a CDN url.
async function uploadImageToShopifyFiles(buffer, filename, mimeType) {
  const staged = await shopifyGraphQL(
    `mutation($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets { url resourceUrl parameters { name value } }
        userErrors { message }
      }
    }`,
    {
      input: [
        {
          resource: 'FILE',
          filename,
          mimeType,
          httpMethod: 'POST',
          fileSize: String(buffer.length),
        },
      ],
    }
  );
  const target = staged.stagedUploadsCreate.stagedTargets[0];
  if (!target) throw new Error('Could not get a staged upload target from Shopify');

  const form = new FormData();
  target.parameters.forEach((p) => form.append(p.name, p.value));
  form.append('file', new Blob([buffer], { type: mimeType }), filename);
  const uploadRes = await fetch(target.url, { method: 'POST', body: form });
  if (!uploadRes.ok) throw new Error('Upload to Shopify staged URL failed');

  const created = await shopifyGraphQL(
    `mutation($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files { id fileStatus preview { image { url } } ... on MediaImage { image { url } } }
        userErrors { message }
      }
    }`,
    { files: [{ originalSource: target.resourceUrl, contentType: 'IMAGE' }] }
  );
  if (created.fileCreate.userErrors.length) {
    throw new Error('fileCreate error: ' + JSON.stringify(created.fileCreate.userErrors));
  }
  const file = created.fileCreate.files[0];

  // Shopify processes the image async — poll briefly for the CDN URL.
  for (let i = 0; i < 10; i++) {
    const direct = file.image?.url || file.preview?.image?.url;
    if (direct) return direct;
    await new Promise((r) => setTimeout(r, 1000));
    const check = await shopifyGraphQL(
      `query($id: ID!) { node(id: $id) { ... on MediaImage { image { url } } } }`,
      { id: file.id }
    );
    const url = check.node?.image?.url;
    if (url) return url;
  }
  throw new Error('Timed out waiting for Shopify to process the uploaded image');
}

// ---------------------------------------------------------------------------
// Email (quote request notifications)
// ---------------------------------------------------------------------------
let mailTransport; // undefined = not yet checked, null = not configured
function getMailTransport() {
  if (mailTransport !== undefined) return mailTransport;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    mailTransport = null;
    return null;
  }
  mailTransport = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 587,
    secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return mailTransport;
}

async function sendQuoteEmail({ vehicleName, customer, items, draftOrder }) {
  const transport = getMailTransport();
  if (!transport || !NOTIFY_EMAIL) {
    console.warn('SMTP not configured (SMTP_HOST/SMTP_USER/SMTP_PASS/NOTIFY_EMAIL) — skipping quote notification email.');
    return;
  }
  const total = items.reduce((sum, i) => sum + (Number(i.price) || 0), 0);
  const itemLines = items
    .map((i) => {
      const variantBit = i.variantTitle && i.variantTitle !== 'Default Title' ? ` — ${i.variantTitle}` : '';
      return `- ${i.title}${variantBit} — R ${Number(i.price || 0).toLocaleString('en-ZA')}`;
    })
    .join('\n');
  const draftLink = draftOrder
    ? `https://${SHOPIFY_STORE_DOMAIN}/admin/draft_orders/${draftOrder.id.split('/').pop()}`
    : null;
  const fullName = `${customer.firstName || ''} ${customer.lastName || ''}`.trim();

  await transport.sendMail({
    from: SMTP_FROM || SMTP_USER,
    to: NOTIFY_EMAIL,
    subject: `Quote request — ${vehicleName || 'Rig Builder'} (${fullName})`,
    text: [
      'New quote request from the Rig Builder widget.',
      '',
      `Vehicle: ${vehicleName || '—'}`,
      `Customer: ${fullName} <${customer.email}> — ${customer.phone || '—'}`,
      customer.company ? `Company: ${customer.company}` : '',
      customer.vat ? `VAT number: ${customer.vat}` : '',
      `Shipping address: ${customer.address || '—'}`,
      '',
      'Items:',
      itemLines,
      '',
      `Total: R ${total.toLocaleString('en-ZA')}`,
      draftLink ? `\nDraft order: ${draftLink}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  });
}

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------
const app = express();
// Every /api/ route here is called cross-origin from whatever Shopify page
// the widget is embedded on, so CORS needs to be open. There's no session/
// cookie auth anywhere in this app (see README), so this doesn't widen what
// a direct API caller could already do — it only affects browser JS running
// on other sites, which could already curl these endpoints directly anyway.
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.get('/api/admin/config', (req, res) => {
  res.json({ logoUrl: STORE_LOGO_URL || null });
});

// ---------------------------------------------------------------------------
// Shopify product search + image upload
// ---------------------------------------------------------------------------
app.get('/api/admin/shopify/search-products', async (req, res) => {
  try {
    const results = await searchShopifyProducts(req.query.q || '');
    res.json(results);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/shopify/search-collections', async (req, res) => {
  try {
    const results = await searchShopifyCollections(req.query.q || '');
    res.json(results);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/shopify/product-variants', async (req, res) => {
  try {
    if (!req.query.id) return res.status(400).json({ error: 'id is required' });
    const results = await getProductVariants(req.query.id);
    res.json(results);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/shopify/collection-products', async (req, res) => {
  try {
    if (!req.query.id) return res.status(400).json({ error: 'id is required' });
    const results = await getCollectionProducts(req.query.id, 20);
    res.json(results);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/upload-image', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const url = await uploadImageToShopifyFiles(
      req.file.buffer,
      req.file.originalname || 'vehicle.png',
      req.file.mimetype || 'image/png'
    );
    res.json({ url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Vehicle + hotspot CRUD
// ---------------------------------------------------------------------------
app.get('/api/admin/vehicles', (req, res) => {
  const vehicles = db.prepare('SELECT * FROM vehicles ORDER BY updated_at DESC').all();
  const withHotspots = vehicles.map((v) => ({
    ...v,
    hotspots: getHotspotsForVehicle(v.id),
  }));
  res.json(withHotspots);
});

app.get('/api/admin/vehicles/:id', (req, res) => {
  const v = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(req.params.id);
  if (!v) return res.status(404).json({ error: 'Not found' });
  v.hotspots = getHotspotsForVehicle(v.id);
  res.json(v);
});

// Create or update a vehicle + its full hotspot list in one call.
// Body: { id?, name, imageUrl, make, model, submodel, yearFrom, yearTo,
//         hotspots: [{x,y,label,desc,mode,
//           productId,productHandle,productTitle,productPrice,productImage,variantId,   // mode:'single'
//           collectionId,collectionHandle,collectionTitle,                              // mode:'collection'
//           products:[{productId,handle,title,price,image,variantId}]}] }               // mode:'collection'|'multi'
app.post('/api/admin/vehicles', (req, res) => {
  const {
    id, name, imageUrl, hotspots = [],
    make = '', model = '', submodel = '', yearFrom = null, yearTo = null,
  } = req.body || {};
  if (!name || !imageUrl) return res.status(400).json({ error: 'name and imageUrl are required' });

  const vehicleId = id || newId();
  const baseSlug = slugify(name);
  let slug = baseSlug;
  const slugTaken = (s) =>
    db.prepare('SELECT id FROM vehicles WHERE slug = ? AND id != ?').get(s, vehicleId);
  let n = 2;
  while (slugTaken(slug)) slug = `${baseSlug}-${n++}`;

  const upsertVehicle = db.prepare(`
    INSERT INTO vehicles (id, slug, name, image_url, make, model, submodel, year_from, year_to, updated_at)
    VALUES (@id, @slug, @name, @imageUrl, @make, @model, @submodel, @yearFrom, @yearTo, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      slug = excluded.slug, name = excluded.name, image_url = excluded.image_url,
      make = excluded.make, model = excluded.model, submodel = excluded.submodel,
      year_from = excluded.year_from, year_to = excluded.year_to,
      updated_at = datetime('now')
  `);
  const clearHotspotProducts = db.prepare(
    'DELETE FROM hotspot_products WHERE hotspot_id IN (SELECT id FROM hotspots WHERE vehicle_id = ?)'
  );
  const clearHotspots = db.prepare('DELETE FROM hotspots WHERE vehicle_id = ?');
  const insertHotspot = db.prepare(`
    INSERT INTO hotspots (id, vehicle_id, sort_order, x, y, label, desc, mode,
      product_id, product_handle, product_title, product_price, product_image, variant_id, variant_title,
      collection_id, collection_handle, collection_title)
    VALUES (@id, @vehicleId, @sortOrder, @x, @y, @label, @desc, @mode,
      @productId, @productHandle, @productTitle, @productPrice, @productImage, @variantId, @variantTitle,
      @collectionId, @collectionHandle, @collectionTitle)
  `);
  const insertHotspotProduct = db.prepare(`
    INSERT INTO hotspot_products (id, hotspot_id, sort_order, product_id, product_handle, product_title, product_price, product_image, variant_id, variant_title)
    VALUES (@id, @hotspotId, @sortOrder, @productId, @productHandle, @productTitle, @productPrice, @productImage, @variantId, @variantTitle)
  `);

  const tx = db.transaction(() => {
    upsertVehicle.run({
      id: vehicleId, slug, name, imageUrl,
      make, model, submodel,
      yearFrom: yearFrom || null, yearTo: yearTo || null,
    });
    clearHotspotProducts.run(vehicleId);
    clearHotspots.run(vehicleId);
    hotspots.forEach((h, i) => {
      const hotspotId = h.id || newId();
      const mode = h.mode || 'single';
      insertHotspot.run({
        id: hotspotId,
        vehicleId,
        sortOrder: i,
        x: h.x,
        y: h.y,
        label: h.label || '',
        desc: h.desc || '',
        mode,
        productId: h.productId || null,
        productHandle: h.productHandle || null,
        productTitle: h.productTitle || null,
        productPrice: h.productPrice || null,
        productImage: h.productImage || null,
        variantId: h.variantId || null,
        variantTitle: h.variantTitle || null,
        collectionId: h.collectionId || null,
        collectionHandle: h.collectionHandle || null,
        collectionTitle: h.collectionTitle || null,
      });
      if (mode === 'collection' || mode === 'multi') {
        (h.products || []).forEach((p, pi) => {
          insertHotspotProduct.run({
            id: newId(),
            hotspotId,
            sortOrder: pi,
            productId: p.productId || null,
            productHandle: p.handle || null,
            productTitle: p.title || null,
            productPrice: p.price || null,
            productImage: p.image || null,
            variantId: p.variantId || null,
            variantTitle: p.variantTitle || null,
          });
        });
      }
    });
  });
  tx();

  res.json({ id: vehicleId, slug });
});

app.delete('/api/admin/vehicles/:id', (req, res) => {
  db.prepare('DELETE FROM hotspots WHERE vehicle_id = ?').run(req.params.id);
  db.prepare('DELETE FROM vehicles WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Re-pull title/price/image for every hotspot on a vehicle from Shopify,
// in case a linked product's price or title changed since it was picked
// (or a linked collection's contents changed) since it was last saved.
app.post('/api/admin/vehicles/:id/refresh', async (req, res) => {
  try {
    const hotspots = db
      .prepare('SELECT * FROM hotspots WHERE vehicle_id = ?')
      .all(req.params.id);
    const updateSingle = db.prepare(`
      UPDATE hotspots SET product_title=@title, product_price=@price, product_image=@image, variant_title=@variantTitle
      WHERE id=@id
    `);
    const updateHotspotProduct = db.prepare(`
      UPDATE hotspot_products SET product_title=@title, product_price=@price, product_image=@image, variant_title=@variantTitle
      WHERE id=@id
    `);
    const deleteHotspotProducts = db.prepare('DELETE FROM hotspot_products WHERE hotspot_id = ?');
    const insertHotspotProduct = db.prepare(`
      INSERT INTO hotspot_products (id, hotspot_id, sort_order, product_id, product_handle, product_title, product_price, product_image, variant_id, variant_title)
      VALUES (@id, @hotspotId, @sortOrder, @productId, @productHandle, @productTitle, @productPrice, @productImage, @variantId, @variantTitle)
    `);
    const fetchProduct = (productId) =>
      shopifyGraphQL(
        `query($id: ID!) {
          product(id: $id) {
            title
            featuredImage { url }
            variants(first: 1) { edges { node { price title } } }
          }
        }`,
        { id: productId }
      );

    // Prefer re-pulling the exact chosen variant so refresh never silently
    // swaps a hotspot back onto the product's default/first variant.
    const refreshOne = async (productId, variantId, fallback) => {
      if (variantId) {
        const v = await getVariantDetails(variantId);
        if (v) {
          return {
            title: v.product?.title || fallback.title,
            price: v.price,
            image: v.image?.url || v.product?.featuredImage?.url || fallback.image,
            variantTitle: v.title,
          };
        }
      }
      if (!productId) return null;
      const data = await fetchProduct(productId);
      const p = data.product;
      if (!p) return null;
      return {
        title: p.title,
        price: p.variants.edges[0]?.node.price || fallback.price,
        image: p.featuredImage?.url || fallback.image,
        variantTitle: p.variants.edges[0]?.node.title || fallback.variantTitle,
      };
    };

    for (const h of hotspots) {
      const mode = h.mode || 'single';
      if (mode === 'single') {
        if (!h.product_id) continue;
        const result = await refreshOne(h.product_id, h.variant_id, {
          title: h.product_title, price: h.product_price, image: h.product_image, variantTitle: h.variant_title,
        });
        if (!result) continue;
        updateSingle.run({ id: h.id, ...result });
      } else if (mode === 'collection' && h.collection_id) {
        const products = await getCollectionProducts(h.collection_id, 20);
        deleteHotspotProducts.run(h.id);
        products.forEach((p, i) => {
          insertHotspotProduct.run({
            id: newId(),
            hotspotId: h.id,
            sortOrder: i,
            productId: p.productId || null,
            productHandle: p.handle || null,
            productTitle: p.title || null,
            productPrice: p.price || null,
            productImage: p.image || null,
            variantId: p.variantId || null,
            variantTitle: p.variantTitle || null,
          });
        });
      } else if (mode === 'multi') {
        const items = db.prepare('SELECT * FROM hotspot_products WHERE hotspot_id = ?').all(h.id);
        for (const item of items) {
          if (!item.product_id) continue;
          const result = await refreshOne(item.product_id, item.variant_id, {
            title: item.product_title, price: item.product_price, image: item.product_image, variantTitle: item.variant_title,
          });
          if (!result) continue;
          updateHotspotProduct.run({ id: item.id, ...result });
        }
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Public API — consumed by the storefront embed script
// ---------------------------------------------------------------------------
// Lightweight list for the Make/Year/Model/Submodel picker — no hotspot data,
// so it stays small even with a lot of vehicles.
app.get('/api/vehicles-public', (req, res) => {
  const rows = db
    .prepare('SELECT slug, name, image_url, make, model, submodel, year_from, year_to FROM vehicles ORDER BY make, model, submodel')
    .all();
  res.json(
    rows.map((v) => ({
      slug: v.slug,
      name: v.name,
      image: v.image_url,
      make: v.make || '',
      model: v.model || '',
      submodel: v.submodel || '',
      yearFrom: v.year_from,
      yearTo: v.year_to,
    }))
  );
});

// This runs on a different domain to the Shopify page that calls it — CORS
// for it (and every other /api/ route) is handled globally, see app.use(cors()) above.
app.get('/api/vehicles/:slug', (req, res) => {
  const v = db.prepare('SELECT * FROM vehicles WHERE slug = ?').get(req.params.slug);
  if (!v) return res.status(404).json({ error: 'Not found' });
  const getProducts = db.prepare(
    'SELECT * FROM hotspot_products WHERE hotspot_id = ? ORDER BY sort_order ASC'
  );
  const hotspots = db
    .prepare('SELECT * FROM hotspots WHERE vehicle_id = ? ORDER BY sort_order ASC')
    .all(v.id)
    .map((h) => {
      const mode = h.mode || 'single';
      const base = { x: h.x, y: h.y, label: h.label, desc: h.desc, mode };
      if (mode === 'single') {
        return {
          ...base,
          title: h.product_title,
          price: h.product_price,
          image: h.product_image,
          handle: h.product_handle,
          variantId: h.variant_id,
          variantTitle: h.variant_title,
          url: h.product_handle ? `${STOREFRONT_URL}/products/${h.product_handle}` : null,
        };
      }
      return {
        ...base,
        collectionTitle: h.collection_title,
        products: getProducts.all(h.id).map((p) => ({
          title: p.product_title,
          price: p.product_price,
          image: p.product_image,
          handle: p.product_handle,
          variantId: p.variant_id,
          variantTitle: p.variant_title,
          url: p.product_handle ? `${STOREFRONT_URL}/products/${p.product_handle}` : null,
        })),
      };
    });
  res.json({ name: v.name, slug: v.slug, image: v.image_url, hotspots });
});

// Customer submits their selected items + contact details from the widget.
// Creates a real Shopify draft order (so pricing/stock is always Shopify's
// live truth, never trusting client-supplied prices) and emails the store.
// Body: { vehicleName, vehicleSlug, items:[{variantId,title,variantTitle,price}], customer:{name,email,phone} }
app.post('/api/quote-request', async (req, res) => {
  try {
    const { vehicleName, vehicleSlug, items = [], customer = {} } = req.body || {};
    if (!customer.firstName || !customer.lastName || !customer.email || !customer.phone || !customer.address) {
      return res.status(400).json({ error: 'Name, surname, email, phone, and shipping address are required.' });
    }
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'No items were selected.' });
    }

    const lineItems = items.filter((i) => i.variantId).map((i) => ({ variantId: i.variantId, quantity: 1 }));
    const fullName = `${customer.firstName} ${customer.lastName}`.trim();

    let draftOrder = null;
    if (lineItems.length) {
      const noteLines = [
        `Quote request via Rig Builder — Vehicle: ${vehicleName || vehicleSlug || 'unknown'}.`,
        `Customer: ${fullName}, ${customer.phone}.`,
        customer.company ? `Company: ${customer.company}.` : null,
        customer.vat ? `VAT number: ${customer.vat}.` : null,
        `Shipping address: ${customer.address}`,
      ].filter(Boolean);

      // Best-effort — if Shopify rejects the draft order for any reason, the
      // customer's request should still go through via the notification
      // email below rather than failing outright.
      try {
        const result = await shopifyGraphQL(
          `mutation($input: DraftOrderInput!) {
            draftOrderCreate(input: $input) {
              draftOrder { id name invoiceUrl totalPrice }
              userErrors { field message }
            }
          }`,
          {
            input: {
              lineItems,
              email: customer.email,
              phone: customer.phone,
              note: noteLines.join('\n'),
            },
          }
        );
        if (result.draftOrderCreate.userErrors && result.draftOrderCreate.userErrors.length) {
          console.error('draftOrderCreate errors:', result.draftOrderCreate.userErrors);
        } else {
          draftOrder = result.draftOrderCreate.draftOrder;
        }
      } catch (draftErr) {
        console.error('draftOrderCreate failed:', draftErr);
      }
    }

    // Best-effort — a broken SMTP config shouldn't fail the customer's request.
    try {
      await sendQuoteEmail({ vehicleName, customer, items, draftOrder });
    } catch (mailErr) {
      console.error('Quote email failed:', mailErr);
    }

    res.json({ ok: true, draftOrderName: draftOrder ? draftOrder.name : null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not submit your request — please try again.' });
  }
});

// Vanilla-JS embed script for Shopify Custom Liquid blocks.
// Usage: <div data-fxf-hotspot="ranger"></div><script src="https://YOUR-APP/embed.js"></script>
app.get('/embed.js', (req, res) => {
  res.type('application/javascript').send(`
(function(){
  var API_BASE = ${JSON.stringify(`${req.protocol}://${req.get('host')}`)};

  function fmtZAR(n){ return n ? ('R ' + Number(n).toLocaleString('en-ZA')) : ''; }

  function addToCart(variantId, btnEl, label){
    if(!variantId) return;
    var numericId = variantId.split('/').pop();
    var original = label || btnEl.textContent;
    fetch('/cart/add.js', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ items: [{ id: numericId, quantity: 1 }] })
    }).then(function(r){
      if(r.ok){ btnEl.textContent = 'Added!'; setTimeout(function(){ btnEl.textContent = original; }, 1500); }
      else { btnEl.textContent = 'Try again'; }
    }).catch(function(){ btnEl.textContent = 'Try again'; });
  }

  function render(root, data){
    var uid = 'fxf' + Math.random().toString(36).slice(2,9);
    root.innerHTML =
      '<div style="position:relative;max-width:900px;margin:0 auto;font-family:inherit;">' +
        '<div style="position:relative;">' +
          '<img src="' + data.image + '" alt="' + data.name + '" style="display:block;width:100%;height:auto;border-radius:4px;">' +
          '<div class="' + uid + '-pins"></div>' +
        '</div>' +
        '<div class="' + uid + '-panel" style="display:none;margin-top:14px;border:1px solid #3a3428;background:#1c1914;color:#ece4d3;border-radius:4px;padding:16px;">' +
          '<div class="' + uid + '-single">' +
            '<div style="display:flex;gap:12px;align-items:flex-start;">' +
              '<input type="checkbox" class="' + uid + '-singleCheck" style="margin-top:6px;width:16px;height:16px;flex:none;cursor:pointer;">' +
              '<img class="' + uid + '-img" style="width:64px;height:64px;object-fit:cover;border-radius:3px;flex:none;">' +
              '<div style="flex:1;min-width:0;">' +
                '<div class="' + uid + '-title" style="font-size:16px;font-weight:700;margin-bottom:4px;"></div>' +
                '<div class="' + uid + '-desc" style="font-size:13px;color:#a89f8c;line-height:1.5;margin-bottom:10px;"></div>' +
                '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">' +
                  '<div class="' + uid + '-price" style="font-size:18px;font-weight:700;"></div>' +
                  '<div style="display:flex;gap:8px;">' +
                    '<button class="' + uid + '-add" style="background:#d9a441;color:#151310;border:none;font-weight:700;padding:9px 14px;border-radius:3px;font-size:12.5px;cursor:pointer;">Add to cart</button>' +
                    '<a class="' + uid + '-link" href="#" style="border:1px solid #6b6748;color:#ece4d3;text-decoration:none;font-weight:700;padding:9px 14px;border-radius:3px;font-size:12.5px;">View</a>' +
                  '</div>' +
                '</div>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="' + uid + '-options" style="display:none;">' +
            '<div class="' + uid + '-optionsTitle" style="font-size:14px;font-weight:700;margin-bottom:4px;"></div>' +
            '<div class="' + uid + '-optionsDesc" style="font-size:13px;color:#a89f8c;line-height:1.5;margin-bottom:10px;"></div>' +
            '<div class="' + uid + '-optionsList" style="display:flex;flex-direction:column;gap:8px;max-height:300px;overflow-y:auto;"></div>' +
          '</div>' +
        '</div>' +
        '<div class="' + uid + '-bulkbar" style="display:none;position:sticky;bottom:12px;margin-top:14px;background:#d9a441;color:#151310;border-radius:4px;padding:12px 16px;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">' +
          '<div class="' + uid + '-bulkCount" style="font-size:13px;font-weight:700;"></div>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
            '<button class="' + uid + '-bulkSave" style="background:#151310;color:#ece4d3;border:none;font-weight:700;padding:10px 14px;border-radius:3px;font-size:12px;cursor:pointer;">Save my build</button>' +
            '<button class="' + uid + '-bulkQuote" style="background:#151310;color:#ece4d3;border:none;font-weight:700;padding:10px 14px;border-radius:3px;font-size:12px;cursor:pointer;">Request quote</button>' +
            '<button class="' + uid + '-bulkAdd" style="background:#151310;color:#ece4d3;border:none;font-weight:700;padding:10px 14px;border-radius:3px;font-size:12px;cursor:pointer;">Add selected to cart</button>' +
          '</div>' +
        '</div>' +
        '<div class="' + uid + '-quoteModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9999;align-items:center;justify-content:center;padding:20px;">' +
          '<div class="' + uid + '-quoteModalInner" style="background:#1c1914;border:1px solid #3a3428;border-radius:6px;padding:24px;max-width:420px;width:100%;max-height:90vh;overflow-y:auto;color:#ece4d3;">' +
            '<div style="font-size:17px;font-weight:700;margin-bottom:4px;">Request a Quote</div>' +
            '<div style="font-size:13px;color:#a89f8c;margin-bottom:16px;">We&#39;ll email you back with pricing and availability for your selected items.</div>' +
            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">' +
              '<input class="' + uid + '-qFirst" type="text" placeholder="Name" style="width:100%;padding:9px 10px;border-radius:3px;border:1px solid #3a3428;background:#211d17;color:#ece4d3;font-size:13px;box-sizing:border-box;">' +
              '<input class="' + uid + '-qLast" type="text" placeholder="Surname" style="width:100%;padding:9px 10px;border-radius:3px;border:1px solid #3a3428;background:#211d17;color:#ece4d3;font-size:13px;box-sizing:border-box;">' +
            '</div>' +
            '<input class="' + uid + '-qCompany" type="text" placeholder="Company (optional)" style="width:100%;margin-bottom:8px;padding:9px 10px;border-radius:3px;border:1px solid #3a3428;background:#211d17;color:#ece4d3;font-size:13px;box-sizing:border-box;">' +
            '<input class="' + uid + '-qVat" type="text" placeholder="VAT number (optional)" style="width:100%;margin-bottom:8px;padding:9px 10px;border-radius:3px;border:1px solid #3a3428;background:#211d17;color:#ece4d3;font-size:13px;box-sizing:border-box;">' +
            '<input class="' + uid + '-qEmail" type="email" placeholder="Email" style="width:100%;margin-bottom:8px;padding:9px 10px;border-radius:3px;border:1px solid #3a3428;background:#211d17;color:#ece4d3;font-size:13px;box-sizing:border-box;">' +
            '<input class="' + uid + '-qPhone" type="text" placeholder="Telephone number" style="width:100%;margin-bottom:8px;padding:9px 10px;border-radius:3px;border:1px solid #3a3428;background:#211d17;color:#ece4d3;font-size:13px;box-sizing:border-box;">' +
            '<textarea class="' + uid + '-qAddress" placeholder="Shipping address" rows="3" style="width:100%;margin-bottom:14px;padding:9px 10px;border-radius:3px;border:1px solid #3a3428;background:#211d17;color:#ece4d3;font-size:13px;box-sizing:border-box;font-family:inherit;resize:vertical;"></textarea>' +
            '<div class="' + uid + '-qStatus" style="font-size:12px;color:#c1541f;min-height:16px;margin-bottom:10px;"></div>' +
            '<div style="display:flex;gap:8px;">' +
              '<button class="' + uid + '-qCancel" style="flex:1;background:none;border:1px solid #6b6748;color:#ece4d3;padding:10px;border-radius:3px;font-size:12.5px;cursor:pointer;">Cancel</button>' +
              '<button class="' + uid + '-qSubmit" style="flex:1;background:#d9a441;color:#151310;border:none;font-weight:700;padding:10px;border-radius:3px;font-size:12.5px;cursor:pointer;">Send request</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<style>' +
        '.' + uid + '-pin{position:absolute;width:24px;height:24px;transform:translate(-50%,-50%);cursor:pointer;}' +
        '.' + uid + '-pin .ring{position:absolute;inset:0;border-radius:50%;border:1px solid #d9a441;opacity:0;animation:' + uid + 'pulse 2.6s ease-out infinite;}' +
        '.' + uid + '-pin .dot{position:absolute;left:50%;top:50%;width:14px;height:14px;transform:translate(-50%,-50%);border-radius:50%;background:#d9a441;box-shadow:0 0 0 4px rgba(217,164,65,0.18);}' +
        '.' + uid + '-pin:hover .dot,.' + uid + '-pin.active .dot{background:#c1541f;}' +
        '@keyframes ' + uid + 'pulse{0%{transform:scale(0.6);opacity:0.5;}100%{transform:scale(2.2);opacity:0;}}' +
      '</style>';

    var pinLayer = root.querySelector('.' + uid + '-pins');
    var panel = root.querySelector('.' + uid + '-panel');
    var singleBlock = root.querySelector('.' + uid + '-single');
    var optionsBlock = root.querySelector('.' + uid + '-options');
    var optionsTitle = root.querySelector('.' + uid + '-optionsTitle');
    var optionsDesc = root.querySelector('.' + uid + '-optionsDesc');
    var optionsList = root.querySelector('.' + uid + '-optionsList');
    var titleEl = root.querySelector('.' + uid + '-title');
    var descEl = root.querySelector('.' + uid + '-desc');
    var priceEl = root.querySelector('.' + uid + '-price');
    var imgEl = root.querySelector('.' + uid + '-img');
    var linkEl = root.querySelector('.' + uid + '-link');
    var addBtn = root.querySelector('.' + uid + '-add');
    var singleCheck = root.querySelector('.' + uid + '-singleCheck');
    var bulkBar = root.querySelector('.' + uid + '-bulkbar');
    var bulkCount = root.querySelector('.' + uid + '-bulkCount');
    var bulkAddBtn = root.querySelector('.' + uid + '-bulkAdd');
    var bulkSaveBtn = root.querySelector('.' + uid + '-bulkSave');
    var bulkQuoteBtn = root.querySelector('.' + uid + '-bulkQuote');
    var quoteModal = root.querySelector('.' + uid + '-quoteModal');
    var qFirst = root.querySelector('.' + uid + '-qFirst');
    var qLast = root.querySelector('.' + uid + '-qLast');
    var qCompany = root.querySelector('.' + uid + '-qCompany');
    var qVat = root.querySelector('.' + uid + '-qVat');
    var qEmail = root.querySelector('.' + uid + '-qEmail');
    var qPhone = root.querySelector('.' + uid + '-qPhone');
    var qAddress = root.querySelector('.' + uid + '-qAddress');
    var qStatus = root.querySelector('.' + uid + '-qStatus');
    var qSubmit = root.querySelector('.' + uid + '-qSubmit');
    var qCancel = root.querySelector('.' + uid + '-qCancel');
    var activePin = null, activeData = null;
    var selected = {}; // variantId -> { variantId, title, variantTitle, price }

    function updateBulkBar(){
      var ids = Object.keys(selected);
      if(ids.length === 0){ bulkBar.style.display = 'none'; return; }
      var total = ids.reduce(function(sum, id){ return sum + (Number(selected[id].price) || 0); }, 0);
      bulkBar.style.display = 'flex';
      bulkCount.textContent = ids.length + ' item' + (ids.length===1?'':'s') + ' selected — ' + fmtZAR(total);
    }

    function toggleSelected(variantId, title, variantTitle, price, checked){
      if(!variantId) return;
      if(checked){ selected[variantId] = { variantId:variantId, title:title, variantTitle:variantTitle, price:price }; }
      else { delete selected[variantId]; }
      updateBulkBar();
    }

    bulkAddBtn.addEventListener('click', function(){
      var items = Object.keys(selected).map(function(id){
        return { id: id.split('/').pop(), quantity: 1 };
      });
      if(!items.length) return;
      var original = bulkAddBtn.textContent;
      fetch('/cart/add.js', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ items: items })
      }).then(function(r){
        if(r.ok){
          bulkAddBtn.textContent = 'Added!';
          selected = {};
          root.querySelectorAll('input[type=checkbox]').forEach(function(cb){ cb.checked = false; });
          updateBulkBar();
          setTimeout(function(){ bulkAddBtn.textContent = original; }, 1500);
        } else { bulkAddBtn.textContent = 'Try again'; }
      }).catch(function(){ bulkAddBtn.textContent = 'Try again'; });
    });

    bulkSaveBtn.addEventListener('click', function(){
      var ids = Object.keys(selected);
      if(!ids.length) return;
      var w = window.open('', '_blank');
      if(!w){ alert('Please allow pop-ups to save your build.'); return; }
      var total = ids.reduce(function(sum,id){ return sum + (Number(selected[id].price)||0); }, 0);
      var rows = ids.map(function(id){
        var it = selected[id];
        var variantBit = (it.variantTitle && it.variantTitle !== 'Default Title') ? (' — ' + it.variantTitle) : '';
        return '<tr><td style="padding:10px;border-bottom:1px solid #ddd;">' + (it.title||'') + variantBit + '</td><td style="padding:10px;border-bottom:1px solid #ddd;text-align:right;white-space:nowrap;">' + fmtZAR(it.price) + '</td></tr>';
      }).join('');
      var html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Your Build — ' + (data.name||'') + '</title>' +
        '<style>body{font-family:Arial,Helvetica,sans-serif;color:#222;max-width:640px;margin:40px auto;padding:0 20px;}' +
        'h1{font-size:22px;margin-bottom:4px;}.sub{color:#777;margin-bottom:24px;font-size:13px;}' +
        'table{width:100%;border-collapse:collapse;margin-bottom:16px;}' +
        'th{text-align:left;padding:10px;border-bottom:2px solid #222;font-size:13px;}' +
        '.total{font-size:18px;font-weight:700;text-align:right;margin-bottom:24px;}' +
        '.printbtn{padding:10px 18px;background:#d9a441;border:none;border-radius:4px;font-weight:700;cursor:pointer;font-size:13px;}' +
        '@media print{.printbtn{display:none;}}</style></head><body>' +
        '<h1>Your Build — ' + (data.name||'') + '</h1>' +
        '<div class="sub">Saved on ' + new Date().toLocaleDateString() + '</div>' +
        (data.image ? '<img src="' + data.image + '" style="width:100%;max-width:500px;border-radius:6px;margin-bottom:20px;">' : '') +
        '<table><thead><tr><th>Item</th><th style="text-align:right;">Price</th></tr></thead><tbody>' + rows + '</tbody></table>' +
        '<div class="total">Total: ' + fmtZAR(total) + '</div>' +
        '<button class="printbtn" onclick="window.print()">Print / Save as PDF</button>' +
        '</body></html>';
      w.document.write(html);
      w.document.close();
    });

    bulkQuoteBtn.addEventListener('click', function(){
      if(!Object.keys(selected).length) return;
      qStatus.textContent = '';
      quoteModal.style.display = 'flex';
    });
    qCancel.addEventListener('click', function(){ quoteModal.style.display = 'none'; });
    qSubmit.addEventListener('click', function(){
      var firstName = qFirst.value.trim();
      var lastName = qLast.value.trim();
      var company = qCompany.value.trim();
      var vat = qVat.value.trim();
      var email = qEmail.value.trim();
      var phone = qPhone.value.trim();
      var address = qAddress.value.trim();
      if(!firstName || !lastName || !email || !phone || !address){
        qStatus.textContent = 'Please fill in name, surname, email, phone, and shipping address.';
        return;
      }
      var items = Object.keys(selected).map(function(id){
        var it = selected[id];
        return { variantId: id, title: it.title, variantTitle: it.variantTitle, price: it.price };
      });
      qSubmit.disabled = true;
      qSubmit.textContent = 'Sending…';
      fetch(API_BASE + '/api/quote-request', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          vehicleName: data.name, vehicleSlug: data.slug, items: items,
          customer: { firstName:firstName, lastName:lastName, company:company, vat:vat, email:email, phone:phone, address:address }
        })
      }).then(function(r){ return r.json(); }).then(function(resp){
        if(resp.error){
          qStatus.textContent = resp.error;
          qSubmit.disabled = false;
          qSubmit.textContent = 'Send request';
          return;
        }
        var inner = root.querySelector('.' + uid + '-quoteModalInner');
        inner.innerHTML =
          '<div style="text-align:center;">' +
            '<div style="font-size:16px;font-weight:700;margin-bottom:8px;">Request sent!</div>' +
            '<div style="font-size:13px;color:#a89f8c;">We&#39;ll be in touch shortly with your quote.</div>' +
          '</div>';
        setTimeout(function(){ quoteModal.style.display = 'none'; }, 2500);
      }).catch(function(){
        qStatus.textContent = 'Something went wrong — please try again.';
        qSubmit.disabled = false;
        qSubmit.textContent = 'Send request';
      });
    });

    data.hotspots.forEach(function(h){
      var el = document.createElement('div');
      el.className = uid + '-pin';
      el.style.left = h.x + '%';
      el.style.top = h.y + '%';
      el.title = h.label || h.title || h.collectionTitle || '';
      el.innerHTML = '<span class="ring"></span><span class="dot"></span>';
      el.addEventListener('click', function(){
        if(activePin) activePin.classList.remove('active');
        el.classList.add('active');
        activePin = el; activeData = h;
        panel.style.display = 'block';

        if(h.mode === 'multi' || h.mode === 'collection'){
          singleBlock.style.display = 'none';
          optionsBlock.style.display = 'block';
          optionsTitle.textContent = h.label || h.collectionTitle || 'Choose an option';
          optionsDesc.textContent = h.desc || '';
          optionsList.innerHTML = '';
          (h.products || []).forEach(function(p){
            var row = document.createElement('div');
            row.style.cssText = 'display:flex;gap:10px;align-items:center;border:1px solid #3a3428;border-radius:3px;padding:8px;';
            var check = document.createElement('input');
            check.type = 'checkbox';
            check.style.cssText = 'width:16px;height:16px;flex:none;cursor:pointer;';
            check.checked = !!selected[p.variantId];
            check.addEventListener('change', function(){ toggleSelected(p.variantId, p.title, p.variantTitle, p.price, check.checked); });
            var img = document.createElement('img');
            img.src = p.image || '';
            img.style.cssText = 'width:44px;height:44px;object-fit:cover;border-radius:2px;flex:none;';
            var mid = document.createElement('div');
            mid.style.cssText = 'flex:1;min-width:0;';
            var variantBit = (p.variantTitle && p.variantTitle !== 'Default Title') ? (' — ' + p.variantTitle) : '';
            mid.innerHTML =
              '<div style="font-size:13px;font-weight:600;">' + (p.title || '') + variantBit + '</div>' +
              '<div style="font-size:12px;color:#a89f8c;">' + fmtZAR(p.price) + '</div>';
            var addRowBtn = document.createElement('button');
            addRowBtn.textContent = 'Add';
            addRowBtn.style.cssText = 'background:#d9a441;color:#151310;border:none;font-weight:700;padding:7px 10px;border-radius:3px;font-size:11.5px;cursor:pointer;flex:none;';
            addRowBtn.addEventListener('click', function(){ addToCart(p.variantId, addRowBtn, 'Add'); });
            var viewLink = document.createElement('a');
            viewLink.textContent = 'View';
            viewLink.href = p.url || '#';
            viewLink.style.cssText = 'border:1px solid #6b6748;color:#ece4d3;text-decoration:none;font-weight:700;padding:7px 10px;border-radius:3px;font-size:11.5px;flex:none;';
            row.appendChild(check); row.appendChild(img); row.appendChild(mid); row.appendChild(addRowBtn); row.appendChild(viewLink);
            optionsList.appendChild(row);
          });
        } else {
          optionsBlock.style.display = 'none';
          singleBlock.style.display = 'block';
          var singleVariantBit = (h.variantTitle && h.variantTitle !== 'Default Title') ? (' — ' + h.variantTitle) : '';
          titleEl.textContent = (h.title || '') + singleVariantBit;
          descEl.textContent = h.desc || '';
          priceEl.textContent = fmtZAR(h.price);
          imgEl.src = h.image || '';
          imgEl.style.display = h.image ? 'block' : 'none';
          linkEl.href = h.url || '#';
          singleCheck.checked = !!selected[h.variantId];
          singleCheck.onchange = function(){ toggleSelected(h.variantId, h.title, h.variantTitle, h.price, singleCheck.checked); };
        }
      });
      pinLayer.appendChild(el);
    });

    addBtn.addEventListener('click', function(){
      if(!activeData || !activeData.variantId) return;
      addToCart(activeData.variantId, addBtn, 'Add to cart');
    });
  }

  function renderPicker(root, list){
    var uid = 'fxfp' + Math.random().toString(36).slice(2,9);
    var state = { make:'', year:'', model:'', submodel:'' };
    var CURRENT_YEAR = new Date().getFullYear();
    var CAP_YEAR = CURRENT_YEAR + 1;
    var selStyle = 'padding:11px 10px;border-radius:3px;border:1px solid #3a3428;background:#1c1914;color:#ece4d3;font-size:13px;width:100%;';

    root.innerHTML =
      '<div style="max-width:640px;margin:0 auto;font-family:inherit;">' +
        '<div style="background:#1c1914;border:1px solid #3a3428;border-radius:4px;padding:16px;margin-bottom:16px;">' +
          '<div style="font-size:20px;font-weight:700;color:#ece4d3;margin-bottom:6px;">Frikkie&#39;s Rig Builder</div>' +
          '<div style="font-size:14px;color:#a89f8c;line-height:1.5;">Please select your vehicle from the selection below to see what products we recommend for your build.</div>' +
        '</div>' +
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;">' +
          '<select class="' + uid + '-make" style="' + selStyle + '"></select>' +
          '<select class="' + uid + '-year" style="' + selStyle + '" disabled></select>' +
          '<select class="' + uid + '-model" style="' + selStyle + '" disabled></select>' +
          '<select class="' + uid + '-submodel" style="' + selStyle + '" disabled></select>' +
        '</div>' +
        '<div class="' + uid + '-result" style="margin-top:18px;"></div>' +
      '</div>';

    var makeSel = root.querySelector('.' + uid + '-make');
    var yearSel = root.querySelector('.' + uid + '-year');
    var modelSel = root.querySelector('.' + uid + '-model');
    var subSel = root.querySelector('.' + uid + '-submodel');
    var resultEl = root.querySelector('.' + uid + '-result');

    function uniq(arr){ return arr.filter(function(v,i){ return arr.indexOf(v) === i; }); }
    function fillSelect(sel, values, placeholder){
      sel.innerHTML = '<option value="">' + placeholder + '</option>' +
        values.map(function(v){ return '<option value="' + v + '">' + v + '</option>'; }).join('');
    }
    function matches(v, upTo){
      if(state.make && v.make !== state.make) return false;
      if(upTo === 'year') return true;
      if(state.year){
        var y = parseInt(state.year, 10);
        var lo = v.yearFrom || 0, hi = v.yearTo || CAP_YEAR;
        if(y < lo || y > hi) return false;
      }
      if(upTo === 'model') return true;
      if(state.model && v.model !== state.model) return false;
      if(upTo === 'submodel') return true;
      if(state.submodel && v.submodel !== state.submodel) return false;
      return true;
    }

    function showResult(){
      var found = list.filter(function(v){ return matches(v,'done'); });
      if(found.length === 1){
        var diagramRoot = document.createElement('div');
        resultEl.innerHTML = '';
        resultEl.appendChild(diagramRoot);
        fetch(API_BASE + '/api/vehicles/' + encodeURIComponent(found[0].slug))
          .then(function(r){ return r.json(); })
          .then(function(data){ render(diagramRoot, data); })
          .catch(function(err){ console.error('Hotspot widget failed to load:', err); });
      } else if(found.length > 1){
        resultEl.innerHTML = '<div style="color:#a89f8c;font-size:13px;padding:12px 0;">Narrow it down further above to see fitment.</div>';
      } else {
        resultEl.innerHTML = '';
      }
    }

    function refresh(){
      fillSelect(makeSel, uniq(list.map(function(v){ return v.make; })).filter(Boolean).sort(), 'Make');
      makeSel.value = state.make;

      if(!state.make){
        yearSel.disabled = modelSel.disabled = subSel.disabled = true;
        yearSel.innerHTML = modelSel.innerHTML = subSel.innerHTML = '';
        resultEl.innerHTML = '';
        return;
      }
      var years = [];
      list.filter(function(v){ return matches(v,'year'); }).forEach(function(v){
        var lo = v.yearFrom || CURRENT_YEAR, hi = v.yearTo || CAP_YEAR;
        for(var y=lo; y<=hi; y++) years.push(y);
      });
      fillSelect(yearSel, uniq(years).sort(function(a,b){return b-a;}), 'Year');
      yearSel.value = state.year;
      yearSel.disabled = false;

      if(!state.year){
        modelSel.disabled = subSel.disabled = true;
        modelSel.innerHTML = subSel.innerHTML = '';
        resultEl.innerHTML = '';
        return;
      }
      var models = uniq(list.filter(function(v){ return matches(v,'model'); }).map(function(v){ return v.model; })).filter(Boolean).sort();
      fillSelect(modelSel, models, 'Model');
      modelSel.value = state.model;
      modelSel.disabled = false;

      if(!state.model){
        subSel.disabled = true;
        subSel.innerHTML = '';
        resultEl.innerHTML = '';
        return;
      }
      var subs = uniq(list.filter(function(v){ return matches(v,'submodel'); }).map(function(v){ return v.submodel; })).filter(Boolean).sort();
      if(subs.length === 0){
        subSel.disabled = true;
        subSel.innerHTML = '';
        showResult();
        return;
      }
      fillSelect(subSel, subs, 'Submodel');
      subSel.value = state.submodel;
      subSel.disabled = false;
      showResult();
    }

    makeSel.addEventListener('change', function(){ state.make = makeSel.value; state.year=''; state.model=''; state.submodel=''; refresh(); });
    yearSel.addEventListener('change', function(){ state.year = yearSel.value; state.model=''; state.submodel=''; refresh(); });
    modelSel.addEventListener('change', function(){ state.model = modelSel.value; state.submodel=''; refresh(); });
    subSel.addEventListener('change', function(){ state.submodel = subSel.value; refresh(); });

    refresh();
  }

  document.querySelectorAll('[data-fxf-hotspot]').forEach(function(root){
    var slug = root.getAttribute('data-fxf-hotspot');
    fetch(API_BASE + '/api/vehicles/' + encodeURIComponent(slug))
      .then(function(r){
        if(!r.ok) throw new Error('Hotspot API returned ' + r.status + ' for slug "' + slug + '"');
        return r.json();
      })
      .then(function(data){
        if(data.error){ console.error('Hotspot widget:', data.error); return; }
        render(root, data);
      })
      .catch(function(err){ console.error('Hotspot widget failed to load:', err); });
  });

  document.querySelectorAll('[data-fxf-picker]').forEach(function(root){
    fetch(API_BASE + '/api/vehicles-public')
      .then(function(r){ return r.json(); })
      .then(function(list){ renderPicker(root, list); })
      .catch(function(err){ console.error('Hotspot picker failed to load:', err); });
  });
})();
`);
});

app.listen(PORT, () => console.log(`Hotspot app running on port ${PORT}`));
