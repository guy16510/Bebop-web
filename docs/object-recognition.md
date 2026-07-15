# Object detection, tracking, and named-object recognition

## Architecture

The production camera path has three responsibilities:

1. ORB-SLAM3 estimates camera motion and renders the sparse map.
2. The recognition sidecar runs YOLOX, motion and appearance tracking, and compact visual descriptors for every observed crop.
3. The Node recognition registry enrolls named objects, rejects unknown objects, persists samples, and requires repeated confirmations before exposing a name.

A name is never inferred from a YOLO class. `chair` remains an unknown chair until an operator enrolls a specific chair and captures enough distinct samples.

## Enrollment

1. Start video and perception.
2. Open **Named object recognition** on the dashboard.
3. Select a confirmed live track and choose **Enroll**.
4. Enter a useful name.
5. Move around the object or change camera angle and add at least two more samples.
6. Capture more samples across expected lighting, distance, and viewpoint changes.

The default minimum is three samples. Three samples make the enrollment eligible, not necessarily reliable. Ten or more diverse views are recommended for an object that matters to navigation.

Only compact normalized appearance descriptors are persisted in `.bebop/recognition.json`. Raw crops are not stored by default.

## Unknown rejection

Recognition requires all of the following:

- Matching detector label
- Enough enrollment samples
- Similarity above the object's configured threshold
- A sufficient margin over the second-best object
- Repeated confirmations on the same stable track

When those conditions are not met, the result remains the generic detector label and `recognition.state` is `unknown` or `candidate`.

## Tracking

The tracker combines predicted motion, bounding-box overlap, detector class, and appearance similarity. Tracks survive short missed-detection windows and partial occlusion. A track is tentative until it has at least three detector hits.

Stable tracking reduces identity churn, but it is not biometric identity and is not used for face recognition.

## Flight safety

Recognition is advisory semantic information. It does not prove free space and does not replace range sensing.

- No detection never means no obstacle.
- Metric range remains the primary collision guard.
- A recognized target cannot override a person obstacle, stale video, stale telemetry, geofence, emergency stop, or landing command.
- Unknown objects remain governed by their generic detector class.

## Tuning

Environment variables:

- `RECOGNITION_ENABLED`
- `RECOGNITION_COMMAND`
- `RECOGNITION_VIDEO_URL`
- `RECOGNITION_OUTPUT_HZ`
- `RECOGNITION_EVERY_N_FRAMES`
- `RECOGNITION_TRACK_MAX_MISSES`
- `RECOGNITION_REGISTRY_FILE`
- `RECOGNITION_MINIMUM_SAMPLES`
- `RECOGNITION_MINIMUM_MARGIN`
- `RECOGNITION_MAXIMUM_SAMPLES`
- `YOLOX_CONFIDENCE`
- `YOLOX_LOW_CONFIDENCE`

Do not lower thresholds merely to make a weak enrollment appear to work. Add better samples and validate against confusing objects.
