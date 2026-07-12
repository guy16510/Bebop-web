# Onboard-only autonomous flight

The Bebop 2 can run a constrained onboard-only guard using its forward camera, object recognition, SLAM tracking, firmware altitude estimate, GPS, IMU, and AprilTag landing detector. This mode is not equivalent to LiDAR or multi-direction ToF.

## Enforced behavior

- Fresh live video and SLAM tracking are required whenever the onboard guard is the active avoidance source.
- Forward translation is capped at a low command percentage.
- Large recognized hazards inside the center image corridor stop movement.
- Smaller visible hazards reduce speed.
- Reverse translation is blocked.
- Sideways translation is blocked except during low-speed AprilTag landing alignment.
- Stale vision while translating causes a controlled landing.

## Blind spots

The front monocular camera cannot provide dependable metric distance for unknown objects. It cannot guarantee detection of glass, wires, thin branches, textureless walls, objects outside the frame, obstacles behind the drone, or obstacles directly above it. Use this mode only in a clear, controlled test area with a low altitude, low speed, short geofence, and an independent operator override.
