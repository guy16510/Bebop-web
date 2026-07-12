cmake_minimum_required(VERSION 3.16)
project(bebop_perception_sidecar LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

if(NOT DEFINED ORB_SLAM3_ROOT)
  set(ORB_SLAM3_ROOT "/opt/ORB_SLAM3")
endif()

find_package(OpenCV 4.4 REQUIRED COMPONENTS core imgproc videoio dnn calib3d features2d)
find_package(Eigen3 3.1 REQUIRED)
find_package(nlohmann_json 3.2 REQUIRED)
find_package(Pangolin REQUIRED)
find_package(Boost REQUIRED COMPONENTS serialization)
find_package(OpenSSL REQUIRED)

function(configure_perception_target target_name)
  target_include_directories(${target_name} PRIVATE
    ${ORB_SLAM3_ROOT}
    ${ORB_SLAM3_ROOT}/include
    ${ORB_SLAM3_ROOT}/include/CameraModels
    ${ORB_SLAM3_ROOT}/Thirdparty/Sophus
    ${EIGEN3_INCLUDE_DIR}
    ${Pangolin_INCLUDE_DIRS}
  )

  target_link_directories(${target_name} PRIVATE
    ${ORB_SLAM3_ROOT}/lib
    ${ORB_SLAM3_ROOT}/Thirdparty/DBoW2/lib
    ${ORB_SLAM3_ROOT}/Thirdparty/g2o/lib
  )

  target_link_libraries(${target_name} PRIVATE
    ORB_SLAM3
    DBoW2
    g2o
    ${OpenCV_LIBS}
    ${Pangolin_LIBRARIES}
    Eigen3::Eigen
    nlohmann_json::nlohmann_json
    Boost::serialization
    OpenSSL::Crypto
    pthread
  )

  target_compile_options(${target_name} PRIVATE -Wall -Wextra -Wpedantic)
endfunction()

add_executable(bebop-perception-sidecar src/main.cpp)
configure_perception_target(bebop-perception-sidecar)

add_executable(bebop-perception-engine-self-test src/engine_self_test.cpp)
configure_perception_target(bebop-perception-engine-self-test)

install(
  TARGETS bebop-perception-sidecar bebop-perception-engine-self-test
  RUNTIME DESTINATION bin
)
