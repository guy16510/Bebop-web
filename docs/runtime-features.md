# Runtime startup features

`npm run dev` is the complete development entry point.

On the first run it creates `.env` from `.env.bebop.example` when `.env` is missing. For the external perception backend it verifies Docker Desktop, checks FFmpeg for physical Bebop mode, calculates a hash of the native perception sources, and builds the ORB-SLAM3 plus YOLOX image only when that hash differs from the image label.

Set `DEV_REBUILD_PERCEPTION=true` for one run to force a clean perception-image rebuild.

The dashboard persists runtime choices in `.bebop/runtime-features.json`:

- automatic drone connection
- automatic decoded video and stale-frame recovery
- combined ORB-SLAM3 plus YOLOX processing
- detection-overlay visibility
- map-rendering visibility

Enabling processing automatically enables video. Disabling video automatically disables processing. Display toggles do not stop the native backend; they only control browser rendering.

The same settings are available over HTTP:

```text
GET  /api/features
POST /api/features
GET  /api/automation
```

Example:

```bash
curl -X POST http://127.0.0.1:3000/api/features \
  -H 'content-type: application/json' \
  -d '{"autoConnect":true,"video":true,"perception":true}'
```
