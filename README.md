# Black hole camera

See yourself through a spinning black hole: a web page that takes the live webcam picture
and bends it the way a (Kerr) black hole bends light, following general relativity.
Made for science expos and booths: it runs in a browser, full screen, with a webcam.

**Try it:** <https://drmayerson.github.io/bh-camera/> (Chrome or Edge; allow the camera).

What it can do:

- live lensing by a spinning black hole (mass, spin and viewing angle adjustable);
- remove the background behind the visitors (green screen, or person recognition that also
  works at a booth with people at a distance) and show the stars or a picture instead;
- clickable **explanation points** on the picture: what the light did there;
- photos: by click, arrow key, presenter remote, or by **raising a hand** (no touching);
  saved on the computer and/or offered to visitors as a **QR code** to download on their
  phone (needs your own small photo service, see below);
- Dutch, English, French and German; works offline after one visit; PIN lock for an
  unattended touch screen.

Everything is set in **Instellingen** (the gear, bottom left). For running it at an
event, see [EXPO.md](EXPO.md).


## Your own photo service for QR codes (Cloudflare, free)

With **Foto's → QR-code tonen** switched on, every photo is uploaded to a small service of
your own. The page then shows a QR code; the visitor scans it and gets a page with their
photo and a download button. Photos are deleted automatically after **24 hours**.

The service is one file, [`cloudflare/worker.js`](cloudflare/worker.js), running as a
Cloudflare Worker on the free plan. You need a free Cloudflare account, nothing else.
Setting it up takes about 15 minutes, once.

### 1. Create a Cloudflare account

Sign up at <https://dash.cloudflare.com/sign-up> (free plan). No website or domain is needed.

### 2. Create the storage (Workers KV)

1. In the dashboard, open **Storage & databases → Workers KV** (on older layouts:
   **Workers & Pages → KV**).
2. **Create** a namespace, for example called `black-hole-photos`.
3. Under **Data location**, choose **Jurisdiction → European Union (EU)** if your visitors
   are in Europe: the photos are personal data, and this keeps them stored in the EU.
   This cannot be changed later.

### 3. Create the Worker

1. Open **Workers & Pages** (in newer layouts under **Compute**) and click **Create**.
2. Choose **Start with Hello World!**, give it a name (for example `black-hole-photos`)
   and click **Deploy**.
3. Click **Edit code**, delete everything in the editor, paste the full contents of
   [`cloudflare/worker.js`](cloudflare/worker.js) (raw file:
   <https://raw.githubusercontent.com/drmayerson/bh-camera/main/cloudflare/worker.js>),
   and click **Deploy** again.
4. Note the address of the Worker: `https://<worker-name>.<your-account>.workers.dev`.

### 4. Connect the storage and choose a booth key

Open the Worker; it has tabs **Overview · Metrics · Deployments · Bindings · Observability ·
Settings**.

1. **Bindings → Add binding → KV namespace**. Variable name: `PHOTOS_KV` (exactly like
   this); KV namespace: the one from step 2.
2. **Settings → Variables and Secrets → + Add**:
   - type **Secret**, name `BOOTH_KEY`, value: a long password you make up (for example
     four random words). Only booths that know it can upload photos.
   - type **Text**, name `ALLOWED_ORIGIN`, value: the address the camera page is opened
     from, without a path and without a slash at the end. For the public camera page
     that is `https://drmayerson.github.io`; for your own copy, its own address.
3. Click **Deploy**.

Check: opening the Worker address in a browser shows "Black hole camera: photo service
running."

### 5. Connect the camera page

On the booth computer, open the camera page; in **Instellingen → Foto's**:

1. tick **Klik in het beeld … om een foto te maken** and **QR-code tonen**;
2. **Adres van de fotodienst**: the Worker address from step 3;
3. **Standsleutel**: the `BOOTH_KEY` from step 4;
4. click **Verbinding testen**: it should say that the connection is fine.

The browser remembers this (**Onthouden** is on by default). Several booths may use the
same service and key; each booth only shows its own QR codes again (key **Q**).

### Limits of the free plan

Workers KV on the free plan allows about **1,000 uploads per day** (for all booths using
the service together; the count starts again at 00:00 UTC) and **1 GB** of stored photos.
Uploads are copies of at most 2048 pixels wide, so 1,000 photos fit. When the limit is
reached, nothing breaks: the booth says that the photo service is full for today and
saves the photo on its own computer instead.

For busier events use **R2** storage instead (free up to millions of uploads per month,
but Cloudflare asks for a payment method): see [cloudflare/SETUP.md](cloudflare/SETUP.md),
which also has more detail on every step, privacy, and what to check before an event.


## Your own copy of the page (optional)

The page is plain HTML, CSS and JavaScript: no build step. To host your own copy, fork this
repository and switch on **Settings → Pages** (branch `main`, folder `/`), or put the files
on any web server (https is needed for the camera). Then use that address as
`ALLOWED_ORIGIN` above.


## How the code is organised

| File | What it is |
|---|---|
| `index.html` | the page: markup only |
| `style.css` | all styles |
| `texts.js` | every text, in Dutch, English, French and German |
| `js/01-lensing-shader.js` | the physics: a WebGL shader with the Kerr lensing (Gralla & Lupsasca) |
| `js/02-setup.js` … `js/12-main.js` | the program, one topic per file, loaded in this order; each file starts with a description, and `02-setup.js` has a "where to find what" map |
| `sw.js` | offline cache |
| `backgrounds/` | background pictures (NASA) |
| `cloudflare/` | the photo service and its setup guide |
| `EXPO.md` | checklist for running it at an event |
