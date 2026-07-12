# Semantic navigation, obstacle avoidance, and landing pads

## What the camera can and cannot do

The Bebop wide-angle camera is useful for:

- YOLOX object detection and tracking
- ORB-SLAM3 pose and map visualization
- AprilTag landing-pad recognition
- deciding which object or pad is visible

It is not a reliable stand-alone distance sensor. This project uses monocular ORB-SLAM3, so horizontal translation scale remains arbitrary unless an independent metric source anchors it. The server therefore refuses to use clicked SLAM-map coordinates as physical meters.

Physical autonomous translation should use a metric range source in addition to the camera.

## Recommended obstacle hardware

### Indoor and short-range testing

Use a small microcontroller with multiple ToF sensors arranged as sectors:

- front-left
- front
- front-right
- left
- right
- optional rear
- optional down-facing sensor

Three forward sectors are the minimum useful layout. Five horizontal sectors provide substantially better turn-away behavior. Mount sensors outside the propeller arcs and calibrate each sensor's orientation after installation.

### Outdoor operation

Do not depend on inexpensive short-range infrared ToF sensors in bright sunlight without validating their real range. A compact sunlight-rated LiDAR or scanning LiDAR is the more credible option. The server interface is sensor-independent, so either an ESP32 range ring or a LiDAR bridge can publish the same sector schema.

## Range ingestion API

Post range updates to the autonomy service, normally port `3001`, at 10 to 20 Hz:

```http
POST /api/navigation/ranges
Content-Type: application/json
```

```json
{
  "source": "esp32-range-ring",
  "observedAt": 1783872000000,
  "sectors": {
    "frontLeft": { "distanceMeters": 2.8, "confidence": 0.96 },
    "front": { "distanceMeters": 1.7, "confidence": 0.99 },
    "frontRight": { "distanceMeters": 3.1, "confidence": 0.95 },
    "left": 4.2,
    "right": 3.8,
    "rear": 5.0,
    "down": 1.3
  }
}
```

The dashboard shows the source, freshness, and each range sector. During autonomous translation the controller:

1. reduces movement inside the caution distance
2. stops inside the hard-stop distance
3. turns toward a clearly safer side when one exists
4. lands after a sustained blocked condition
5. blocks movement when required range data becomes stale

Range data is intentionally received by the autonomy service rather than the browser. Closing the browser does not remove obstacle braking.

## Semantic object definitions

The dashboard lets the server assign user-defined meaning to detector output.

Each object definition contains:

- a stable ID
- a display name
- one or more YOLO labels
- optional AprilTag IDs
- a behavior: `obstacle`, `landmark`, `landing-pad`, or `ignore`
- a desired clearance distance
- notes

For example, a definition can name YOLO label `chair` as `Kitchen chairs`, or map AprilTag `21` to `Red tool cart`.

Definitions persist in:

```text
.bebop/navigation-map.json
```

The live dashboard resolves current YOLO tracks and AprilTag observations through this registry. A `person` defaults to obstacle behavior even when no custom definition exists.

## Landing pads

Use a unique AprilTag 36h11 ID for every landing pad.

For each pad, save:

- stable ID and name
- AprilTag ID
- measured printed black-marker size in meters
- optional current GPS position
- optional current SLAM-map pose for visualization
- approach altitude
- GPS arrival radius

Print the marker with a large white border, attach it flat to a high-contrast landing surface, and measure the actual printed black square. A larger marker improves detection height and tolerance to blur.

The current landing implementation uses marker image position rather than full 6-DoF tag pose:

1. move the camera toward the configured downward tilt
2. search for the selected AprilTag
3. align the marker center with the image center
4. descend only while centered
5. issue the Bebop landing command below the configured final altitude
6. return to search if the tag is temporarily lost
7. abort to a controlled landing if the marker cannot be recovered

The roll and pitch signs are configurable because camera orientation, image stabilization, and Bebop coordinate conventions must be verified on the actual drone.

## Same-pad mission

1. Place a tagged pad at the takeoff point.
2. Save it in the dashboard.
3. Select it as both takeoff and landing pad.
4. Enable **Require landing marker**.
5. Choose `Hover only` or `Hover + yaw scan`.

The takeoff pad currently acts as a persisted mission label and preflight definition. The landing pad provides the final visual target.

## Different-pad mission

For the current Bebop implementation, a physical different-pad mission requires:

- a current Bebop GPS fix
- current yaw or heading telemetry
- GPS coordinates saved for the destination pad
- fresh metric obstacle range sectors
- the destination AprilTag for final alignment

Choose `Fly to named pad` and select the destination. The controller performs:

```text
takeoff
  -> climb
  -> rotate toward destination GPS bearing
  -> fly forward through obstacle filtering
  -> stop inside the pad arrival radius
  -> tilt camera and search for AprilTag
  -> align, descend, and land
```

GPS is only coarse guidance. Do not expect centimeter precision from it. The AprilTag handles final placement.

## Map-defined positions

The dashboard can capture a current SLAM pose for a pad or landmark. That position is saved and rendered as a semantic anchor, but it is not used for physical routing while `scaleSource` is `monocular-relative`.

Reliable indoor navigation between arbitrary map points needs one of these metric anchors:

- visual-inertial odometry with synchronized IMU and camera timestamps
- UWB anchors
- external motion capture
- known-marker localization with enough mapped markers
- a metric depth or LiDAR SLAM pipeline

Until one of those is integrated and validated, enabling XY control from the current map would create false precision.

## Physical validation sequence

Do not go directly from CI to an untethered autonomous flight.

1. Remove the propellers.
2. Run `npm run dev` and verify live video, SLAM, AprilTag recognition, GPS state, heading, and range freshness.
3. Move obstacles through every sensor sector and confirm the dashboard values.
4. Exercise the obstacle filter in simulation and confirm hard stop, slowdown, and turn direction.
5. Move the drone by hand above each tagged pad and verify image corrections point in the expected physical direction.
6. Reinstall propellers only after those signs are confirmed.
7. Perform a low-altitude same-pad hover and landing in a clear open area.
8. Test a different pad only after repeated same-pad landings and range-sensor obstruction tests succeed.

CI proves the software state machine and protocol paths. It cannot prove sensor mounting, sunlight behavior, propeller vibration, optical blur, RF conditions, or the sign of the physical correction axes on this individual drone.
