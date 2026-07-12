# Autonomous flight hardening

The software now treats autonomous flight as a fail-safe state machine rather than a sequence of best-effort commands.

## Enforced protections

- Every autonomous movement command carries a sequence number and must receive a server acknowledgement.
- Rejected commands or missing acknowledgements trigger controlled landing.
- Landing commands are repeated until landed telemetry is received.
- Video, SLAM, and AprilTag data must remain fresh during missions.
- Stale detections are never reused for landing alignment.
- Pad transfers are constrained by a persisted horizontal geofence.
- Range timestamps from the future are rejected.
- Translation is blocked when the required range sectors are absent.

## Physical limitations that software cannot remove

A Parrot Bebop 2, a monocular camera, and a laptop-side control process do not provide redundant flight control. Do not call this bulletproof. Physical release still requires props-off sensor checks, tethered low-altitude tests, verified range-sensor coverage, AprilTag sign calibration, and an independent operator able to command Land or Emergency.
