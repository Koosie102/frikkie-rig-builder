# 4x4 Factory SA — Hotspot Builder

Upload a photo of a vehicle, click on it to place hotspots, link each hotspot to a
real product from your Shopify catalog, then embed the result on a product page
or a standalone page.

## What's here

- `server.js` — Express backend: admin auth, Shopify product search, image
  upload (pushed to Shopify Files so it survives redeploys), vehicle/hotspot
  storage in SQLite, a public API, and the `/embed.js` storefront widget.
- `public/admin.html` — the dashboard you use to build vehicles.
- SQLite database file, path set by `DATABASE_PATH`.

## 1. Set up a Shopify custom app (same pattern as Frikkie)

In your Shopify admin: **Settings → Apps and sales channels → Develop apps →
Create an app**. Give it API access with these Admin API scopes:

- `read_products` — to search your catalog in the hotspot picker
- `write_files`, `read_files` — to upload the vehicle PNG to Shopify Files

Install the app to the store, then grab the **Client ID** and **Client
Secret** from the app's API credentials page — these go in your `.env`
(`SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET`). This is the same Client
Credentials Grant flow Frikkie already uses, so if that app's credentials
already have `read_products` + file scopes, you can reuse the same app
instead of creating a second one.

## 2. Configure environment variables

Copy `.env.example` to `.env` and fill in:

- `ADMIN_PASSWORD` — whatever you want to log into `/admin.html` with
- `SESSION_SECRET` — any long random string
- `SHOPIFY_STORE_DOMAIN` — your `.myshopify.com` domain
- `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET` — from step 1
- `STOREFRONT_URL` — your live store domain, used to build "View product" links
- `DATABASE_PATH` — where the SQLite file lives (see note below)

## 3. Run locally

```
npm install
npm run start
```

Visit `http://localhost:3000/admin.html`, log in, build a vehicle.

## 4. Deploy (Railway, same as Frikkie)

Push this to a GitHub repo and connect it to Railway the same way Frikkie is
set up. Two things to get right before you rely on it:

- **Set all the `.env` variables as Railway Variables.**
- **Mount a persistent volume** and point `DATABASE_PATH` at a file inside it
  (e.g. `/data/hotspots.db`) — this is the exact SQLite-wipes-on-redeploy
  issue you already hit with Frikkie, so it's worth fixing from day one here
  rather than after you lose data.

Vehicle images themselves don't need the volume — they're uploaded straight
to Shopify Files, so they survive redeploys regardless.

## 5. Build a vehicle

1. Log into `/admin.html`
2. **+ New vehicle** → name it → **Upload PNG**
3. Click the image to drop hotspots. Click a hotspot to select it, then use
   **Shopify product** search to attach a real product — title, price and
   image are pulled in automatically.
4. **Save.** The page then shows an embed snippet like:

   ```html
   <div data-fxf-hotspot="next-gen-ford-ranger"></div>
   <script src="https://your-app.up.railway.app/embed.js"></script>
   ```

## 6. Put it on the Shopify store

In the theme editor: **Online Store → Themes → Customize** → open the
product page (or a standalone page) → **Add block → Custom Liquid** → paste
the two lines from step 5. The widget fetches the vehicle's hotspot data
live from your app and renders it — clicking a pin shows the product with an
**Add to cart** button (uses Shopify's own `/cart/add.js`, so it adds to the
visitor's real cart) and a **View** link to the product page.

You can add the same embed to as many pages as you like — one per vehicle
model, or multiple on one page if that's ever useful.

## Keeping it in sync

Prices/titles are cached in the hotspot at the moment you pick the product,
so storefront page loads are fast and don't hit the Shopify API. If a linked
product's price changes, hit **Refresh prices** on that vehicle in the admin
to re-pull the latest from Shopify.

## Known limitations / next steps

- Admin auth is a single shared password — fine for one person, not built
  for a team with individual logins.
- No image resizing/compression on upload — keep source PNGs reasonably
  sized (under a few MB) so the store CDN serves them fast.
- `Add to cart` adds the product's **first variant only** — if a linked
  product has size/colour options, you'll want to extend the picker to let
  you choose a specific variant instead of defaulting to the first one.
