#!/usr/bin/env python3
"""YOLOX detection, motion/appearance tracking, and compact visual descriptors."""

from __future__ import annotations

import argparse
import json
import math
import os
import signal
import sys
import time
from dataclasses import dataclass

import cv2
import numpy as np

ALIVE = True
COCO_LABELS = [
    "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat",
    "traffic light", "fire hydrant", "stop sign", "parking meter", "bench", "bird", "cat", "dog",
    "horse", "sheep", "cow", "elephant", "bear", "zebra", "giraffe", "backpack", "umbrella",
    "handbag", "tie", "suitcase", "frisbee", "skis", "snowboard", "sports ball", "kite",
    "baseball bat", "baseball glove", "skateboard", "surfboard", "tennis racket", "bottle",
    "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana", "apple", "sandwich",
    "orange", "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair", "couch",
    "potted plant", "bed", "dining table", "toilet", "tv", "laptop", "mouse", "remote",
    "keyboard", "cell phone", "microwave", "oven", "toaster", "sink", "refrigerator", "book",
    "clock", "vase", "scissors", "teddy bear", "hair drier", "toothbrush",
]


def env_int(name: str, fallback: int) -> int:
    try:
        return int(os.environ.get(name, fallback))
    except ValueError:
        return fallback


def env_float(name: str, fallback: float) -> float:
    try:
        return float(os.environ.get(name, fallback))
    except ValueError:
        return fallback


def epoch_ms() -> int:
    return int(time.time() * 1000)


def stop(_signum: int, _frame: object) -> None:
    global ALIVE
    ALIVE = False


def normalize(values: np.ndarray) -> np.ndarray:
    vector = values.astype(np.float32).reshape(-1)
    norm = float(np.linalg.norm(vector))
    return vector / norm if math.isfinite(norm) and norm > 1e-8 else np.zeros_like(vector)


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    if a.shape != b.shape or a.size == 0:
        return -1.0
    return float(np.clip(np.dot(a, b), -1.0, 1.0))


def appearance_descriptor(frame: np.ndarray, box: np.ndarray) -> np.ndarray:
    height, width = frame.shape[:2]
    x, y, w, h = [int(round(float(value))) for value in box]
    x, y = max(0, min(width - 1, x)), max(0, min(height - 1, y))
    w, h = max(1, min(width - x, w)), max(1, min(height - y, h))
    crop = frame[y:y + h, x:x + w]
    if crop.size == 0:
        return np.zeros(496, dtype=np.float32)
    patch = cv2.resize(crop, (96, 96), interpolation=cv2.INTER_AREA)

    hsv = cv2.cvtColor(patch, cv2.COLOR_BGR2HSV)
    color = normalize(cv2.calcHist([hsv], [0, 1], None, [12, 8], [0, 180, 0, 256]))

    gray = cv2.cvtColor(patch, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
    gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    magnitude, angle = cv2.cartToPolar(gx, gy, angleInDegrees=True)
    angle %= 180.0
    cells = []
    for cell_y in range(4):
        for cell_x in range(4):
            ys = slice(cell_y * 24, (cell_y + 1) * 24)
            xs = slice(cell_x * 24, (cell_x + 1) * 24)
            bins = np.floor(angle[ys, xs] / 20.0).astype(np.int32)
            weights = magnitude[ys, xs]
            hist = np.asarray([float(weights[bins == bucket].sum()) for bucket in range(9)], dtype=np.float32)
            cells.append(normalize(hist))
    hog = np.concatenate(cells)

    orb = cv2.ORB_create(nfeatures=96, edgeThreshold=8, patchSize=21, fastThreshold=8)
    _keypoints, descriptors = orb.detectAndCompute((gray * 255).astype(np.uint8), None)
    orb_bits = np.zeros(256, dtype=np.float32) if descriptors is None else normalize(
        np.unpackbits(descriptors, axis=1).astype(np.float32).mean(axis=0)
    )
    return normalize(np.concatenate([color, hog, orb_bits]))


def intersection_over_union(a: np.ndarray, b: np.ndarray) -> float:
    ax1, ay1, aw, ah = a
    bx1, by1, bw, bh = b
    ax2, ay2, bx2, by2 = ax1 + aw, ay1 + ah, bx1 + bw, by1 + bh
    x1, y1, x2, y2 = max(ax1, bx1), max(ay1, by1), min(ax2, bx2), min(ay2, by2)
    intersection = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    union = aw * ah + bw * bh - intersection
    return float(intersection / union) if union > 0 else 0.0


@dataclass
class Track:
    track_id: str
    label: str
    box: np.ndarray
    velocity: np.ndarray
    appearance: np.ndarray
    confidence: float
    first_seen_at: int
    last_seen_at: int
    age_frames: int = 1
    hits: int = 1
    misses: int = 0

    @property
    def state(self) -> str:
        return "confirmed" if self.hits >= 3 else "tentative"

    def predicted_box(self) -> np.ndarray:
        predicted = self.box.copy()
        predicted += self.velocity
        predicted[2:] = np.maximum(1.0, predicted[2:])
        return predicted


class AppearanceTracker:
    def __init__(self, maximum_misses: int = 12) -> None:
        self.maximum_misses = maximum_misses
        self.tracks: list[Track] = []
        self.next_id = 1

    def update(self, detections: list[dict]) -> list[dict]:
        for track in self.tracks:
            track.age_frames += 1
            track.misses += 1

        pairs = []
        for track_index, track in enumerate(self.tracks):
            predicted = track.predicted_box()
            for detection_index, detection in enumerate(detections):
                if track.label != detection["label"]:
                    continue
                overlap = intersection_over_union(predicted, detection["box"])
                similarity = cosine(track.appearance, detection["appearance"])
                if overlap < 0.03 and similarity < 0.72:
                    continue
                score = 0.58 * overlap + 0.42 * max(0.0, similarity)
                if score >= 0.24:
                    pairs.append((score, track_index, detection_index))
        pairs.sort(reverse=True)

        used_tracks: set[int] = set()
        used_detections: set[int] = set()
        for _score, track_index, detection_index in pairs:
            if track_index in used_tracks or detection_index in used_detections:
                continue
            track = self.tracks[track_index]
            detection = detections[detection_index]
            delta = detection["box"] - track.box
            track.velocity = track.velocity * 0.65 + delta * 0.35
            track.box = detection["box"]
            track.appearance = normalize(track.appearance * 0.7 + detection["appearance"] * 0.3)
            track.confidence = detection["confidence"]
            track.last_seen_at = detection["timestamp"]
            track.hits += 1
            track.misses = 0
            detection["track"] = track
            used_tracks.add(track_index)
            used_detections.add(detection_index)

        for index, detection in enumerate(detections):
            if index in used_detections:
                continue
            now = detection["timestamp"]
            track = Track(
                track_id=f'{detection["label"]}-{self.next_id}',
                label=detection["label"],
                box=detection["box"],
                velocity=np.zeros(4, dtype=np.float32),
                appearance=detection["appearance"],
                confidence=detection["confidence"],
                first_seen_at=now,
                last_seen_at=now,
            )
            self.next_id += 1
            self.tracks.append(track)
            detection["track"] = track

        self.tracks = [track for track in self.tracks if track.misses <= self.maximum_misses]
        return [detection for detection in detections if "track" in detection]


class YoloXDetector:
    def __init__(self, model_path: str) -> None:
        self.input_size = max(160, env_int("YOLOX_INPUT_SIZE", 416))
        self.confidence = env_float("YOLOX_CONFIDENCE", 0.35)
        self.low_confidence = min(self.confidence, env_float("YOLOX_LOW_CONFIDENCE", 0.2))
        self.nms = env_float("YOLOX_NMS", 0.45)
        self.output_decoded = os.environ.get("YOLOX_OUTPUT_DECODED", "false").lower() in {"1", "true", "yes", "on"}
        self.net = cv2.dnn.readNetFromONNX(model_path)
        self.net.setPreferableBackend(cv2.dnn.DNN_BACKEND_OPENCV)
        self.net.setPreferableTarget(cv2.dnn.DNN_TARGET_CPU)
        self.last_inference_ms = 0.0

    def flatten(self, output: np.ndarray) -> np.ndarray:
        rows = np.asarray(output)
        while rows.ndim > 2 and rows.shape[0] == 1:
            rows = rows[0]
        if rows.ndim != 2:
            return np.empty((0, 85), dtype=np.float32)
        return rows.astype(np.float32) if rows.shape[1] == 85 else rows.T.astype(np.float32) if rows.shape[0] == 85 else np.empty((0, 85), dtype=np.float32)

    def decode(self, rows: np.ndarray) -> None:
        row = 0
        for stride in (8, 16, 32):
            grid = self.input_size // stride
            for y in range(grid):
                for x in range(grid):
                    if row >= len(rows):
                        return
                    rows[row, 0] = (rows[row, 0] + x) * stride
                    rows[row, 1] = (rows[row, 1] + y) * stride
                    rows[row, 2] = math.exp(float(np.clip(rows[row, 2], -10, 10))) * stride
                    rows[row, 3] = math.exp(float(np.clip(rows[row, 3], -10, 10))) * stride
                    row += 1

    def detect(self, frame: np.ndarray, timestamp: int) -> list[dict]:
        started = time.perf_counter()
        frame_height, frame_width = frame.shape[:2]
        ratio = min(self.input_size / frame_width, self.input_size / frame_height)
        resized = cv2.resize(frame, (max(1, round(frame_width * ratio)), max(1, round(frame_height * ratio))))
        padded = np.full((self.input_size, self.input_size, 3), 114, dtype=np.uint8)
        padded[:resized.shape[0], :resized.shape[1]] = resized
        self.net.setInput(cv2.dnn.blobFromImage(padded, 1.0, (self.input_size, self.input_size)))
        rows = self.flatten(self.net.forward())
        if not self.output_decoded:
            self.decode(rows)

        boxes, scores, classes = [], [], []
        for values in rows:
            objectness = float(values[4])
            if objectness < self.low_confidence:
                continue
            class_index = int(np.argmax(values[5:85]))
            score = objectness * float(values[5 + class_index])
            if score < self.low_confidence:
                continue
            center_x, center_y, width, height = [float(value) / ratio for value in values[:4]]
            left = max(0, min(frame_width - 1, int(center_x - width / 2)))
            top = max(0, min(frame_height - 1, int(center_y - height / 2)))
            right = max(left + 1, min(frame_width, int(center_x + width / 2)))
            bottom = max(top + 1, min(frame_height, int(center_y + height / 2)))
            boxes.append([left, top, right - left, bottom - top])
            scores.append(score)
            classes.append(class_index)

        kept = cv2.dnn.NMSBoxes(boxes, scores, self.low_confidence, self.nms)
        detections = []
        for raw_index in np.asarray(kept).reshape(-1) if len(kept) else []:
            index = int(raw_index)
            box = np.asarray(boxes[index], dtype=np.float32)
            detections.append({
                "label": COCO_LABELS[classes[index]],
                "confidence": float(scores[index]),
                "box": box,
                "appearance": appearance_descriptor(frame, box),
                "timestamp": timestamp,
            })
        self.last_inference_ms = (time.perf_counter() - started) * 1000.0
        return detections


def serialize(detection: dict, frame: np.ndarray) -> dict:
    track: Track = detection["track"]
    height, width = frame.shape[:2]
    x, y, box_width, box_height = [float(value) for value in detection["box"]]
    nx, ny = max(0.0, min(1.0, x / width)), max(0.0, min(1.0, y / height))
    return {
        "id": track.track_id,
        "label": detection["label"],
        "confidence": detection["confidence"],
        "bbox": {
            "x": nx,
            "y": ny,
            "width": max(0.0001, min(1.0 - nx, box_width / width)),
            "height": max(0.0001, min(1.0 - ny, box_height / height)),
        },
        "firstSeenAt": track.first_seen_at,
        "lastSeenAt": track.last_seen_at,
        "appearance": [round(float(value), 7) for value in detection["appearance"]],
        "observed": True,
        "track": {
            "state": track.state,
            "ageFrames": max(1, track.age_frames),
            "hits": max(1, track.hits),
            "misses": max(0, track.misses),
        },
    }


def self_test() -> int:
    image_a = np.zeros((180, 240, 3), dtype=np.uint8)
    cv2.rectangle(image_a, (40, 30), (180, 150), (20, 40, 220), -1)
    for offset in range(0, 100, 12):
        cv2.line(image_a, (50 + offset, 40), (50, 140 - offset // 2), (240, 240, 240), 2)
    image_b = cv2.GaussianBlur(image_a, (3, 3), 0)
    image_c = np.zeros_like(image_a)
    cv2.circle(image_c, (120, 90), 55, (20, 220, 40), -1)
    box = np.asarray([35, 25, 155, 135], dtype=np.float32)
    descriptor_a = appearance_descriptor(image_a, box)
    descriptor_b = appearance_descriptor(image_b, box)
    descriptor_c = appearance_descriptor(image_c, box)

    tracker = AppearanceTracker(maximum_misses=3)
    first = tracker.update([{"label": "chair", "confidence": 0.9, "box": box.copy(), "appearance": descriptor_a, "timestamp": 1000}])[0]
    first_id = first["track"].track_id
    tracker.update([])
    tracker.update([])
    shifted = box + np.asarray([8, 2, 0, 0], dtype=np.float32)
    recovered = tracker.update([{"label": "chair", "confidence": 0.88, "box": shifted, "appearance": descriptor_b, "timestamp": 1300}])[0]
    same_similarity = cosine(descriptor_a, descriptor_b)
    different_similarity = cosine(descriptor_a, descriptor_c)
    result = {
        "ok": descriptor_a.size == 496 and same_similarity > different_similarity + 0.12 and first_id == recovered["track"].track_id,
        "descriptorLength": int(descriptor_a.size),
        "sameSimilarity": same_similarity,
        "differentSimilarity": different_similarity,
        "trackRecovered": first_id == recovered["track"].track_id,
    }
    print(json.dumps(result))
    return 0 if result["ok"] else 1


def run() -> int:
    video_url = os.environ.get("RECOGNITION_VIDEO_URL", "http://host.docker.internal:3000/video.mjpeg")
    detector = YoloXDetector(os.environ.get("YOLOX_MODEL", "/models/yolox_tiny.onnx"))
    tracker = AppearanceTracker(maximum_misses=max(2, env_int("RECOGNITION_TRACK_MAX_MISSES", 12)))
    output_hz = max(1, min(30, env_int("RECOGNITION_OUTPUT_HZ", 10)))
    detect_every = max(1, env_int("RECOGNITION_EVERY_N_FRAMES", 2))
    reconnect_ms = max(100, env_int("RECOGNITION_RECONNECT_MS", 300))
    capture = cv2.VideoCapture(video_url, cv2.CAP_FFMPEG)
    capture.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    last_output, last_frame = 0.0, time.perf_counter()
    input_fps, frame_number = 0.0, 0
    latest: list[dict] = []

    while ALIVE:
        if not capture.isOpened():
            capture.release()
            time.sleep(reconnect_ms / 1000.0)
            capture = cv2.VideoCapture(video_url, cv2.CAP_FFMPEG)
            capture.set(cv2.CAP_PROP_BUFFERSIZE, 1)
            continue
        frame_started = time.perf_counter()
        ok, frame = capture.read()
        if not ok or frame is None or frame.size == 0:
            print("Recognition video frame read failed, reconnecting", file=sys.stderr, flush=True)
            capture.release()
            continue
        interval, last_frame = frame_started - last_frame, frame_started
        if interval > 0:
            instantaneous = 1.0 / interval
            input_fps = instantaneous if input_fps == 0 else input_fps * 0.9 + instantaneous * 0.1
        if frame_number % detect_every == 0:
            latest = tracker.update(detector.detect(frame, epoch_ms()))
        frame_number += 1
        if time.perf_counter() - last_output < 1.0 / output_hz:
            continue
        last_output = time.perf_counter()
        print(json.dumps({
            "type": "recognition-vision.snapshot",
            "timestamp": epoch_ms(),
            "source": "yolox-appearance-tracker",
            "detections": [serialize(item, frame) for item in latest],
            "metrics": {
                "inputFps": input_fps,
                "detectionFps": 1000.0 / detector.last_inference_ms if detector.last_inference_ms > 0 else 0.0,
                "inferenceMs": detector.last_inference_ms,
                "endToEndLatencyMs": (time.perf_counter() - frame_started) * 1000.0,
                "activeTracks": len(tracker.tracks),
            },
        }, separators=(",", ":")), flush=True)
    capture.release()
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    return self_test() if args.self_test else run()


if __name__ == "__main__":
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    raise SystemExit(main())
