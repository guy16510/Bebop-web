#!/usr/bin/env python3
from pathlib import Path
import shutil


def replace(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old not in text:
        raise SystemExit(f"Expected block not found in {path}: {old[:120]!r}")
    file.write_text(text.replace(old, new, 1))


def insert_after(path: str, anchor: str, addition: str) -> None:
    replace(path, anchor, anchor + addition)


replace(
    "src/server.ts",
    "import { PerceptionManager, type PerceptionBackend } from './perception.js';",
    "import { PerceptionManager, type PerceptionBackend, type PerceptionSnapshot } from './perception.js';",
)
insert_after(
    "src/server.ts",
    "import type { MappingAutostartStatus } from './mapping-autostart.js';\n",
    "import { ObjectRecognitionManager, type RecognizableDetection } from './object-recognition.js';\n"
    "import { RecognitionVisionManager } from './recognition-vision.js';\n",
)
replace(
    "src/server.ts",
    "const perception = new PerceptionManager({\n"
    "  backend: perceptionBackend,\n"
    "  command: process.env.PERCEPTION_COMMAND,\n"
    "  updateHz: Number(process.env.PERCEPTION_UPDATE_HZ ?? 10),\n"
    "  maxTrajectoryPoints: Number(process.env.PERCEPTION_MAX_TRAJECTORY_POINTS ?? 900),\n"
    "  maxLandmarks: Number(process.env.PERCEPTION_MAX_LANDMARKS ?? 2_500),\n"
    "  videoUrl: process.env.PERCEPTION_VIDEO_URL ?? `http://127.0.0.1:${port}/video.mjpeg`,\n"
    "  stateUrl: process.env.PERCEPTION_STATE_URL ?? `http://127.0.0.1:${port}/api/state`,\n"
    "  onUpdate: (snapshot, health) => broadcast({ type: 'perception.status', snapshot, health }),\n"
    "});\n\n"
    "function perceptionStatus(): {\n"
    "  snapshot: ReturnType<PerceptionManager['getSnapshot']>;\n"
    "  health: ReturnType<PerceptionManager['getHealth']>;\n"
    "} {\n"
    "  return { snapshot: perception.getSnapshot(), health: perception.getHealth() };\n"
    "}\n\n"
    "async function runPerceptionAction(\n"
    "  action: 'start' | 'stop' | 'reset',\n"
    "): Promise<ReturnType<typeof perceptionStatus>> {\n"
    "  if (action === 'start') await perception.start();\n"
    "  else if (action === 'stop') await perception.stop();\n"
    "  else perception.reset();\n"
    "  return perceptionStatus();\n"
    "}\n",
    "const objectRecognition = new ObjectRecognitionManager({\n"
    "  storagePath: process.env.RECOGNITION_REGISTRY_FILE ?? '.bebop/recognition.json',\n"
    "  minimumSamples: Number(process.env.RECOGNITION_MINIMUM_SAMPLES ?? 3),\n"
    "  maximumSamplesPerObject: Number(process.env.RECOGNITION_MAXIMUM_SAMPLES ?? 48),\n"
    "  minimumMargin: Number(process.env.RECOGNITION_MINIMUM_MARGIN ?? 0.04),\n"
    "});\n"
    "let latestRecognizedDetections: RecognizableDetection[] = [];\n"
    "let latestRecognitionTimestamp = 0;\n"
    "const recognitionVision = new RecognitionVisionManager({\n"
    "  command: process.env.RECOGNITION_COMMAND ?? 'bash scripts/run-recognition-sidecar.sh',\n"
    "  enabled: envBoolean('RECOGNITION_ENABLED', droneMode === 'bebop'),\n"
    "  restartMs: Number(process.env.RECOGNITION_RESTART_MS ?? 2_000),\n"
    "  onUpdate: (snapshot) => {\n"
    "    latestRecognitionTimestamp = snapshot.timestamp;\n"
    "    latestRecognizedDetections = objectRecognition.recognize(snapshot.detections, snapshot.timestamp);\n"
    "    broadcastPerceptionStatus();\n"
    "  },\n"
    "});\n"
    "const recognitionStaleMs = Number(process.env.RECOGNITION_STALE_MS ?? 1_500);\n\n"
    "function recognitionFresh(now = Date.now()): boolean {\n"
    "  const health = recognitionVision.getHealth();\n"
    "  return health.state === 'running'\n"
    "    && health.lastUpdateAt !== null\n"
    "    && now - health.lastUpdateAt <= recognitionStaleMs;\n"
    "}\n\n"
    "function enrichedPerceptionSnapshot(base: PerceptionSnapshot): PerceptionSnapshot {\n"
    "  return { ...base, detections: recognitionFresh() ? latestRecognizedDetections : base.detections };\n"
    "}\n\n"
    "const perception = new PerceptionManager({\n"
    "  backend: perceptionBackend,\n"
    "  command: process.env.PERCEPTION_COMMAND,\n"
    "  updateHz: Number(process.env.PERCEPTION_UPDATE_HZ ?? 10),\n"
    "  maxTrajectoryPoints: Number(process.env.PERCEPTION_MAX_TRAJECTORY_POINTS ?? 900),\n"
    "  maxLandmarks: Number(process.env.PERCEPTION_MAX_LANDMARKS ?? 2_500),\n"
    "  videoUrl: process.env.PERCEPTION_VIDEO_URL ?? `http://127.0.0.1:${port}/video.mjpeg`,\n"
    "  stateUrl: process.env.PERCEPTION_STATE_URL ?? `http://127.0.0.1:${port}/api/state`,\n"
    "  onUpdate: (snapshot, health) => broadcast({\n"
    "    type: 'perception.status',\n"
    "    snapshot: enrichedPerceptionSnapshot(snapshot),\n"
    "    health,\n"
    "    recognition: recognitionStatus(),\n"
    "  }),\n"
    "});\n\n"
    "function recognitionStatus() {\n"
    "  return {\n"
    "    registry: objectRecognition.getStatus(),\n"
    "    vision: recognitionVision.getHealth(),\n"
    "    sourceTimestamp: latestRecognitionTimestamp,\n"
    "    fresh: recognitionFresh(),\n"
    "    liveDetections: structuredClone(latestRecognizedDetections),\n"
    "  };\n"
    "}\n\n"
    "function perceptionStatus() {\n"
    "  return {\n"
    "    snapshot: enrichedPerceptionSnapshot(perception.getSnapshot()),\n"
    "    health: perception.getHealth(),\n"
    "    recognition: recognitionStatus(),\n"
    "  };\n"
    "}\n\n"
    "function broadcastPerceptionStatus(): void {\n"
    "  broadcast({ type: 'perception.status', ...perceptionStatus() });\n"
    "}\n\n"
    "function currentRecognitionTrack(trackId: string): RecognizableDetection {\n"
    "  const detection = recognitionVision.getSnapshot().detections.find((item) => item.id === trackId);\n"
    "  if (!detection) throw new Error(`Live recognition track ${trackId} was not found`);\n"
    "  if (Date.now() - detection.lastSeenAt > recognitionStaleMs) throw new Error(`Live recognition track ${trackId} is stale`);\n"
    "  return detection;\n"
    "}\n\n"
    "function refreshRecognitionMatches(): void {\n"
    "  const snapshot = recognitionVision.getSnapshot();\n"
    "  latestRecognitionTimestamp = snapshot.timestamp;\n"
    "  objectRecognition.resetTrackConfirmations();\n"
    "  latestRecognizedDetections = objectRecognition.recognize(snapshot.detections, snapshot.timestamp || Date.now());\n"
    "  broadcastPerceptionStatus();\n"
    "}\n\n"
    "async function runPerceptionAction(\n"
    "  action: 'start' | 'stop' | 'reset',\n"
    "): Promise<ReturnType<typeof perceptionStatus>> {\n"
    "  if (action === 'start') {\n"
    "    await perception.start();\n"
    "    recognitionVision.start();\n"
    "  } else if (action === 'stop') {\n"
    "    await Promise.all([perception.stop(), recognitionVision.stop()]);\n"
    "  } else {\n"
    "    perception.reset();\n"
    "    objectRecognition.resetTrackConfirmations();\n"
    "    await recognitionVision.stop();\n"
    "    recognitionVision.start();\n"
    "  }\n"
    "  return perceptionStatus();\n"
    "}\n",
)
replace(
    "src/server.ts",
    "app.get('/api/health', (_req, res) => res.json({\n  ok: true,\n  mode: droneMode,\n  perceptionBackend,\n  features: features.getStatus(),\n}));",
    "app.get('/api/health', (_req, res) => res.json({\n  ok: true,\n  mode: droneMode,\n  perceptionBackend,\n  features: features.getStatus(),\n  recognition: recognitionStatus(),\n}));",
)
insert_after(
    "src/server.ts",
    "app.post('/api/perception/:action', async (req, res) => {\n  try {\n    const action = perceptionActionSchema.parse(req.params.action);\n    res.json(await runPerceptionAction(action));\n  } catch (error) {\n    const message = error instanceof Error ? error.message : String(error);\n    log.error({ action: req.params.action, error: message }, 'Perception action failed');\n    res.status(500).json({ error: message, ...perceptionStatus() });\n  }\n});\n",
    "\nconst recognitionEnrollSchema = z.object({ name: z.string().trim().min(1).max(128), trackId: z.string().min(1).max(128) });\n"
    "const recognitionSampleSchema = z.object({ trackId: z.string().min(1).max(128) });\n"
    "const recognitionUpdateSchema = z.object({\n"
    "  name: z.string().trim().min(1).max(128).optional(),\n"
    "  labels: z.array(z.string().trim().min(1).max(128)).min(1).max(16).optional(),\n"
    "  enabled: z.boolean().optional(),\n"
    "  threshold: z.number().finite().min(0.45).max(0.99).optional(),\n"
    "  minimumConfirmations: z.number().int().min(1).max(12).optional(),\n"
    "}).strict().refine((value) => Object.keys(value).length > 0, { message: 'At least one update is required' });\n"
    "app.get('/api/recognition/status', (_req, res) => res.json(recognitionStatus()));\n"
    "app.post('/api/recognition/objects', (req, res) => {\n"
    "  try {\n"
    "    const input = recognitionEnrollSchema.parse(req.body);\n"
    "    const object = objectRecognition.enroll(input.name, currentRecognitionTrack(input.trackId));\n"
    "    refreshRecognitionMatches();\n"
    "    res.status(201).json({ object, ...recognitionStatus() });\n"
    "  } catch (error) {\n"
    "    res.status(400).json({ error: error instanceof Error ? error.message : String(error), ...recognitionStatus() });\n"
    "  }\n"
    "});\n"
    "app.post('/api/recognition/objects/:objectId/samples', (req, res) => {\n"
    "  try {\n"
    "    const input = recognitionSampleSchema.parse(req.body);\n"
    "    const object = objectRecognition.addSample(req.params.objectId, currentRecognitionTrack(input.trackId));\n"
    "    refreshRecognitionMatches();\n"
    "    res.json({ object, ...recognitionStatus() });\n"
    "  } catch (error) {\n"
    "    res.status(400).json({ error: error instanceof Error ? error.message : String(error), ...recognitionStatus() });\n"
    "  }\n"
    "});\n"
    "app.post('/api/recognition/objects/:objectId', (req, res) => {\n"
    "  try {\n"
    "    const object = objectRecognition.update(req.params.objectId, recognitionUpdateSchema.parse(req.body));\n"
    "    refreshRecognitionMatches();\n"
    "    res.json({ object, ...recognitionStatus() });\n"
    "  } catch (error) {\n"
    "    res.status(400).json({ error: error instanceof Error ? error.message : String(error), ...recognitionStatus() });\n"
    "  }\n"
    "});\n"
    "app.delete('/api/recognition/objects/:objectId', (req, res) => {\n"
    "  try {\n"
    "    objectRecognition.remove(req.params.objectId);\n"
    "    refreshRecognitionMatches();\n"
    "    res.json(recognitionStatus());\n"
    "  } catch (error) {\n"
    "    res.status(404).json({ error: error instanceof Error ? error.message : String(error), ...recognitionStatus() });\n"
    "  }\n"
    "});\n",
)
text = Path("src/server.ts").read_text()
text = text.replace(
    "await Promise.allSettled([video.stop(), rawVideo.stop(), perception.stop()]);",
    "await Promise.allSettled([video.stop(), rawVideo.stop(), perception.stop(), recognitionVision.stop()]);",
)
old_switch = """        case 'perception.start':
          await perception.start();
          break;
        case 'perception.stop':
          await perception.stop();
          break;
        case 'perception.reset':
          perception.reset();
          break;"""
new_switch = """        case 'perception.start':
          await perception.start();
          recognitionVision.start();
          break;
        case 'perception.stop':
          await Promise.all([perception.stop(), recognitionVision.stop()]);
          break;
        case 'perception.reset':
          perception.reset();
          objectRecognition.resetTrackConfirmations();
          await recognitionVision.stop();
          recognitionVision.start();
          break;"""
if old_switch not in text:
    raise SystemExit("Perception websocket switch block was not found")
Path("src/server.ts").write_text(text.replace(old_switch, new_switch, 1))

insert_after("public/index.html", "  <link rel=\"stylesheet\" href=\"/perception.css\" />\n", "  <link rel=\"stylesheet\" href=\"/recognition.css\" />\n")
replace(
    "public/features.js",
    "import('./pad-map-bridge.js')\n  .then(() => import('./autonomy.js'))\n  .then(() => import('./navigation.js'))",
    "import('./pad-map-bridge.js')\n  .then(() => import('./recognition.js'))\n  .then(() => import('./autonomy.js'))\n  .then(() => import('./navigation.js'))",
)
replace("package.json", "node --check public/perception.js && node --check public/features.js", "node --check public/perception.js && node --check public/recognition.js && node --check public/features.js")
insert_after(
    "package.json",
    '    "landing-vision:self-test": "docker run --rm --entrypoint python3 ${PERCEPTION_IMAGE:-bebop-perception-sidecar:local} /work/perception-sidecar/scripts/apriltag_stream.py --self-test",\n',
    '    "recognition-vision:self-test": "docker run --rm --entrypoint python3 ${PERCEPTION_IMAGE:-bebop-perception-sidecar:local} /work/perception-sidecar/scripts/recognition_stream.py --self-test",\n',
)
replace(
    "perception-sidecar/Dockerfile",
    "    /work/perception-sidecar/scripts/apriltag_stream.py \\\n",
    "    /work/perception-sidecar/scripts/apriltag_stream.py \\\n    /work/perception-sidecar/scripts/recognition_stream.py \\\n",
)
replace(
    "perception-sidecar/Dockerfile",
    "    && python3 /work/perception-sidecar/scripts/apriltag_stream.py --self-test | grep -q 'apriltag-7'",
    "    && python3 /work/perception-sidecar/scripts/apriltag_stream.py --self-test | grep -q 'apriltag-7' \\\n    && python3 /work/perception-sidecar/scripts/recognition_stream.py --self-test | grep -q '\"ok\": true'",
)
insert_after(
    "scripts/run-perception-sidecar.sh",
    "CALIBRATION_FILE=${PERCEPTION_CALIBRATION_FILE:-config/perception/bebop2-upstream-428x240.yaml}\n",
    "YOLOX_MODEL_PATH=/models/yolox_tiny.onnx\nif [[ \"${RECOGNITION_ENABLED:-true}\" == \"true\" ]]; then\n  YOLOX_MODEL_PATH=/models/disabled-in-slam-sidecar.onnx\nfi\n",
)
insert_after("scripts/run-perception-sidecar.sh", "  -e YOLOX_CONFIDENCE=\"${YOLOX_CONFIDENCE:-0.35}\" \\\n", "  -e YOLOX_MODEL=\"$YOLOX_MODEL_PATH\" \\\n")

env_block = """
# Named-object recognition. This sidecar owns YOLOX detection and appearance tracking.
RECOGNITION_ENABLED=true
RECOGNITION_COMMAND=bash scripts/run-recognition-sidecar.sh
RECOGNITION_VIDEO_URL=http://host.docker.internal:3000/video.mjpeg
RECOGNITION_REGISTRY_FILE=.bebop/recognition.json
RECOGNITION_OUTPUT_HZ=10
RECOGNITION_EVERY_N_FRAMES=2
RECOGNITION_TRACK_MAX_MISSES=12
RECOGNITION_RESTART_MS=2000
RECOGNITION_RECONNECT_MS=300
RECOGNITION_STALE_MS=1500
RECOGNITION_MINIMUM_SAMPLES=3
RECOGNITION_MAXIMUM_SAMPLES=48
RECOGNITION_MINIMUM_MARGIN=0.04
YOLOX_LOW_CONFIDENCE=0.20
"""
insert_after(".env.bebop.example", "OBJECT_POSITION_ESTIMATE=false\n", env_block)
insert_after(".env.example", "OBJECT_POSITION_ESTIMATE=false\n", env_block.replace("RECOGNITION_ENABLED=true", "RECOGNITION_ENABLED=false"))

replace(
    ".github/workflows/ci.yml",
    "python3 -m py_compile scripts/calibrate-bebop-camera.py perception-sidecar/scripts/apriltag_stream.py",
    "python3 -m py_compile scripts/calibrate-bebop-camera.py perception-sidecar/scripts/apriltag_stream.py perception-sidecar/scripts/recognition_stream.py",
)
insert_after(
    ".github/workflows/ci.yml",
    "          docker run --rm \\\n            --entrypoint python3 \\\n            bebop-perception-sidecar:ci \\\n            /work/perception-sidecar/scripts/apriltag_stream.py --self-test \\\n            > /tmp/apriltag-self-test.json\n",
    "          docker run --rm \\\n            --entrypoint python3 \\\n            bebop-perception-sidecar:ci \\\n            /work/perception-sidecar/scripts/recognition_stream.py --self-test \\\n            > /tmp/recognition-self-test.json\n",
)
insert_after(
    ".github/workflows/ci.yml",
    "          assert april['detections'][0]['id'] == 'apriltag-7'\n",
    "\n          recognition = json.loads(Path('/tmp/recognition-self-test.json').read_text())\n          assert recognition['ok'] is True\n          assert recognition['descriptorLength'] == 496\n          assert recognition['trackRecovered'] is True\n",
)

Path("scripts/run-recognition-sidecar.sh").chmod(0o755)
Path("perception-sidecar/scripts/recognition_stream.py").chmod(0o755)
Path("scripts/apply-object-recognition.py").chmod(0o755)
Path("scripts/bootstrap-object-recognition.py").unlink(missing_ok=True)
shutil.rmtree(".github/recognition-payload", ignore_errors=True)
print("Object recognition integration applied")
