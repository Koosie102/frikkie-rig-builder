require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const Database = require('better-sqlite3');

const {
  PORT = 3000,
  SHOPIFY_STORE_DOMAIN,
  SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET,
  SHOPIFY_API_VERSION = '2025-01',
  STOREFRONT_URL = '',
  DATABASE_PATH = './data/hotspots.db',
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
            variants(first: 1) { edges { node { id price } } }
          }
        }
      }
    }`,
    { q: q ? `title:*${q}*` : '' }
  );
  return data.products.edges.map(({ node }) => ({
    productId: node.id,
    title: node.title,
    handle: node.handle,
    image: node.featuredImage ? node.featuredImage.url : null,
    variantId: node.variants.edges[0] ? node.variants.edges[0].node.id : null,
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
// App setup
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

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
    hotspots: db
      .prepare('SELECT * FROM hotspots WHERE vehicle_id = ? ORDER BY sort_order ASC')
      .all(v.id),
  }));
  res.json(withHotspots);
});

app.get('/api/admin/vehicles/:id', (req, res) => {
  const v = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(req.params.id);
  if (!v) return res.status(404).json({ error: 'Not found' });
  v.hotspots = db
    .prepare('SELECT * FROM hotspots WHERE vehicle_id = ? ORDER BY sort_order ASC')
    .all(v.id);
  res.json(v);
});

// Create or update a vehicle + its full hotspot list in one call.
// Body: { id?, name, imageUrl, make, model, submodel, yearFrom, yearTo,
//         hotspots: [{x,y,label,desc,productId,productHandle,productTitle,productPrice,productImage,variantId}] }
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
  const clearHotspots = db.prepare('DELETE FROM hotspots WHERE vehicle_id = ?');
  const insertHotspot = db.prepare(`
    INSERT INTO hotspots (id, vehicle_id, sort_order, x, y, label, desc,
      product_id, product_handle, product_title, product_price, product_image, variant_id)
    VALUES (@id, @vehicleId, @sortOrder, @x, @y, @label, @desc,
      @productId, @productHandle, @productTitle, @productPrice, @productImage, @variantId)
  `);

  const tx = db.transaction(() => {
    upsertVehicle.run({
      id: vehicleId, slug, name, imageUrl,
      make, model, submodel,
      yearFrom: yearFrom || null, yearTo: yearTo || null,
    });
    clearHotspots.run(vehicleId);
    hotspots.forEach((h, i) => {
      insertHotspot.run({
        id: h.id || newId(),
        vehicleId,
        sortOrder: i,
        x: h.x,
        y: h.y,
        label: h.label || '',
        desc: h.desc || '',
        productId: h.productId || null,
        productHandle: h.productHandle || null,
        productTitle: h.productTitle || null,
        productPrice: h.productPrice || null,
        productImage: h.productImage || null,
        variantId: h.variantId || null,
      });
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
// in case a linked product's price or title changed since it was picked.
app.post('/api/admin/vehicles/:id/refresh', async (req, res) => {
  try {
    const hotspots = db
      .prepare('SELECT * FROM hotspots WHERE vehicle_id = ?')
      .all(req.params.id);
    const update = db.prepare(`
      UPDATE hotspots SET product_title=@title, product_price=@price, product_image=@image
      WHERE id=@id
    `);
    for (const h of hotspots) {
      if (!h.product_id) continue;
      const data = await shopifyGraphQL(
        `query($id: ID!) {
          product(id: $id) {
            title
            featuredImage { url }
            variants(first: 1) { edges { node { price } } }
          }
        }`,
        { id: h.product_id }
      );
      const p = data.product;
      if (!p) continue;
      update.run({
        id: h.id,
        title: p.title,
        price: p.variants.edges[0]?.node.price || h.product_price,
        image: p.featuredImage?.url || h.product_image,
      });
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
  res.set('Access-Control-Allow-Origin', '*');
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

// This runs on a different domain to the Shopify page that calls it, so it
// needs CORS allowed explicitly or the browser blocks the fetch silently.
app.get('/api/vehicles/:slug', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const v = db.prepare('SELECT * FROM vehicles WHERE slug = ?').get(req.params.slug);
  if (!v) return res.status(404).json({ error: 'Not found' });
  const hotspots = db
    .prepare('SELECT * FROM hotspots WHERE vehicle_id = ? ORDER BY sort_order ASC')
    .all(v.id)
    .map((h) => ({
      x: h.x,
      y: h.y,
      label: h.label,
      desc: h.desc,
      title: h.product_title,
      price: h.product_price,
      image: h.product_image,
      handle: h.product_handle,
      variantId: h.variant_id,
      url: h.product_handle ? `${STOREFRONT_URL}/products/${h.product_handle}` : null,
    }));
  res.json({ name: v.name, slug: v.slug, image: v.image_url, hotspots });
});

// Vanilla-JS embed script for Shopify Custom Liquid blocks.
// Usage: <div data-fxf-hotspot="ranger"></div><script src="https://YOUR-APP/embed.js"></script>
app.get('/embed.js', (req, res) => {
  res.type('application/javascript').send(`
(function(){
  var API_BASE = ${JSON.stringify(`${req.protocol}://${req.get('host')}`)};

  function fmtZAR(n){ return n ? ('R ' + Number(n).toLocaleString('en-ZA')) : ''; }

  function render(root, data){
    var uid = 'fxf' + Math.random().toString(36).slice(2,9);
    root.innerHTML =
      '<div style="position:relative;max-width:900px;margin:0 auto;font-family:inherit;">' +
        '<div style="position:relative;">' +
          '<img src="' + data.image + '" alt="' + data.name + '" style="display:block;width:100%;height:auto;border-radius:4px;">' +
          '<div class="' + uid + '-pins"></div>' +
        '</div>' +
        '<div class="' + uid + '-panel" style="display:none;margin-top:14px;border:1px solid #3a3428;background:#1c1914;color:#ece4d3;border-radius:4px;padding:16px;">' +
          '<div style="display:flex;gap:14px;align-items:flex-start;">' +
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
    var titleEl = root.querySelector('.' + uid + '-title');
    var descEl = root.querySelector('.' + uid + '-desc');
    var priceEl = root.querySelector('.' + uid + '-price');
    var imgEl = root.querySelector('.' + uid + '-img');
    var linkEl = root.querySelector('.' + uid + '-link');
    var addBtn = root.querySelector('.' + uid + '-add');
    var activePin = null, activeData = null;

    data.hotspots.forEach(function(h){
      var el = document.createElement('div');
      el.className = uid + '-pin';
      el.style.left = h.x + '%';
      el.style.top = h.y + '%';
      el.title = h.label || h.title || '';
      el.innerHTML = '<span class="ring"></span><span class="dot"></span>';
      el.addEventListener('click', function(){
        if(activePin) activePin.classList.remove('active');
        el.classList.add('active');
        activePin = el; activeData = h;
        titleEl.textContent = h.title || '';
        descEl.textContent = h.desc || '';
        priceEl.textContent = fmtZAR(h.price);
        imgEl.src = h.image || '';
        imgEl.style.display = h.image ? 'block' : 'none';
        linkEl.href = h.url || '#';
        panel.style.display = 'block';
      });
      pinLayer.appendChild(el);
    });

    addBtn.addEventListener('click', function(){
      if(!activeData || !activeData.variantId) return;
      var numericId = activeData.variantId.split('/').pop();
      fetch('/cart/add.js', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ items: [{ id: numericId, quantity: 1 }] })
      }).then(function(r){
        if(r.ok){ addBtn.textContent = 'Added!'; setTimeout(function(){ addBtn.textContent = 'Add to cart'; }, 1500); }
        else { addBtn.textContent = 'Try again'; }
      }).catch(function(){ addBtn.textContent = 'Try again'; });
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
