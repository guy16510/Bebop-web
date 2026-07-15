#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>
#include <opencv2/core.hpp>
#include <opencv2/dnn.hpp>
#include <opencv2/imgproc.hpp>
#include <opencv2/videoio.hpp>

#include "System.h"
#include "Tracking.h"

using json = nlohmann::json;

namespace {

constexpr int kWidth = 428;
constexpr int kHeight = 240;
constexpr int kYoloInputSize = 416;
constexpr double kFx = 268.646439;
constexpr double kFy = 263.500174;
constexpr double kCx = 213.665927;
constexpr double kCy = 120.113444;

std::string envString(const char* name, const std::string& fallback) {
  const char* value = std::getenv(name);
  return value && *value ? std::string(value) : fallback;
}

struct SyntheticPoint {
  cv::Point3f world;
  int pattern = 0;
};

struct YoloCandidate {
  int classIndex = -1;
  float score = 0;
  cv::Rect2f box;
  std::size_t candidatesAboveFloor = 0;
};

const std::vector<SyntheticPoint>& syntheticCloud() {
  static const std::vector<SyntheticPoint> cloud = [] {
    std::vector<SyntheticPoint> points;
    points.reserve(1100);
    cv::RNG random(0xBEB02);
    for (int index = 0; index < 1100; ++index) {
      SyntheticPoint point;
      point.world.x = random.uniform(-4.8F, 4.8F);
      point.world.y = random.uniform(-2.5F, 2.5F);
      point.world.z = random.uniform(3.0F, 12.0F);
      point.pattern = random.uniform(0, 16);
      points.push_back(point);
    }
    return points;
  }();
  return cloud;
}

cv::Mat makeSyntheticFrame(int frameNumber) {
  cv::Mat frame(kHeight, kWidth, CV_8UC3, cv::Scalar(16, 22, 30));
  const double cameraX = frameNumber * 0.014;
  const double cameraY = std::sin(frameNumber * 0.08) * 0.035;
  const double cameraZ = frameNumber * 0.004;
  const double yaw = frameNumber * 0.0022;
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

    const int u = static_cast<int>(std::lround(kFx * cameraPointX / cameraPointZ + kCx));
    const int v = static_cast<int>(std::lround(kFy * cameraPointY / cameraPointZ + kCy));
    if (u < 7 || u >= kWidth - 7 || v < 7 || v >= kHeight - 7) continue;

    const int shade = 80 + static_cast<int>((index * 47) % 170);
    const cv::Scalar color(shade, shade, shade);
    cv::circle(frame, cv::Point(u, v), 2, color, -1, cv::LINE_AA);
    if (point.pattern & 1) {
      cv::line(frame, cv::Point(u - 5, v), cv::Point(u + 5, v), color, 1,
               cv::LINE_AA);
    }
    if (point.pattern & 2) {
      cv::line(frame, cv::Point(u, v - 5), cv::Point(u, v + 5), color, 1,
               cv::LINE_AA);
    }
    if (point.pattern & 4) {
      cv::line(frame, cv::Point(u - 4, v - 4), cv::Point(u + 4, v + 4), color,
               1, cv::LINE_AA);
    }
    if (point.pattern & 8) {
      cv::line(frame, cv::Point(u - 4, v + 4), cv::Point(u + 4, v - 4), color,
               1, cv::LINE_AA);
    }
    ++visible;
  }

  if (visible < 250) {
    throw std::runtime_error("Synthetic Bebop replay produced too few visible points");
  }
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

cv::Mat flattenYoloOutput(const cv::Mat& output) {
  if (output.empty()) return {};
  if (output.dims == 3) {
    cv::Mat rows(output.size[1], output.size[2], CV_32F,
                 const_cast<float*>(output.ptr<float>()));
    if (rows.cols == 85) return rows.clone();
    if (rows.rows == 85) {
      cv::Mat transposed;
      cv::transpose(rows, transposed);
      return transposed;
    }
  }
  if (output.dims == 2) {
    if (output.cols == 85) return output.clone();
    if (output.rows == 85) {
      cv::Mat transposed;
      cv::transpose(output, transposed);
      return transposed;
    }
  }
  return {};
}

void decodeYoloRows(cv::Mat& rows) {
  int row = 0;
  for (int stride : {8, 16, 32}) {
    const int grid = kYoloInputSize / stride;
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

YoloCandidate decodeBestCandidate(const cv::Mat& output) {
  cv::Mat rows = flattenYoloOutput(output);
  if (rows.empty() || rows.cols < 85) {
    throw std::runtime_error("YOLOX output shape cannot be decoded into detection rows");
  }
  decodeYoloRows(rows);

  YoloCandidate best;
  for (int row = 0; row < rows.rows; ++row) {
    const float* values = rows.ptr<float>(row);
    const float objectness = values[4];
    if (!std::isfinite(objectness)) continue;
    int bestClass = -1;
    float bestClassScore = -std::numeric_limits<float>::infinity();
    for (int classIndex = 0; classIndex < 80; ++classIndex) {
      const float classScore = values[5 + classIndex];
      if (std::isfinite(classScore) && classScore > bestClassScore) {
        bestClassScore = classScore;
        bestClass = classIndex;
      }
    }
    if (bestClass < 0 || !std::isfinite(bestClassScore)) continue;
    const float score = objectness * bestClassScore;
    const float centerX = values[0];
    const float centerY = values[1];
    const float width = values[2];
    const float height = values[3];
    if (!std::isfinite(score) || !std::isfinite(centerX) ||
        !std::isfinite(centerY) || !std::isfinite(width) ||
        !std::isfinite(height) || width <= 0 || height <= 0) {
      continue;
    }

    const float left = std::clamp(centerX - width / 2, 0.0F,
                                  static_cast<float>(kYoloInputSize - 1));
    const float top = std::clamp(centerY - height / 2, 0.0F,
                                 static_cast<float>(kYoloInputSize - 1));
    const float right = std::clamp(centerX + width / 2, left + 0.001F,
                                   static_cast<float>(kYoloInputSize));
    const float bottom = std::clamp(centerY + height / 2, top + 0.001F,
                                    static_cast<float>(kYoloInputSize));
    if (right <= left || bottom <= top) continue;
    if (score > 1e-8F) ++best.candidatesAboveFloor;
    if (best.classIndex < 0 || score > best.score) {
      best.classIndex = bestClass;
      best.score = score;
      best.box = cv::Rect2f(left, top, right - left, bottom - top);
    }
  }

  if (best.classIndex < 0 || best.classIndex >= 80 ||
      !std::isfinite(best.score) || best.score <= 0 ||
      best.box.width <= 0 || best.box.height <= 0 ||
      best.candidatesAboveFloor == 0) {
    throw std::runtime_error("YOLOX inference did not decode into a usable candidate");
  }
  return best;
}

}  // namespace

int main() {
  try {
    const std::string vocabulary =
        envString("ORB_VOCABULARY", "/opt/ORB_SLAM3/Vocabulary/ORBvoc.txt");
    const std::string settings = envString(
        "ORB_SETTINGS", "/config/bebop2-upstream-428x240.yaml");
    const std::string model = envString("YOLOX_MODEL", "/models/yolox_tiny.onnx");
    const std::string videoOutput = envString("SYNTHETIC_VIDEO_OUT", "");

    for (const auto& path : {vocabulary, settings, model}) {
      if (!std::filesystem::exists(path) || std::filesystem::file_size(path) == 0) {
        throw std::runtime_error("Required engine asset is missing: " + path);
      }
    }

    std::streambuf* protocolBuffer = std::cout.rdbuf();
    std::ostream protocol(protocolBuffer);
    std::cout.rdbuf(std::cerr.rdbuf());

    cv::VideoWriter writer;
    if (!videoOutput.empty()) {
      const std::filesystem::path outputPath(videoOutput);
      if (outputPath.has_parent_path()) {
        std::filesystem::create_directories(outputPath.parent_path());
      }
      writer.open(videoOutput, cv::VideoWriter::fourcc('M', 'J', 'P', 'G'), 30.0,
                  cv::Size(kWidth, kHeight));
      if (!writer.isOpened()) {
        throw std::runtime_error("Unable to create synthetic replay video: " + videoOutput);
      }
    }

    ORB_SLAM3::System slam(vocabulary, settings, ORB_SLAM3::System::MONOCULAR,
                           false);
    int framesSubmitted = 0;
    bool trackingReached = false;
    std::size_t maxTrackedPoints = 0;
    std::size_t maxTrackedFeatures = 0;
    int finalTrackingState = ORB_SLAM3::Tracking::NO_IMAGES_YET;
    for (int index = 0; index < 120; ++index) {
      cv::Mat frame = makeSyntheticFrame(index);
      if (writer.isOpened()) writer.write(frame);
      slam.TrackMonocular(frame, index / 30.0);
      ++framesSubmitted;
      finalTrackingState = slam.GetTrackingState();
      trackingReached = trackingReached ||
                        finalTrackingState == ORB_SLAM3::Tracking::OK ||
                        finalTrackingState == ORB_SLAM3::Tracking::OK_KLT;
      maxTrackedPoints =
          std::max(maxTrackedPoints, slam.GetTrackedMapPoints().size());
      maxTrackedFeatures =
          std::max(maxTrackedFeatures, slam.GetTrackedKeyPointsUn().size());
    }
    writer.release();
    slam.Shutdown();
    if (!trackingReached) {
      throw std::runtime_error(
          "ORB-SLAM3 did not reach tracking with the shipped Bebop calibration");
    }
    if (maxTrackedPoints == 0 || maxTrackedFeatures < 40) {
      throw std::runtime_error(
          "ORB-SLAM3 tracking produced insufficient features or map points");
    }
    if (!videoOutput.empty() &&
        (!std::filesystem::exists(videoOutput) ||
         std::filesystem::file_size(videoOutput) == 0)) {
      throw std::runtime_error("Synthetic replay video was not written");
    }

    cv::dnn::Net detector = cv::dnn::readNetFromONNX(model);
    if (detector.empty()) {
      throw std::runtime_error("OpenCV could not load the YOLOX ONNX graph");
    }
    detector.setPreferableBackend(cv::dnn::DNN_BACKEND_OPENCV);
    detector.setPreferableTarget(cv::dnn::DNN_TARGET_CPU);
    cv::Mat detectorInput = makeSyntheticFrame(20);
    cv::Mat resized;
    cv::resize(detectorInput, resized, cv::Size(kYoloInputSize, kYoloInputSize));
    cv::Mat blob = cv::dnn::blobFromImage(
        resized, 1.0, cv::Size(kYoloInputSize, kYoloInputSize), cv::Scalar(),
        false, false, CV_32F);
    detector.setInput(blob);
    cv::Mat output = detector.forward();
    requireFinite(output);
    const YoloCandidate candidate = decodeBestCandidate(output);

    protocol
        << json({{"ok", true},
                 {"camera",
                  {{"model", "PinHole"},
                   {"width", kWidth},
                   {"height", kHeight},
                   {"fx", kFx},
                   {"fy", kFy},
                   {"cx", kCx},
                   {"cy", kCy}}},
                 {"orbSlam3",
                  {{"vocabularyLoaded", true},
                   {"systemConstructed", true},
                   {"framesSubmitted", framesSubmitted},
                   {"trackingReached", trackingReached},
                   {"finalTrackingState", finalTrackingState},
                   {"maxTrackedPoints", maxTrackedPoints},
                   {"maxTrackedFeatures", maxTrackedFeatures},
                   {"syntheticVideoWritten", !videoOutput.empty()},
                   {"syntheticVideoPath", videoOutput}}},
                 {"yolox",
                  {{"modelLoaded", true},
                   {"inferenceExecuted", true},
                   {"outputDimensions", output.dims},
                   {"outputElements", output.total()},
                   {"decodedCandidate", true},
                   {"bestClassIndex", candidate.classIndex},
                   {"bestScore", candidate.score},
                   {"candidatesAboveFloor", candidate.candidatesAboveFloor},
                   {"bestBox",
                    {{"x", candidate.box.x},
                     {"y", candidate.box.y},
                     {"width", candidate.box.width},
                     {"height", candidate.box.height}}}}}}})
               .dump()
        << '\n'
        << std::flush;
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "Perception engine self-test failed: " << error.what() << '\n';
    return 1;
  }
}
