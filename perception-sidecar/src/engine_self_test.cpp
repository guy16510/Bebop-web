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

using json = nlohmann::json;

namespace {

std::string envString(const char* name, const std::string& fallback) {
  const char* value = std::getenv(name);
  return value && *value ? std::string(value) : fallback;
}

cv::Mat makeTexturedFrame(int frameNumber) {
  constexpr int width = 480;
  constexpr int height = 276;
  cv::Mat frame(height, width, CV_8UC3, cv::Scalar(18, 24, 32));

  for (int y = 12; y < height; y += 24) {
    for (int x = 12; x < width; x += 24) {
      const int value = ((x / 24 + y / 24) % 2) == 0 ? 220 : 65;
      cv::rectangle(frame, cv::Rect(x, y, 14, 14), cv::Scalar(value, 255 - value / 2, 90), -1);
    }
  }

  cv::RNG random(0xBEB0 + frameNumber);
  for (int index = 0; index < 120; ++index) {
    cv::Point center(random.uniform(0, width), random.uniform(0, height));
    cv::circle(frame, center, random.uniform(1, 5),
               cv::Scalar(random.uniform(80, 255), random.uniform(80, 255), random.uniform(80, 255)), -1);
  }

  cv::putText(frame, "BEBOP ORB SLAM3 ENGINE TEST", cv::Point(32, 245),
              cv::FONT_HERSHEY_SIMPLEX, 0.65, cv::Scalar(255, 255, 255), 2, cv::LINE_AA);

  const double shiftX = frameNumber * 1.8;
  const double shiftY = std::sin(frameNumber * 0.35) * 2.5;
  cv::Mat transform = (cv::Mat_<double>(2, 3) << 1.0, 0.002 * frameNumber, shiftX,
                                                   -0.001 * frameNumber, 1.0, shiftY);
  cv::Mat warped;
  cv::warpAffine(frame, warped, transform, frame.size(), cv::INTER_LINEAR, cv::BORDER_REFLECT101);
  return warped;
}

void requireFinite(const cv::Mat& output) {
  if (output.empty()) throw std::runtime_error("YOLOX produced an empty tensor");
  cv::Mat continuous = output.isContinuous() ? output : output.clone();
  const float* values = continuous.ptr<float>();
  const std::size_t count = continuous.total();
  for (std::size_t index = 0; index < count; ++index) {
    if (!std::isfinite(values[index])) throw std::runtime_error("YOLOX output contains a non-finite value");
  }
}

}  // namespace

int main() {
  try {
    const std::string vocabulary = envString("ORB_VOCABULARY", "/opt/ORB_SLAM3/Vocabulary/ORBvoc.txt");
    const std::string settings = envString("ORB_SETTINGS", "/config/bebop2.example.yaml");
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
    for (int index = 0; index < 18; ++index) {
      cv::Mat frame = makeTexturedFrame(index);
      slam.TrackMonocular(frame, index / 30.0);
      ++framesSubmitted;
    }
    const int trackingState = slam.GetTrackingState();
    const auto trackedPoints = slam.GetTrackedMapPoints().size();
    const auto trackedFeatures = slam.GetTrackedKeyPointsUn().size();
    slam.Shutdown();

    cv::dnn::Net detector = cv::dnn::readNetFromONNX(model);
    if (detector.empty()) throw std::runtime_error("OpenCV could not load the YOLOX ONNX graph");
    detector.setPreferableBackend(cv::dnn::DNN_BACKEND_OPENCV);
    detector.setPreferableTarget(cv::dnn::DNN_TARGET_CPU);
    cv::Mat detectorInput = makeTexturedFrame(20);
    cv::resize(detectorInput, detectorInput, cv::Size(416, 416));
    cv::Mat blob = cv::dnn::blobFromImage(detectorInput, 1.0, cv::Size(416, 416), cv::Scalar(), false, false, CV_32F);
    detector.setInput(blob);
    cv::Mat output = detector.forward();
    requireFinite(output);

    protocol << json({
      {"ok", true},
      {"orbSlam3", {
        {"vocabularyLoaded", true},
        {"systemConstructed", true},
        {"framesSubmitted", framesSubmitted},
        {"trackingState", trackingState},
        {"trackedPoints", trackedPoints},
        {"trackedFeatures", trackedFeatures}
      }},
      {"yolox", {
        {"modelLoaded", true},
        {"inferenceExecuted", true},
        {"outputDimensions", output.dims},
        {"outputElements", output.total()}
      }}
    }).dump() << '\n' << std::flush;
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "Perception engine self-test failed: " << error.what() << '\n';
    return 1;
  }
}
