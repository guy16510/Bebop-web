#!/usr/bin/env python3
"""Detect AprilTag 36h11 landing pads from the Bebop MJPEG stream.

Stdout is reserved for newline-delimited protocol messages. Diagnostics go to stderr.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import signal
import sys
import time
from typing import Any

import cv2
import numpy as np

RUNNING = True


def stop(_signum: int, _frame: Any) -> None:
    global RUNNING
    RUNNING = False


def dictionary() -> Any:
    if not hasattr(cv2, "aruco"):
        raise RuntimeError("OpenCV was built without the aruco module")
    return cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_APRILTAG_36h11)


def detector_parameters() -> Any:
    if hasattr(cv2.aruco, "DetectorParameters_create"):
        return cv2.aruco.DetectorParameters_create()
    return cv2.aruco.DetectorParameters()


def detect(frame: np.ndarray, first_seen: dict[int, int], now_ms: int) -> list[dict[str, Any]]:
    corners, ids, _rejected = cv2.aruco.detectMarkers(frame, dictionary(), parameters=detector_parameters())
    if ids is None:
        return []

    height, width = frame.shape[:2]
    detections: list[dict[str, Any]] = []
    for marker_corners, raw_id in zip(corners, ids.flatten()):
        marker_id = int(raw_id)
        points = marker_corners.reshape(-1, 2)
        min_x = max(0.0, float(np.min(points[:, 0])))
        min_y = max(0.0, float(np.min(points[:, 1])))
        max_x = min(float(width), float(np.max(points[:, 0])))
        max_y = min(float(height), float(np.max(points[:, 1])))
        if max_x - min_x < 2 or max_y - min_y < 2:
            continue
        first_seen.setdefault(marker_id, now_ms)
        detections.append(
            {
                "id": f"apriltag-{marker_id}",
                "label": "landing-pad",
                "recognizedName": f"AprilTag {marker_id}",
                "confidence": 1.0,
                "bbox": {
                    "x": min_x / width,
                    "y": min_y / height,
                    "width": (max_x - min_x) / width,
                    "height": (max_y - min_y) / height,
                },
                "firstSeenAt": first_seen[marker_id],
                "lastSeenAt": now_ms,
            }
        )
    return detections


def make_marker(marker_id: int, size: int) -> np.ndarray:
    marker = np.zeros((size, size), dtype=np.uint8)
    if hasattr(cv2.aruco, "generateImageMarker"):
        cv2.aruco.generateImageMarker(dictionary(), marker_id, size, marker, 1)
    else:
        cv2.aruco.drawMarker(dictionary(), marker_id, size, marker, 1)
    canvas = np.full((size + 160, size + 160), 255, dtype=np.uint8)
    canvas[80 : 80 + size, 80 : 80 + size] = marker
    return cv2.cvtColor(canvas, cv2.COLOR_GRAY2BGR)


def self_test() -> int:
    frame = make_marker(7, 320)
    detections = detect(frame, {}, int(time.time() * 1000))
    if not detections or detections[0]["id"] != "apriltag-7":
        print("AprilTag self-test failed", file=sys.stderr)
        return 2
    print(json.dumps({"ok": True, "detections": detections}))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        return self_test()

    video_url = os.environ.get("LANDING_VISION_VIDEO_URL", "http://host.docker.internal:3000/video.mjpeg")
    output_hz = max(1.0, min(30.0, float(os.environ.get("LANDING_VISION_OUTPUT_HZ", "12"))))
    detect_every = max(1, int(os.environ.get("APRILTAG_EVERY_N_FRAMES", "2")))
    reconnect_ms = max(100, int(os.environ.get("LANDING_VISION_RECONNECT_MS", "300")))

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    first_seen: dict[int, int] = {}
    frame_number = 0
    last_output = 0.0
    capture: cv2.VideoCapture | None = None

    while RUNNING:
        if capture is None or not capture.isOpened():
            capture = cv2.VideoCapture(video_url, cv2.CAP_FFMPEG)
            capture.set(cv2.CAP_PROP_BUFFERSIZE, 1)
            if not capture.isOpened():
                print(f"Unable to open AprilTag video source: {video_url}", file=sys.stderr)
                time.sleep(reconnect_ms / 1000)
                continue

        ok, frame = capture.read()
        if not ok or frame is None or frame.size == 0:
            print("AprilTag video frame read failed, reconnecting", file=sys.stderr)
            capture.release()
            capture = None
            time.sleep(reconnect_ms / 1000)
            continue

        frame_number += 1
        if frame_number % detect_every != 0:
            continue
        now = time.monotonic()
        if now - last_output < 1.0 / output_hz:
            continue
        last_output = now
        now_ms = int(time.time() * 1000)
        detections = detect(frame, first_seen, now_ms)
        live_ids = {int(item["id"].split("-")[-1]) for item in detections}
        for marker_id in list(first_seen):
            if marker_id not in live_ids and now_ms - first_seen[marker_id] > 60_000:
                del first_seen[marker_id]
        print(
            json.dumps(
                {
                    "type": "landing-vision.snapshot",
                    "timestamp": now_ms,
                    "source": "opencv-apriltag-36h11",
                    "detections": detections,
                },
                separators=(",", ":"),
            ),
            flush=True,
        )

    if capture is not None:
        capture.release()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
