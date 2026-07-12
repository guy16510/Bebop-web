#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>
#include <opencv2/core.hpp>
#include <opencv2/dnn.hpp>
#include <opencv2/imgproc.hpp>

#include "System.h"
#include "Tracking.h"

using json = nlohmann::json;

namespace {

std::string envString(const char* name, const std::string& fallback) {
  const char* value = std::getenv(name);
  return value && *value ? std::string(value) : fallback;
}

struct SyntheticPoint {
  cv::Point3f world;
  int pattern = 0;
};

const std::vector<SyntheticPoint>& syntheticCloud() {
  static const std::vector<SyntheticPoint> cloud = [] {
    std::vector<SyntheticPoint> points;
    points.reserve(900);
    cv::RNG random(0xBEB02);
    for (int index = 0; index < 900; ++index) {
      SyntheticPoint point;
      point.world.x = random.uniform(-5.0F, 5.0F);
      point.world.y = random.uniform(-2.8F, 2.8F);
      point.world.z = random.uniform(3.0F, 12.0F);
      point.pattern = random.uniform(0, 16);
      points.push_back(point);
    }
    return points;
  }();
  return cloud;
}

cv::Mat makeSyntheticFrame(int frameNumber) {
  constexpr int width = 480;
  constexpr int height = 276;
  constexpr double fx = 240.0;
  constexpr double fy = 240.0;
  constexpr double cx = 240.0;
  constexpr double cy = 138.0;

  cv::Mat frame(height, width, CV_8UC3, cv::Scalar(16, 22, 30));
  const double cameraX = frameNumber * 0.018;
  const double cameraY = std::sin(frameNumber * 0.08) * 0.035;
  const double cameraZ = frameNumber * 0.006;
  const double yaw = frameNumber * 0.0025;
  const double cosYaw = std::cos(yaw);
  const double sinYaw = std::sin(yaw);

  int visible = 0;
  for (std::size_t index = 0; index < syntheticCloud().size(); ++index) {
    const SyntheticPoint& point = syntheticCloud()[index];
    const double dx = point.world.x - cameraX;
    const double dy = point.world.y - cameraY;
    const double dz = point.world.z - cameraZ;
    const double cameraPointX = cosYaw * dx - sinYaw * dz;
    const double cameraPointZ = sinYaw * dx + cosYaw * dz;
    const double cameraPointY = dy;
    if (cameraPointZ <= 0.25) continue;

    const double radial = std::hypot(cameraPointX, cameraPointY);
    const double theta = std::atan2(radial, cameraPointZ);
    const double projectionScale = radial > 1e-9 ? theta / radial : 1.0 / cameraPointZ;
    const int u = static_cast<int>(std::lround(fx * cameraPointX * projectionScale + cx));
    const int v = static_cast<int>(std::lround(fy * cameraPointY * projectionScale + cy));
    if (u < 7 || u >= width - 7 || v < 7 || v >= height - 7) continue;

    const int shade = 80 + static_cast<int>((index * 47) % 170);
    const cv::Scalar color(shade, shade, shade);
    cv::circle(frame, cv::Point(u, v), 2, color, -1, cv::LINE_AA);
    if (point.pattern & 1) cv::line(frame, cv::Point(u - 5, v), cv::Point(u + 5, v), color, 1, cv::LINE_AA);
    if (point.pattern & 2) cv::line(frame, cv::Point(u, v - 5), cv::Point(u, v + 5), color, 1, cv::LINE_AA);
    if (point.pattern & 4) cv::line(frame, cv::Point(u - 4, v - 4), cv::Point(u + 4, v + 4), color, 1, cv::LINE_AA);
    if (point.pattern & 8) cv::line(frame, cv::Point(u - 4, v + 4), cv::Point(u + 4, v - 4), color, 1, cv::LINE_AA);
    ++visible;
  }

  if (visible < 250) throw std::runtime_error("Synthetic replay produced too few visible points");
  return frame;
}

void requireFinite(const cv::Mat& output) {
  if (output.empty()) throw std::runtime_error("YOLOX produced an empty tensor");
  cv::Mat continuous = output.isContinuous() ? output : output.clone();
  const float* values = continuous.ptr<float>();
  const std::size_t count = continuous.total();
  for (std::size_t index = 0; index < count; ++index) {
    if (!std::isfinite(values[index])) {
      throw std::runtime_error("YOLOX output contains a non-finite value");
    }
  }
}

}  // namespace

int main() {
  try {
    const std::string vocabulary =
        envString("ORB_VOCABULARY", "/opt/ORB_SLAM3/Vocabulary/ORBvoc.txt");
    const std::string settings =
        envString("ORB_SETTINGS", "/config/bebop2.example.yaml");
    const std::string model = envString("YOLOX_MODEL", "/models/yolox_tiny.onnx");

    for (const auto& path : {vocabulary, settings, model}) {
      if (!std::filesystem::exists(path) || std::filesystem::file_size(path) == 0) {
        throw std::runtime_error("Required engine asset is missing: " + path);
      }
    }

    std::streambuf* protocolBuffer = std::cout.rdbuf();
    std::ostream protocol(protocolBuffer);
    std::cout.rdbuf(std::cerr.rdbuf());

    ORB_SLAM3::System slam(vocabulary, settings, ORB_SLAM3::System::MONOCULAR, false);
    int framesSubmitted = 0;
    bool trackingReached = false;
    std::size_t maxTrackedPoints = 0;
    std::size_t maxTrackedFeatures = 0;
    int finalTrackingState = ORB_SLAM3::Tracking::NO_IMAGES_YET;
    for (int index = 0; index < 120; ++index) {
      cv::Mat frame = makeSyntheticFrame(index);
      slam.TrackMonocular(frame, index / 30.0);
      ++framesSubmitted;
      finalTrackingState = slam.GetTrackingState();
      trackingReached = trackingReached || finalTrackingState == ORB_SLAM3::Tracking::OK ||
                        finalTrackingState == ORB_SLAM3::Tracking::OK_KLT;
      maxTrackedPoints =
          std::max(maxTrackedPoints, slam.GetTrackedMapPoints().size());
      maxTrackedFeatures =
          std::max(maxTrackedFeatures, slam.GetTrackedKeyPointsUn().size());
    }
    slam.Shutdown();
    if (!trackingReached) {
      throw std::runtime_error("ORB-SLAM3 did not reach tracking on the deterministic replay");
    }
    if (maxTrackedPoints == 0 || maxTrackedFeatures < 40) {
      throw std::runtime_error("ORB-SLAM3 tracking produced insufficient features or map points");
    }

    cv::dnn::Net detector = cv::dnn::readNetFromONNX(model);
    if (detector.empty()) {
      throw std::runtime_error("OpenCV could not load the YOLOX ONNX graph");
    }
    detector.setPreferableBackend(cv::dnn::DNN_BACKEND_OPENCV);
    detector.setPreferableTarget(cv::dnn::DNN_TARGET_CPU);
    cv::Mat detectorInput = makeSyntheticFrame(20);
    cv::resize(detectorInput, detectorInput, cv::Size(416, 416));
    cv::Mat blob = cv::dnn::blobFromImage(detectorInput, 1.0, cv::Size(416, 416),
                                          cv::Scalar(), false, false, CV_32F);
    detector.setInput(blob);
    cv::Mat output = detector.forward();
    requireFinite(output);

    protocol
        << json({{"ok", true},
                 {"orbSlam3",
                  {{"vocabularyLoaded", true},
                   {"systemConstructed", true},
                   {"framesSubmitted", framesSubmitted},
                   {"trackingReached", trackingReached},
                   {"finalTrackingState", finalTrackingState},
                   {"maxTrackedPoints", maxTrackedPoints},
                   {"maxTrackedFeatures", maxTrackedFeatures}}},
                 {"yolox",
                  {{"modelLoaded", true},
                   {"inferenceExecuted", true},
                   {"outputDimensions", output.dims},
                   {"outputElements", output.total()}}}})
               .dump()
        << '\n'
        << std::flush;
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "Perception engine self-test failed: " << error.what() << '\n';
    return 1;
  }
}
