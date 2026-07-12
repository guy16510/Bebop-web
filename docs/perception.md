# Perception, object recognition, and SLAM

## Implemented stack

Bebop Web now includes a buildable external perception container with:

- **ORB-SLAM3** pinned to commit `4452a3c4ab75b1cde34e5505a36ec3f9edcdc4c4`
- monocular `KannalaBrandt8` fisheye tracking
- camera pose, sparse landmarks, trajectory, relocalization state, and loop-change reporting
- **YOLOX-Tiny** ONNX model from the official `0.1.1rc0` release
- OpenCV DNN inference, COCO classes, non-maximum suppression, and persistent track IDs
- newline-delimited JSON supervision by the Node process
- an interactive SVG dashboard map with pan, wheel/pinch zoom, fit, follow-drone, layer toggles, tooltips, and JSON export

Perception remains a separate read-only process. It cannot issue takeoff, landing, emergency, STOP, or piloting commands.

## Why ORB-SLAM3

The Bebop 2 has a single wide-angle front camera. ORB-SLAM3 supports monocular input, fisheye camera models, loop closure, relocalization, multiple maps, and a future monocular-inertial path. The public `System` API accepts monocular frames and returns pose while exposing tracking state, tracked map points, and tracked keypoints.

Tradeoffs:

- ORB-SLAM3 is GPLv3. It is isolated in its own process and container. Review distribution obligations before shipping a commercial bundle.
- Upstream is old, so the Docker build pins the exact source commit and Pangolin version instead of compiling arbitrary latest revisions.
- Monocular SLAM has scale ambiguity. Current sidecar output is marked `monocular`; Bebop altitude is used for the rendered Z value only when telemetry is fresh.
- The current drone adapter does not expose synchronized raw IMU data or camera-to-IMU timing. Visual-inertial mode remains disabled.
- Accurate operation requires calibration of the exact stabilized, resized, and cropped stream consumed by the sidecar.

Alternatives considered:

| System | Strength | Reason not selected as primary |
| --- | --- | --- |
| RTAB-Map | Active, long-term map storage, ROS 2 support, broad sensor support | Better as a graph and persistence layer after reliable monocular odometry |
| stella_vslam | BSD-2-Clause, modular, fisheye and monocular support | Weaker fit for the future synchronized IMU path and aggressive drone motion |
| OpenVINS | Strong visual-inertial estimator and calibration tooling | VIO first, not the requested loop-closing visual map and object-rendering stack |

## Why YOLOX-Tiny

YOLOX is Apache-2.0, anchor-free, and supports ONNX deployment. The sidecar downloads the official YOLOX-Tiny ONNX release during its Docker build, then runs it through OpenCV DNN. The C++ implementation includes official-style grid and stride decoding, confidence filtering, class selection, NMS, and short-lived IoU tracking.

`recognizedName` is deliberately separate from the detector class `label`. Today it uses the COCO class name. A later catalog can map a track to a local identity such as a tagged tool or known object. This feature does not perform face recognition.

## Build the real sidecar

Docker is required.

```bash
npm run perception:sidecar:build
```

That command:

1. builds Pangolin `v0.6`
2. builds the pinned ORB-SLAM3 source and vocabulary
3. compiles `bebop-perception-sidecar`
4. downloads the official YOLOX-Tiny ONNX model
5. links the complete runtime
6. executes the containerized protocol self-test

Run the self-test again at any time:

```bash
npm run perception:sidecar:self-test
```

The self-test proves the real linked binary starts and emits a schema-compatible snapshot. It does not claim a specific physical camera is calibrated.

## Calibrate the exact Bebop video stream

Calibration is a hard startup gate. The repository does not silently treat example intrinsics as measured calibration.

First run Bebop Web with the drone connected, perception disabled, and MJPEG preview active. Then install the calibration-only dependencies:

```bash
python3 -m venv .venv-calibration
source .venv-calibration/bin/activate
pip install -r perception-sidecar/requirements-calibration.txt
```

Use a printed chessboard with nine by six inner corners and move it through the full image at varied distances and angles:

```bash
python3 scripts/calibrate-bebop-camera.py \
  --source http://127.0.0.1:3000/video.mjpeg \
  --board-cols 9 \
  --board-rows 6 \
  --square-size 0.024 \
  --output config/perception/bebop2.yaml
```

The script uses OpenCV fisheye calibration, requires many accepted views, rejects non-finite results, and fails when RMS reprojection error exceeds the configured threshold. Recalibrate whenever the effective stream resolution, stabilization, crop, or resize changes.

## Run with the physical drone

Use these `.env` settings after building the image and creating `config/perception/bebop2.yaml`:

```dotenv
DRONE_MODE=bebop
PERCEPTION_BACKEND=external
PERCEPTION_AUTO_START=false
PERCEPTION_COMMAND=bash scripts/run-perception-sidecar.sh
PERCEPTION_VIDEO_URL=http://host.docker.internal:3000/video.mjpeg
PERCEPTION_STATE_URL=http://host.docker.internal:3000/api/state
PERCEPTION_CALIBRATION_FILE=config/perception/bebop2.yaml
```

Then:

```bash
npm install
npm run dev
```

In the dashboard:

1. Connect to the Bebop.
2. Start video and confirm `/api/video/health` reports frames.
3. Start perception.
4. Wait for tracking to change from `initializing` to `tracking`.
5. Move the propeller-free drone by hand and confirm the trajectory direction and landmark map are coherent.

The launcher runs Docker with stdin and stdout attached so Bebop Web can supervise the process. It mounts the measured calibration read-only and maps `host.docker.internal` for Linux Docker as well as Docker Desktop.

## Sidecar protocol

Bebop Web sends a start message:

```json
{"type":"start","protocolVersion":1,"videoUrl":"http://host.docker.internal:3000/video.mjpeg","stateUrl":"http://host.docker.internal:3000/api/state","slam":{"library":"ORB-SLAM3","sensorMode":"monocular","cameraModel":"fisheye","requireCalibration":true},"detector":{"runtime":"OpenCV DNN","modelFamily":"YOLOX"}}
```

It then forwards telemetry:

```json
{"type":"telemetry","telemetry":{"altitude":1.2,"speedX":0.1,"speedY":0,"speedZ":0,"updatedAt":1710000000000}}
```

The sidecar returns:

```json
{"type":"perception.snapshot","snapshot":{"sequence":42,"timestamp":1710000000000,"backend":"external","source":"orb-slam3-yolox-opencv","trackingState":"tracking","calibrated":true,"scaleSource":"monocular","pose":{"x":1,"y":2,"z":1.2,"roll":0,"pitch":0,"yaw":1.57},"trajectory":[],"detections":[],"map":{"bounds":{"minX":-5,"maxX":5,"minY":-5,"maxY":5,"minZ":0,"maxZ":3},"landmarks":[]},"metrics":{"inputFps":30,"slamFps":27,"detectionFps":10,"inferenceMs":32,"endToEndLatencyMs":51,"trackedFeatures":284,"keyframes":0,"loopClosures":1}}}
```

Every update is schema-validated by the Node server. Invalid bounding boxes, non-finite coordinates, malformed map bounds, and invalid confidence values are rejected. Trajectory, landmark, and detection counts are bounded before browser broadcast.

## Dashboard map

The map renderer is local and dependency-free so it remains available while connected to the Bebop Wi-Fi network. It uses SVG rather than a static canvas and supports:

- drag to pan
- wheel or trackpad zoom around the pointer
- double-click or **Fit map** to reset the view
- **Follow drone** to keep the current pose centered
- landmark, trajectory, and mapped-object layers
- nearest landmark and object tooltips
- map snapshot JSON export
- quality-prioritized rendering when landmark count exceeds the visual limit

Object detections are always drawn over the video. They appear on the world map only when `worldPosition` exists. The native sidecar leaves estimated object range disabled by default because monocular bounding boxes do not provide reliable depth. Set `OBJECT_POSITION_ESTIMATE=true` only when an approximate visualization is acceptable.

## Automated validation

```bash
npm run typecheck
npm run check:client
npm test
npm run perception:smoke
npm run perception:sidecar:build
```

GitHub Actions runs the Node tests and separately builds the complete ORB-SLAM3 and YOLOX Docker image, executes the linked native binary, parses its JSON, and verifies the external snapshot contract.

## Physical acceptance gate

Keep the propellers removed until all of these pass:

1. The exact camera stream has a low-error measured fisheye calibration.
2. A recorded walk-around initializes, loses tracking when intentionally obscured, relocalizes, and closes a loop when revisiting the starting area.
3. Hand movement produces the expected dashboard axis and heading direction.
4. Object boxes stay aligned with the MJPEG frame and persistent IDs do not churn excessively.
5. Perception CPU load does not worsen STOP RTT or the 20 Hz command scheduler.
6. The sidecar can be killed and restarted without affecting STOP, Land, Emergency, or the command watchdog.
7. Only then perform a low-altitude, open-area hover test with perception read-only.

Do not feed SLAM or detector output into autonomous flight controls until a separate safety-reviewed control architecture exists.
