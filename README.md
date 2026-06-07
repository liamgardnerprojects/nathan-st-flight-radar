# Nathan St Flight Radar

Retro **80s sports-car HUD** for an asymmetric sector from Nathan Street, Coogee: **2 km west**, **8 km east**, **±4 km north/south**, via the [OpenSky Network](https://opensky-network.org/) API.

- **Standby** **23:00–07:00** (local time) — no scans overnight  
- **Landed aircraft** excluded  
- Scan interval set automatically from your OpenSky tier (**15 s** with account, **~2m 42s** anonymous)

## Connect your OpenSky account

1. Log in at [opensky-network.org](https://opensky-network.org/) → **Account** → create an **API client**.
2. Copy the **client ID** and **client secret** (or download `credentials.json`).
3. In this project folder, create **`credentials.json`** (never commit it):

```bash
cp credentials.json.example credentials.json
# Edit credentials.json — paste your clientId and clientSecret
```

Or use environment variables:

```bash
export OPENSKY_CLIENT_ID="your-client-id"
export OPENSKY_CLIENT_SECRET="your-client-secret"
```

4. Restart the server. You should see:

```text
OpenSky: authenticated · 4000 credits/day · scan every 15s
```

The HUD **LINK** readout shows **AUTH** when credentials are active.

## Run

```bash
cd "/Users/liamgardner/Documents/Nathan St Flight Radar"
python3 server.py
```

Open **http://127.0.0.1:8765** on your Mac (or `http://<mac-ip>:8765` on iPad, same Wi‑Fi).

Change port: `PORT=9000 python3 server.py`

## Deploy (live HTTPS URL)

The app needs the Python server running (it proxies OpenSky). Easiest path: **[Render](https://render.com)** free tier.

### 1. Push to GitHub

```bash
cd "/Users/liamgardner/Documents/Nathan St Flight Radar"
git init
git add .
git commit -m "Initial commit — Nathan St Flight Radar"
```

Create a new empty repo on GitHub, then:

```bash
git remote add origin git@github.com:YOUR_USER/nathan-st-flight-radar.git
git branch -M main
git push -u origin main
```

(`credentials.json` is gitignored — it will not be uploaded.)

### 2. Create the web service on Render

1. [dashboard.render.com](https://dashboard.render.com) → **New** → **Blueprint** (or **Web Service** if you prefer manual setup).
2. Connect your GitHub repo.
3. Render reads `render.yaml` and creates the service.
4. In the service → **Environment**, add:
   - `OPENSKY_CLIENT_ID` — same value as `clientId` in your local `credentials.json`
   - `OPENSKY_CLIENT_SECRET` — same as `clientSecret`
5. Deploy. Your live URL will look like `https://nathan-st-flight-radar.onrender.com`.

Open that URL on your Mac or iPad (any network). The HUD **LINK** readout should show **AUTH** if env vars are set.

**Notes**

- Free Render apps **sleep after ~15 minutes idle**; the first load after sleep can take 30–60 seconds.
- A public URL exposes your OpenSky proxy — anyone with the link could use your daily API credits. Use a private/obscure URL or upgrade to a paid plan with access control if that matters.
- **Render + OpenSky:** OpenSky often times out from Render’s cloud servers. The app polls OpenSky in the background and serves cached data, but if scans stay on **link FAULT**, use the **Cloudflare Tunnel** option below instead — it exposes your Mac (where OpenSky works reliably).

### Alternative: Cloudflare Tunnel (recommended if Render faults)

Run the server on your Mac, then share it on HTTPS without Render:

```bash
brew install cloudflared   # one-time
cd "/Users/liamgardner/Documents/Nathan St Flight Radar"
python3 server.py          # terminal 1
cloudflared tunnel --url http://127.0.0.1:8765   # terminal 2
```

Cloudflare prints a `https://….trycloudflare.com` URL — use that on iPad/phone from anywhere. Your Mac must stay on and running both commands.

## Privacy

`server.py` proxies OpenSky on your home network so the browser avoids CORS limits. Credentials stay on your Mac (`credentials.json` is gitignored).

## Credits (approx.)

| Tier | Daily credits | Scan interval (with standby) |
|------|---------------|------------------------------|
| Anonymous | 400 | ~2m 42s |
| Registered | 4,000 | **15s** |

Each bbox scan uses ~1 state credit. Aircraft type/airline metadata is cached per session.
