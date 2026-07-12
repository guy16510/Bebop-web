# Perception, object recognition, and SLAM

## Decision

The production adapter targets **ORB-SLAM3** as an out-of-process SLAM service and **YOLOX exported to ONNX** for object detection. Bebop Web stays responsible for process supervision, validation, telemetry forwarding, browser delivery, and rendering.

The default simulated-drone configuration uses the deterministic built-in backend. A physical Bebop does not silently fall back to simulated perception. Set `PERCEPTION_BACKEND=external` and provide `PERCEPTION_COMMAND` for real processing.

## Why ORB-SLAM3

The Bebop 2 has a single wide-angle front camera. ORB-SLAM3 supports monocular input, fisheye camera models, loop closure, relocalization, multiple maps, and a future monocular-inertial path. That is a better sensor match than RTAB-Map as the primary odometry source and more complete for drone motion than stella_vslam while its IMU integration remains unfinished.

Tradeoffs:

- ORB-SLAM3 is GPLv3. Keep it in a separate process and review distribution obligations before shipping a bundled commercial product.
- Its upstream release is old and its documented build targets are old Ubuntu versions. Pin the sidecar image and test it rather than compiling it dynamically on the flight-control host.
- Monocular SLAM has scale ambiguity. The initial integration marks scale as `monocular` during initialization, then `telemetry` only after the sidecar has aligned visual motion against Bebop altitude and speed telemetry.
- The current Node adapter does not expose synchronized raw IMU samples or camera-to-IMU timing. Do not enable ORB-SLAM3 monocular-inertial mode until that data path and calibration exist.

Alternatives considered:

| System | Strength | Reason not selected as primary |
| --- | --- | --- |
| RTAB-Map | Active, long-term map storage, ROS 2 support, broad sensor support | Better as map/graph layer after reliable odometry; a monocular Bebop still needs a strong visual odometry source |
| stella_vslam | BSD-2-Clause, modular, fisheye and monocular support | Project roadmap still lists IMU integration; weaker fit for aggressive drone motion |
| OpenVINS | Strong visual-inertial estimator and calibration tooling | VIO first, not the complete loop-closing map and object rendering stack requested; GPLv3 as well |

## Why YOLOX with ONNX Runtime

YOLOX is Apache-2.0, has small models suitable for edge inference, and officially supports ONNX export. ONNX Runtime has a supported Node.js binding, so the detector can be implemented in Node or placed beside ORB-SLAM3 in the sidecar without forcing a Python-only application architecture.

Object `recognizedName` is deliberately separate from the detector's class `label`. A detector can say `bottle`; a user-managed recognition catalog can later resolve a persistent track to `Chris's water bottle`, a known AprilTag, or another local identity. This change does not add face recognition.

## Process protocol

The external command is started with `shell: true` and communicates using newline-delimited JSON on stdin/stdout.

Bebop Web sends:

```json
{"type":"start","protocolVersion":1,"videoUrl":"http://127.0.0.1:3000/video.mjpeg","stateUrl":"http://127.0.0.1:3000/api/state","slam":{"library":"ORB-SLAM3","sensorMode":"monocular","cameraModel":"fisheye","requireCalibration":true},"detector":{"runtime":"ONNX Runtime","modelFamily":"YOLOX"}}
```

It then sends telemetry updates:

```json
{"type":"telemetry","telemetry":{"altitude":1.2,"speedX":0.1,"speedY":0,"speedZ":0,"updatedAt":1710000000000}}
```

The backend returns:

```json
{"type":"perception.snapshot","snapshot":{"sequence":42,"timestamp":1710000000000,"backend":"external","source":"orb-slam3-yolox","trackingState":"tracking","calibrated":true,"scaleSource":"telemetry","pose":{"x":1,"y":2,"z":1.2,"roll":0,"pitch":0,"yaw":1.57},"trajectory":[],"detections":[],"map":{"bounds":{"minX":-5,"maxX":5,"minY":-5,"maxY":5,"minZ":0,"maxZ":3},"landmarks":[]},"metrics":{"inputFps":30,"slamFps":27,"detectionFps":10,"inferenceMs":32,"endToEndLatencyMs":51,"trackedFeatures":284,"keyframes":18,"loopClosures":1}}}
```

Every update is schema-validated. Invalid bounding boxes, non-finite coordinates, malformed map bounds, and invalid confidence values are rejected. The server also caps trajectory length, landmark count, and detections before broadcasting them.

## Configuration

```dotenv
# simulated, external, or disabled
PERCEPTION_BACKEND=simulation

# Required when PERCEPTION_BACKEND=external
PERCEPTION_COMMAND=node /absolute/path/to/orbslam3-yolox-sidecar.mjs

PERCEPTION_UPDATE_HZ=10
PERCEPTION_MAX_TRAJECTORY_POINTS=900
PERCEPTION_MAX_LANDMARKS=2500
PERCEPTION_VIDEO_URL=http://127.0.0.1:3000/video.mjpeg
PERCEPTION_STATE_URL=http://127.0.0.1:3000/api/state
```

For `DRONE_MODE=bebop`, the backend defaults to `disabled`, not `simulation`.

## Simulation and acceptance checks

Run:

```bash
npm run typecheck
npm test
npm run check:client
npm run perception:smoke
```

The smoke test launches a separate mock sidecar process, sends the real start protocol, receives schema-validated map and object snapshots, verifies tracked poses, detections, landmarks, trajectory growth, and then shuts the process down.

This proves the Node process boundary, validation, lifecycle, WebSocket payload shape, and renderer input contract. It does not prove physical-camera calibration, frame timing, motion blur tolerance, or tracking stability in flight.

## Real-hardware gate

Keep the propellers removed until all of these pass:

1. Calibrate the exact stabilized stream used by the sidecar, including its effective crop and fisheye model.
2. Replay a recorded walk-around and confirm initialization, relocalization, loop closure, bounded drift, and correct object overlays.
3. Move the powered drone by hand and confirm the rendered pose direction matches the physical axes.
4. Verify perception CPU load does not worsen STOP RTT or the 20 Hz command scheduler.
5. Confirm the sidecar can crash, hang, and restart without affecting STOP, Land, Emergency, or the command watchdog.
6. Only then perform a low-altitude, open-area hover test with perception read-only. Do not use perception output for autonomous control yet.
