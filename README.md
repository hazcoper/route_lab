# RouteLab — GitHub Pages edition

Static dashboard — no Flask server or Python on GitHub Pages. The **published trip loads automatically** from `data/trip.json`. The converter also generates CSV, GPX and KML download files.

## Publish on GitHub Pages

1. Create a GitHub repository. Upload **the contents of this directory to the repository root** (`index.html`, `static/`, `data/`, `tools/`, `.nojekyll`). Do not upload an enclosing folder as the only root file.
2. Open **Settings → Pages → Build and deployment** and select **Deploy from a branch**, branch `main`, folder `/ (root)`; save.
3. After publishing finishes, open `https://YOUR_USERNAME.github.io/YOUR_REPOSITORY/`. Your trip should appear automatically.

For a repository named `YOUR_USERNAME.github.io`, use `https://YOUR_USERNAME.github.io/`.

## Publish a new trip

Locally, from the repository root:

```bash
python3 tools/publish_trip.py /path/to/track.bin
```

This overwrites `data/trip.json`, `data/trip.csv`, `data/trip.gpx`, `data/trip.kml`. Then commit and push:

```bash
git add data/
git commit -m "Publish GPS trip"
git push
```

No third-party Python packages are needed for the converter. It accepts both `GPSLOG01` (16-byte records) and `GPSLOG02` (20-byte records), although the dashboard currently does not show altitude. The JSON powers the existing interactive map, linked time charts, fix-quality and distance statistics.

## Check locally

Opening `index.html` from the filesystem (`file://`) often blocks the JSON fetch. Use a local web server:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000/.

## Privacy

The sample trip provided here was generated from **your previously supplied `trip.csv`**, so it will show a real route immediately. A public GitHub Pages site and its GPS data are publicly accessible, **including coordinates, dates, and timestamps**. Remove or replace the sample data before publishing if you do not want to share it. Do not commit raw `.bin` files unless desired, since the generated files contain the required published data.

## Notes

Map tiles and external Leaflet/Chart.js dependencies require an internet connection. The app uses relative URLs so it works under project repository paths. Recorded trip data is not uploaded from visitors' devices.
