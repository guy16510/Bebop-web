# Autonomous flight

`npm run dev` and `npm start` now launch a separate autonomy companion on port `3001` by default. The dashboard loads its controls automatically and persists mission settings in `.bebop/autonomy.json`.

## Implemented mission

The autonomous controller can:

1. validate all preflight gates
2. acquire the exclusive pilot lease
3. arm through the existing server safety controller
4. take off
5. use altitude telemetry to reach the configured target height
6. hover
7. optionally run a low-rate yaw survey
8. stop movement and land
9. release the pilot lease

The autonomous service uses the same WebSocket command path, safety filtering, stale-command watchdog, landing path, and emergency path as the manual dashboard.

## Preflight gates

Mission start is blocked unless:

- autonomy is explicitly enabled
- physical flight is explicitly allowed when `DRONE_MODE=bebop`
- the autonomy service is connected to the main control server
- the drone is connected and reports `landed`
- telemetry is fresh
- battery is above the configured takeoff minimum
- Wi-Fi signal is above the configured minimum when signal telemetry is available
- decoded video is running when required
- perception is running and SLAM reports `tracking` when required
- no other autonomous mission is active

Physical flight also requires typing `START AUTONOMOUS FLIGHT` for every mission. That confirmation is intentionally not persisted.

## In-flight fail-safes

The controller requests an immediate controlled landing when any configured mission limit is violated:

- maximum flight time
- telemetry timeout
- battery reserve
- autonomous altitude ceiling
- Wi-Fi signal below the threshold for two seconds
- required SLAM tracking lost for two seconds
- takeoff, arming, control-acquisition, or climb timeout
- operator abort

The dashboard also exposes **Land now** and **Emergency, cut motors**. Emergency remains a motor-cut action, not a landing action.

## Deliberate limitation

The current ORB-SLAM3 pipeline is monocular and its horizontal translation scale is arbitrary. The autonomous controller therefore does not use map coordinates for metric XY waypoints, return-to-home, obstacle distance, or geofencing. It provides closed-loop altitude and time-bounded hover/yaw missions only.

Do not add translational waypoint flight until the system has a metric localization source and independently validated obstacle distance. Suitable sources include synchronized visual-inertial odometry, external tracking, or another metric position sensor.

## Physical acceptance sequence

1. Run the complete automated checks.
2. Use simulation to complete repeated autonomous missions and forced-abort cases.
3. Remove the propellers and validate pilot acquisition, command output, STOP, Land, Emergency, telemetry-loss handling, SLAM-loss handling, and persistence.
4. Reinstall propellers only after the props-off checks pass.
5. Perform the first flight in an open area at the default 1.2 m target altitude and 12% command limit.
6. Keep a second operator ready to use the existing Emergency button.

## API

The autonomy companion defaults to `http://127.0.0.1:3001`.

```text
GET  /api/health
GET  /api/autonomy
POST /api/autonomy/settings
POST /api/autonomy/start
POST /api/autonomy/abort
POST /api/autonomy/land
POST /api/autonomy/emergency
WS   /ws
```

Example simulation setup:

```bash
curl -X POST http://127.0.0.1:3001/api/autonomy/settings \
  -H 'content-type: application/json' \
  -d '{"enabled":true,"pattern":"yaw-scan","targetAltitudeMeters":1.2}'

curl -X POST http://127.0.0.1:3001/api/autonomy/start \
  -H 'content-type: application/json' \
  -d '{}'
```

Physical start requires the confirmation body:

```json
{"confirmation":"START AUTONOMOUS FLIGHT"}
```
