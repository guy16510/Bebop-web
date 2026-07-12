FROM ubuntu:22.04

ARG DEBIAN_FRONTEND=noninteractive
ARG ORB_SLAM3_COMMIT=4452a3c4ab75b1cde34e5505a36ec3f9edcdc4c4
ARG PANGOLIN_COMMIT=d484494645cb7361374ac0ef6b27e9ee6feffbd7
ARG YOLOX_VERSION=0.1.1rc0

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    cmake \
    git \
    libavcodec-dev \
    libavdevice-dev \
    libavformat-dev \
    libboost-serialization-dev \
    libdc1394-dev \
    libegl1-mesa-dev \
    libeigen3-dev \
    libgl1-mesa-dev \
    libglew-dev \
    libjpeg-dev \
    libopencv-dev \
    libpng-dev \
    libssl-dev \
    libswscale-dev \
    libwayland-dev \
    libx11-dev \
    libxkbcommon-dev \
    nlohmann-json3-dev \
    pkg-config \
    wget \
    && rm -rf /var/lib/apt/lists/*

RUN git clone https://github.com/stevenlovegrove/Pangolin.git /opt/Pangolin \
    && cd /opt/Pangolin \
    && git checkout ${PANGOLIN_COMMIT} \
    && cmake -S /opt/Pangolin -B /opt/Pangolin/build \
      -DCMAKE_BUILD_TYPE=Release \
      -DBUILD_PANGOLIN_PYTHON=OFF \
      -DBUILD_EXAMPLES=OFF \
      -DBUILD_TOOLS=OFF \
    && cmake --build /opt/Pangolin/build --parallel 2 \
    && cmake --install /opt/Pangolin/build \
    && ldconfig

RUN git clone https://github.com/UZ-SLAMLab/ORB_SLAM3.git /opt/ORB_SLAM3 \
    && cd /opt/ORB_SLAM3 \
    && git checkout ${ORB_SLAM3_COMMIT} \
    && sed -i 's/-march=native//g' CMakeLists.txt Thirdparty/DBoW2/CMakeLists.txt Thirdparty/g2o/CMakeLists.txt \
    && sed -i 's/++11/++14/g' CMakeLists.txt Thirdparty/g2o/CMakeLists.txt Thirdparty/Sophus/CMakeLists.txt \
    && cmake -S Thirdparty/DBoW2 -B Thirdparty/DBoW2/build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build Thirdparty/DBoW2/build --parallel 2 \
    && cmake -S Thirdparty/g2o -B Thirdparty/g2o/build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build Thirdparty/g2o/build --parallel 2 \
    && cmake -S Thirdparty/Sophus -B Thirdparty/Sophus/build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build Thirdparty/Sophus/build --parallel 2 \
    && tar -xf Vocabulary/ORBvoc.txt.tar.gz -C Vocabulary \
    && cmake -S . -B build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build --target ORB_SLAM3 --parallel 2 \
    && test -s /opt/ORB_SLAM3/Vocabulary/ORBvoc.txt \
    && test -s /opt/ORB_SLAM3/lib/libORB_SLAM3.so

COPY perception-sidecar /work/perception-sidecar
RUN cmake -S /work/perception-sidecar -B /work/perception-sidecar/build \
      -DCMAKE_BUILD_TYPE=Release \
      -DORB_SLAM3_ROOT=/opt/ORB_SLAM3 \
    && cmake --build /work/perception-sidecar/build --parallel 2 \
    && cmake --install /work/perception-sidecar/build

RUN mkdir -p /models /config \
    && wget -q --show-progress \
      https://github.com/Megvii-BaseDetection/YOLOX/releases/download/${YOLOX_VERSION}/yolox_tiny.onnx \
      -O /models/yolox_tiny.onnx \
    && test -s /models/yolox_tiny.onnx

COPY perception-sidecar/config/bebop2.example.yaml /config/bebop2.example.yaml
COPY config/perception/bebop2-upstream-428x240.yaml /config/bebop2-upstream-428x240.yaml
COPY perception-sidecar/entrypoint.sh /usr/local/bin/perception-entrypoint
RUN chmod +x /usr/local/bin/perception-entrypoint \
    && export LD_LIBRARY_PATH=/opt/ORB_SLAM3/lib:/opt/ORB_SLAM3/Thirdparty/DBoW2/lib:/opt/ORB_SLAM3/Thirdparty/g2o/lib:/usr/local/lib \
    && /usr/local/bin/bebop-perception-sidecar --self-test | grep -q 'perception.snapshot' \
    && ORB_SETTINGS=/config/bebop2-upstream-428x240.yaml \
       /usr/local/bin/bebop-perception-engine-self-test > /tmp/perception-engine-self-test.json \
    && grep -q '"inferenceExecuted":true' /tmp/perception-engine-self-test.json \
    && grep -q '"trackingReached":true' /tmp/perception-engine-self-test.json

ENV ORB_VOCABULARY=/opt/ORB_SLAM3/Vocabulary/ORBvoc.txt \
    ORB_SETTINGS=/config/bebop2.yaml \
    YOLOX_MODEL=/models/yolox_tiny.onnx \
    YOLOX_INPUT_SIZE=416 \
    YOLOX_OUTPUT_DECODED=false \
    PERCEPTION_OUTPUT_HZ=10 \
    DETECTION_EVERY_N_FRAMES=3 \
    LD_LIBRARY_PATH=/opt/ORB_SLAM3/lib:/opt/ORB_SLAM3/Thirdparty/DBoW2/lib:/opt/ORB_SLAM3/Thirdparty/g2o/lib:/usr/local/lib

ENTRYPOINT ["/usr/local/bin/perception-entrypoint"]
