#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <csignal>
#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <limits>
#include <mutex>
#include <optional>
#include <sstream>
#include <string>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

#include <Eigen/Core>
#include <nlohmann/json.hpp>
#include <opencv2/core.hpp>
#include <opencv2/dnn.hpp>
#include <opencv2/imgproc.hpp>
#include <opencv2/videoio.hpp>

#include "MapPoint.h"
#include "System.h"
#include "Tracking.h"

using json = nlohmann::json;
using Clock = std::chrono::steady_clock;

namespace {

constexpr double kPi = 3.14159265358979323846;
std::atomic<bool> g_alive{true};

void onSignal(int) { g_alive.store(false); }

std::string envString(const char* name, const std::string& fallback = {}) {
  const char* value = std::getenv(name);
  return value && *value ? std::string(value) : fallback;
}

int envInt(const char* name, int fallback) {
  try {
    return std::stoi(envString(name, std::to_string(fallback)));
  } catch (...) {
    return fallback;
  }
}

double envDouble(const char* name, double fallback) {
  try {
    return std::stod(envString(name, std::to_string(fallback)));
  } catch (...) {
    return fallback;
  }
}

bool envBool(const char* name, bool fallback) {
  const std::string raw = envString(name, fallback ? "true" : "false");
  return raw == "1" || raw == "true" || raw == "TRUE" || raw == "yes" || raw == "on";
}

std::int64_t epochMillis() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

double steadySeconds() {
  return std::chrono::duration<double>(Clock::now().time_since_epoch()).count();
}

struct Telemetry {
  double altitude = 0;
  double speedX = 0;
  double speedY = 0;
  double speedZ = 0;
  std::int64_t updatedAt = 0;
};

struct RuntimeControl {
  std::mutex mutex;
  std::condition_variable condition;
  std::string videoUrl;
  Telemetry telemetry;
  bool started = false;
  bool resetRequested = false;
  bool stopRequested = false;
  bool requireCalibration = true;
};

struct Pose {
  double x = 0;
  double y = 0;
  double z = 0;
  double roll = 0;
  double pitch = 0;
  double yaw = 0;
};

json poseJson(const Pose& pose) {
  return {{"x", pose.x},       {"y", pose.y},       {"z", pose.z},
          {"roll", pose.roll}, {"pitch", pose.pitch}, {"yaw", pose.yaw}};
}

Pose convertPose(const Sophus::SE3f& tcw, double scale, const std::optional<Telemetry>& telemetry) {
  const Sophus::SE3f twc = tcw.inverse();
  const Eigen::Matrix3f rotation = twc.rotationMatrix();
  const Eigen::Vector3f translation = twc.translation();
  Pose pose;
  // ORB camera coordinates are X right, Y down, Z forward. Dashboard coordinates are X right,
  // Y forward, Z up.
  pose.x = static_cast<double>(translation.x()) * scale;
  pose.y = static_cast<double>(translation.z()) * scale;
  pose.z = -static_cast<double>(translation.y()) * scale;
  if (telemetry && epochMillis() - telemetry->updatedAt < 1500) pose.z = telemetry->altitude;
  pose.yaw = std::atan2(rotation(0, 2), rotation(2, 2));
  pose.pitch = std::asin(std::clamp(-static_cast<double>(rotation(1, 2)), -1.0, 1.0));
  pose.roll = std::atan2(rotation(1, 0), rotation(1, 1));
  return pose;
}

struct DetectionTrack {
  std::string id;
  std::string label;
  cv::Rect2f box;
  float confidence = 0;
  std::int64_t firstSeenAt = 0;
  std::int64_t lastSeenAt = 0;
};

float intersectionOverUnion(const cv::Rect2f& a, const cv::Rect2f& b) {
  const float area = (a & b).area();
  const float total = a.area() + b.area() - area;
  return total > 0 ? area / total : 0;
}

const std::vector<std::string>& cocoLabels() {
  static const std::vector<std::string> labels = {
      "person",       "bicycle",      "car",           "motorcycle", "airplane",
      "bus",          "train",        "truck",         "boat",       "traffic light",
      "fire hydrant", "stop sign",    "parking meter", "bench",      "bird",
      "cat",          "dog",          "horse",         "sheep",      "cow",
      "elephant",     "bear",         "zebra",         "giraffe",    "backpack",
      "umbrella",     "handbag",      "tie",           "suitcase",   "frisbee",
      "skis",         "snowboard",    "sports ball",   "kite",       "baseball bat",
      "baseball glove", "skateboard", "surfboard",     "tennis racket", "bottle",
      "wine glass",   "cup",          "fork",          "knife",      "spoon",
      "bowl",         "banana",       "apple",         "sandwich",   "orange",
      "broccoli",     "carrot",       "hot dog",       "pizza",      "donut",
      "cake",         "chair",        "couch",         "potted plant", "bed",
      "dining table", "toilet",       "tv",            "laptop",     "mouse",
      "remote",       "keyboard",     "cell phone",    "microwave",  "oven",
      "toaster",      "sink",         "refrigerator",  "book",       "clock",
      "vase",         "scissors",     "teddy bear",    "hair drier", "toothbrush"};
  return labels;
}

class YoloXDetector {
 public:
  explicit YoloXDetector(const std::string& modelPath)
      : inputSize_(envInt("YOLOX_INPUT_SIZE", 416)),
        confidenceThreshold_(static_cast<float>(envDouble("YOLOX_CONFIDENCE", 0.35))),
        nmsThreshold_(static_cast<float>(envDouble("YOLOX_NMS", 0.45))),
        outputDecoded_(envBool("YOLOX_OUTPUT_DECODED", false)) {
    if (modelPath.empty() || !std::filesystem::exists(modelPath)) return;
    net_ = cv::dnn::readNetFromONNX(modelPath);
    net_.setPreferableBackend(cv::dnn::DNN_BACKEND_OPENCV);
    net_.setPreferableTarget(cv::dnn::DNN_TARGET_CPU);
    ready_ = !net_.empty();
  }

  bool ready() const { return ready_; }
  double lastInferenceMs() const { return lastInferenceMs_; }

  std::vector<DetectionTrack> detect(const cv::Mat& frame, std::int64_t now) {
    if (!ready_ || frame.empty()) return {};
    const auto started = Clock::now();
    const float ratio = std::min(static_cast<float>(inputSize_) / frame.cols,
                                 static_cast<float>(inputSize_) / frame.rows);
    const int resizedWidth = std::max(1, static_cast<int>(std::round(frame.cols * ratio)));
    const int resizedHeight = std::max(1, static_cast<int>(std::round(frame.rows * ratio)));
    cv::Mat resized;
    cv::resize(frame, resized, cv::Size(resizedWidth, resizedHeight));
    cv::Mat padded(inputSize_, inputSize_, CV_8UC3, cv::Scalar(114, 114, 114));
    resized.copyTo(padded(cv::Rect(0, 0, resized.cols, resized.rows)));
    cv::Mat blob = cv::dnn::blobFromImage(padded, 1.0, cv::Size(inputSize_, inputSize_),
                                          cv::Scalar(), false, false, CV_32F);
    net_.setInput(blob);
    cv::Mat output = net_.forward();
    cv::Mat rows = flattenOutput(output);
    if (rows.empty() || rows.cols < 85) return {};
    if (!outputDecoded_) decodeRows(rows);

    std::vector<cv::Rect> boxes;
    std::vector<float> scores;
    std::vector<int> classes;
    for (int row = 0; row < rows.rows; ++row) {
      const float* values = rows.ptr<float>(row);
      const float objectness = values[4];
      if (objectness < confidenceThreshold_) continue;
      int bestClass = 0;
      float bestClassScore = 0;
      for (int cls = 0; cls < 80; ++cls) {
        if (values[5 + cls] > bestClassScore) {
          bestClassScore = values[5 + cls];
          bestClass = cls;
        }
      }
      const float score = objectness * bestClassScore;
      if (score < confidenceThreshold_) continue;
      const float centerX = values[0] / ratio;
      const float centerY = values[1] / ratio;
      const float width = values[2] / ratio;
      const float height = values[3] / ratio;
      const int left = std::clamp(static_cast<int>(centerX - width / 2), 0, frame.cols - 1);
      const int top = std::clamp(static_cast<int>(centerY - height / 2), 0, frame.rows - 1);
      const int right = std::clamp(static_cast<int>(centerX + width / 2), left + 1, frame.cols);
      const int bottom = std::clamp(static_cast<int>(centerY + height / 2), top + 1, frame.rows);
      boxes.emplace_back(left, top, right - left, bottom - top);
      scores.push_back(score);
      classes.push_back(bestClass);
    }

    std::vector<int> kept;
    cv::dnn::NMSBoxes(boxes, scores, confidenceThreshold_, nmsThreshold_, kept);
    std::vector<DetectionTrack> candidates;
    candidates.reserve(kept.size());
    for (int index : kept) {
      DetectionTrack candidate;
      candidate.label = cocoLabels().at(static_cast<std::size_t>(classes[index]));
      candidate.box = cv::Rect2f(boxes[index]);
      candidate.confidence = scores[index];
      candidate.firstSeenAt = now;
      candidate.lastSeenAt = now;
      candidates.push_back(candidate);
    }
    assignTrackIds(candidates, now);
    lastInferenceMs_ = std::chrono::duration<double, std::milli>(Clock::now() - started).count();
    return candidates;
  }

 private:
  cv::Mat flattenOutput(cv::Mat output) const {
    if (output.empty()) return {};
    if (output.dims == 3) {
      cv::Mat rows(output.size[1], output.size[2], CV_32F, output.ptr<float>());
      if (rows.cols == 85) return rows.clone();
      if (rows.rows == 85) {
        cv::Mat transposed;
        cv::transpose(rows, transposed);
        return transposed;
      }
    }
    if (output.dims == 2) {
      if (output.cols == 85) return output;
      if (output.rows == 85) {
        cv::Mat transposed;
        cv::transpose(output, transposed);
        return transposed;
      }
    }
    return {};
  }

  void decodeRows(cv::Mat& rows) const {
    int row = 0;
    for (int stride : {8, 16, 32}) {
      const int grid = inputSize_ / stride;
      for (int y = 0; y < grid && row < rows.rows; ++y) {
        for (int x = 0; x < grid && row < rows.rows; ++x, ++row) {
          float* values = rows.ptr<float>(row);
          values[0] = (values[0] + x) * stride;
          values[1] = (values[1] + y) * stride;
          values[2] = std::exp(std::clamp(values[2], -10.0F, 10.0F)) * stride;
          values[3] = std::exp(std::clamp(values[3], -10.0F, 10.0F)) * stride;
        }
      }
    }
  }

  void assignTrackIds(std::vector<DetectionTrack>& candidates, std::int64_t now) {
    std::vector<bool> used(previous_.size(), false);
    for (auto& candidate : candidates) {
      float bestIou = 0.25F;
      int best = -1;
      for (std::size_t index = 0; index < previous_.size(); ++index) {
        if (used[index] || previous_[index].label != candidate.label) continue;
        const float iou = intersectionOverUnion(previous_[index].box, candidate.box);
        if (iou > bestIou) {
          bestIou = iou;
          best = static_cast<int>(index);
        }
      }
      if (best >= 0) {
        used[best] = true;
        candidate.id = previous_[best].id;
        candidate.firstSeenAt = previous_[best].firstSeenAt;
      } else {
        candidate.id = candidate.label + "-" + std::to_string(nextTrackId_++);
      }
      candidate.lastSeenAt = now;
    }
    previous_ = candidates;
  }

  cv::dnn::Net net_;
  bool ready_ = false;
  int inputSize_;
  float confidenceThreshold_;
  float nmsThreshold_;
  bool outputDecoded_;
  double lastInferenceMs_ = 0;
  std::uint64_t nextTrackId_ = 1;
  std::vector<DetectionTrack> previous_;
};

json detectionJson(const DetectionTrack& detection, const cv::Size& frameSize,
                   const std::optional<Pose>& pose) {
  const double x = std::clamp(detection.box.x / frameSize.width, 0.0F, 1.0F);
  const double y = std::clamp(detection.box.y / frameSize.height, 0.0F, 1.0F);
  const double width = std::clamp(detection.box.width / frameSize.width, 0.0001F, 1.0F - x);
  const double height = std::clamp(detection.box.height / frameSize.height, 0.0001F, 1.0F - y);
  json result = {{"id", detection.id},
                 {"label", detection.label},
                 {"recognizedName", detection.label},
                 {"confidence", detection.confidence},
                 {"bbox", {{"x", x}, {"y", y}, {"width", width}, {"height", height}}},
                 {"firstSeenAt", detection.firstSeenAt},
                 {"lastSeenAt", detection.lastSeenAt}};
  if (pose && envBool("OBJECT_POSITION_ESTIMATE", false)) {
    const double horizontalFov = envDouble("CAMERA_HORIZONTAL_FOV_DEGREES", 90) * kPi / 180.0;
    const double center = x + width / 2.0;
    const double angle = (center - 0.5) * horizontalFov;
    const double range = envDouble("OBJECT_RANGE_ESTIMATE_METERS", 2.5);
    result["worldPosition"] = {{"x", pose->x + range * std::sin(pose->yaw + angle)},
                               {"y", pose->y + range * std::cos(pose->yaw + angle)},
                               {"z", 0.0}};
  }
  return result;
}

json boundsFor(const std::vector<Pose>& trajectory, const json& landmarks) {
  double minX = std::numeric_limits<double>::infinity();
  double maxX = -std::numeric_limits<double>::infinity();
  double minY = std::numeric_limits<double>::infinity();
  double maxY = -std::numeric_limits<double>::infinity();
  double minZ = std::numeric_limits<double>::infinity();
  double maxZ = -std::numeric_limits<double>::infinity();
  auto include = [&](double x, double y, double z) {
    minX = std::min(minX, x); maxX = std::max(maxX, x);
    minY = std::min(minY, y); maxY = std::max(maxY, y);
    minZ = std::min(minZ, z); maxZ = std::max(maxZ, z);
  };
  for (const auto& pose : trajectory) include(pose.x, pose.y, pose.z);
  for (const auto& landmark : landmarks) {
    const auto& p = landmark["position"];
    include(p["x"].get<double>(), p["y"].get<double>(), p["z"].get<double>());
  }
  if (!std::isfinite(minX)) return {{"minX", -5}, {"maxX", 5}, {"minY", -5}, {"maxY", 5}, {"minZ", -1}, {"maxZ", 3}};
  const double padding = std::max(0.5, std::max(maxX - minX, maxY - minY) * 0.08);
  if (maxX - minX < 0.1) { minX -= 1; maxX += 1; }
  if (maxY - minY < 0.1) { minY -= 1; maxY += 1; }
  if (maxZ - minZ < 0.1) { minZ -= 0.5; maxZ += 0.5; }
  return {{"minX", minX - padding}, {"maxX", maxX + padding},
          {"minY", minY - padding}, {"maxY", maxY + padding},
          {"minZ", minZ}, {"maxZ", maxZ}};
}

std::string trackingStateName(int state) {
  if (state == ORB_SLAM3::Tracking::OK || state == ORB_SLAM3::Tracking::OK_KLT) return "tracking";
  if (state == ORB_SLAM3::Tracking::RECENTLY_LOST || state == ORB_SLAM3::Tracking::LOST) return "lost";
  return "initializing";
}

void readControl(RuntimeControl& control) {
  std::string line;
  while (g_alive.load() && std::getline(std::cin, line)) {
    if (line.empty()) continue;
    try {
      const json message = json::parse(line);
      const std::string type = message.value("type", "");
      std::lock_guard<std::mutex> lock(control.mutex);
      if (type == "start") {
        control.videoUrl = message.value("videoUrl", "");
        control.requireCalibration = message.value("slam", json::object()).value("requireCalibration", true);
        control.started = true;
        control.stopRequested = false;
        control.condition.notify_all();
      } else if (type == "stop") {
        control.stopRequested = true;
        g_alive.store(false);
        control.condition.notify_all();
      } else if (type == "reset") {
        control.resetRequested = true;
      } else if (type == "telemetry" && message.contains("telemetry")) {
        const json& telemetry = message["telemetry"];
        control.telemetry.altitude = telemetry.value("altitude", 0.0);
        control.telemetry.speedX = telemetry.value("speedX", 0.0);
        control.telemetry.speedY = telemetry.value("speedY", 0.0);
        control.telemetry.speedZ = telemetry.value("speedZ", 0.0);
        control.telemetry.updatedAt = telemetry.value("updatedAt", std::int64_t{0});
      }
    } catch (const std::exception& error) {
      std::cerr << "Ignoring invalid control message: " << error.what() << '\n';
    }
  }
}

json selfTestSnapshot() {
  const auto now = epochMillis();
  return {{"type", "perception.snapshot"},
          {"snapshot",
           {{"sequence", 1},
            {"timestamp", now},
            {"backend", "external"},
            {"source", "orb-slam3-yolox-self-test"},
            {"trackingState", "tracking"},
            {"calibrated", true},
            {"scaleSource", "monocular"},
            {"pose", {{"x", 0}, {"y", 0}, {"z", 0}, {"roll", 0}, {"pitch", 0}, {"yaw", 0}}},
            {"trajectory", json::array()},
            {"detections", json::array()},
            {"map", {{"bounds", {{"minX", -1}, {"maxX", 1}, {"minY", -1}, {"maxY", 1}, {"minZ", -1}, {"maxZ", 1}}},
                     {"landmarks", json::array()}}},
            {"metrics", {{"inputFps", 0}, {"slamFps", 0}, {"detectionFps", 0}, {"inferenceMs", 0},
                         {"endToEndLatencyMs", 0}, {"trackedFeatures", 0}, {"keyframes", 0}, {"loopClosures", 0}}}}}};
}

}  // namespace

int main(int argc, char** argv) {
  std::signal(SIGINT, onSignal);
  std::signal(SIGTERM, onSignal);

  // ORB-SLAM3 writes diagnostics to stdout. Preserve the original stdout stream exclusively for
  // newline-delimited protocol messages and redirect library chatter to stderr.
  std::streambuf* protocolBuffer = std::cout.rdbuf();
  std::ostream protocol(protocolBuffer);
  std::cout.rdbuf(std::cerr.rdbuf());

  if (argc > 1 && std::string(argv[1]) == "--self-test") {
    protocol << selfTestSnapshot().dump() << '\n' << std::flush;
    return 0;
  }

  const std::string vocabulary = envString("ORB_VOCABULARY", "/opt/ORB_SLAM3/Vocabulary/ORBvoc.txt");
  const std::string settings = envString("ORB_SETTINGS", "/config/bebop2.yaml");
  const std::string model = envString("YOLOX_MODEL", "/models/yolox_tiny.onnx");
  const bool calibrated = envBool("PERCEPTION_CAMERA_CALIBRATED", false);
  if (!std::filesystem::exists(vocabulary)) {
    std::cerr << "ORB vocabulary not found: " << vocabulary << '\n';
    return 2;
  }
  if (!std::filesystem::exists(settings)) {
    std::cerr << "ORB camera settings not found: " << settings << '\n';
    return 2;
  }

  RuntimeControl control;
  std::thread controlThread(readControl, std::ref(control));
  controlThread.detach();
  {
    std::unique_lock<std::mutex> lock(control.mutex);
    control.condition.wait(lock, [&] { return control.started || !g_alive.load(); });
    if (!g_alive.load()) return 0;
    if (control.requireCalibration && !calibrated && !envBool("PERCEPTION_ALLOW_UNCALIBRATED", false)) {
      std::cerr << "Camera calibration gate blocked startup. Set ORB_SETTINGS to the measured Bebop stream calibration and PERCEPTION_CAMERA_CALIBRATED=true.\n";
      return 3;
    }
  }

  std::string videoUrl;
  {
    std::lock_guard<std::mutex> lock(control.mutex);
    videoUrl = control.videoUrl;
  }
  if (videoUrl.empty()) {
    std::cerr << "The start command did not include videoUrl\n";
    return 4;
  }

  ORB_SLAM3::System slam(vocabulary, settings, ORB_SLAM3::System::MONOCULAR, false);
  YoloXDetector detector(model);
  if (!detector.ready()) std::cerr << "YOLOX model unavailable; SLAM will run without detections: " << model << '\n';

  cv::VideoCapture capture;
  capture.open(videoUrl, cv::CAP_FFMPEG);
  if (!capture.isOpened()) capture.open(videoUrl);
  capture.set(cv::CAP_PROP_BUFFERSIZE, 1);
  if (!capture.isOpened()) {
    std::cerr << "Unable to open perception video source: " << videoUrl << '\n';
    slam.Shutdown();
    return 5;
  }

  const int updateHz = std::clamp(envInt("PERCEPTION_OUTPUT_HZ", 10), 1, 30);
  const int detectEvery = std::max(1, envInt("DETECTION_EVERY_N_FRAMES", 3));
  const std::size_t maxTrajectory = static_cast<std::size_t>(std::max(30, envInt("MAX_TRAJECTORY_POINTS", 900)));
  const std::size_t maxLandmarks = static_cast<std::size_t>(std::max(100, envInt("MAX_LANDMARKS", 2500)));
  const auto outputInterval = std::chrono::milliseconds(1000 / updateHz);
  auto lastOutput = Clock::now() - outputInterval;
  auto lastFrame = Clock::now();
  double inputFps = 0;
  double detectionFps = 0;
  std::uint64_t sequence = 0;
  std::uint64_t frameNumber = 0;
  std::uint64_t loopClosures = 0;
  std::vector<Pose> trajectory;
  std::vector<DetectionTrack> detections;

  while (g_alive.load()) {
    {
      std::lock_guard<std::mutex> lock(control.mutex);
      if (control.stopRequested) break;
      if (control.resetRequested) {
        slam.Reset();
        trajectory.clear();
        detections.clear();
        control.resetRequested = false;
      }
    }

    cv::Mat frame;
    const auto frameStarted = Clock::now();
    if (!capture.read(frame) || frame.empty()) {
      std::cerr << "Video frame read failed\n";
      if (videoUrl.rfind("http", 0) == 0) {
        capture.release();
        std::this_thread::sleep_for(std::chrono::milliseconds(300));
        capture.open(videoUrl, cv::CAP_FFMPEG);
        capture.set(cv::CAP_PROP_BUFFERSIZE, 1);
        continue;
      }
      break;
    }
    const double frameSeconds = std::chrono::duration<double>(frameStarted - lastFrame).count();
    lastFrame = frameStarted;
    if (frameSeconds > 0) inputFps = inputFps == 0 ? 1.0 / frameSeconds : inputFps * 0.9 + (1.0 / frameSeconds) * 0.1;

    const auto slamStarted = Clock::now();
    const Sophus::SE3f tcw = slam.TrackMonocular(frame, steadySeconds());
    const double slamMs = std::chrono::duration<double, std::milli>(Clock::now() - slamStarted).count();
    const int state = slam.GetTrackingState();
    const bool tracking = state == ORB_SLAM3::Tracking::OK || state == ORB_SLAM3::Tracking::OK_KLT;
    std::optional<Telemetry> telemetry;
    {
      std::lock_guard<std::mutex> lock(control.mutex);
      telemetry = control.telemetry;
    }
    std::optional<Pose> pose;
    if (tracking) {
      pose = convertPose(tcw, 1.0, telemetry);
      trajectory.push_back(*pose);
      if (trajectory.size() > maxTrajectory) trajectory.erase(trajectory.begin(), trajectory.begin() + (trajectory.size() - maxTrajectory));
    }
    if (slam.MapChanged()) ++loopClosures;

    if (frameNumber % static_cast<std::uint64_t>(detectEvery) == 0 && detector.ready()) {
      detections = detector.detect(frame, epochMillis());
      if (detector.lastInferenceMs() > 0) detectionFps = 1000.0 / detector.lastInferenceMs();
    }
    ++frameNumber;

    const auto nowSteady = Clock::now();
    if (nowSteady - lastOutput < outputInterval) continue;
    lastOutput = nowSteady;

    json landmarks = json::array();
    std::unordered_map<unsigned long, bool> seen;
    for (ORB_SLAM3::MapPoint* point : slam.GetTrackedMapPoints()) {
      if (!point || point->isBad() || seen[point->mnId]) continue;
      seen[point->mnId] = true;
      const Eigen::Vector3f world = point->GetWorldPos();
      landmarks.push_back({{"id", "mp-" + std::to_string(point->mnId)},
                           {"position", {{"x", world.x()}, {"y", world.z()}, {"z", -world.y()}}},
                           {"observations", std::max(0, point->Observations())},
                           {"quality", std::clamp(static_cast<double>(point->GetFoundRatio()), 0.0, 1.0)}});
      if (landmarks.size() >= maxLandmarks) break;
    }

    json trajectoryJson = json::array();
    for (const auto& item : trajectory) trajectoryJson.push_back(poseJson(item));
    json detectionArray = json::array();
    for (const auto& item : detections) detectionArray.push_back(detectionJson(item, frame.size(), pose));
    const auto timestamp = epochMillis();
    const double latencyMs = std::chrono::duration<double, std::milli>(Clock::now() - frameStarted).count();
    json snapshot = {{"sequence", ++sequence},
                     {"timestamp", timestamp},
                     {"backend", "external"},
                     {"source", detector.ready() ? "orb-slam3-yolox-opencv" : "orb-slam3"},
                     {"trackingState", trackingStateName(state)},
                     {"calibrated", calibrated},
                     {"scaleSource", "monocular"},
                     {"pose", pose ? poseJson(*pose) : json(nullptr)},
                     {"trajectory", trajectoryJson},
                     {"detections", detectionArray},
                     {"map", {{"bounds", boundsFor(trajectory, landmarks)}, {"landmarks", landmarks}}},
                     {"metrics", {{"inputFps", inputFps},
                                  {"slamFps", slamMs > 0 ? 1000.0 / slamMs : 0.0},
                                  {"detectionFps", detectionFps},
                                  {"inferenceMs", detector.lastInferenceMs()},
                                  {"endToEndLatencyMs", latencyMs},
                                  {"trackedFeatures", static_cast<int>(slam.GetTrackedKeyPointsUn().size())},
                                  {"keyframes", 0},
                                  {"loopClosures", loopClosures}}}};
    protocol << json({{"type", "perception.snapshot"}, {"snapshot", snapshot}}).dump() << '\n' << std::flush;
  }

  capture.release();
  slam.Shutdown();
  return 0;
}
