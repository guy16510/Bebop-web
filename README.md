# Bebop Web

A minimal local Node.js control console for the Parrot Bebop 2.

## Current status

Implemented:

- TypeScript Node.js server
- WebSocket flight-control API
- Fixed-rate 20 Hz command scheduler
- 250 ms stale-input watchdog
- Single-browser pilot ownership
- Keyboard controls
- Telemetry display
- Simulation mode for safe development
- Initial `node-bebop` adapter
- Direct MJPEG browser preview
- Latest-frame-only fanout for slow browser clients
- Video health endpoint and live diagnostics
- GitHub Actions checks for typecheck, tests, and build

Still pending:

- Raw H.264 capture and replay fixtures
- Supervised GStreamer pipeline
- WebRTC browser delivery
- Hardware-tested telemetry event mapping
- Arm and confirmation safety state machine

## Requirements

- Node.js 20 or newer
- npm
- For real drone mode, a computer connected to the Bebop 2 Wi-Fi network

## Run in simulation mode

```bash
cp .env.example .env
npm install
npm run dev
```

Open `http://localhost:3000`.

Click **Connect**, then **Acquire controls**. Simulation mode is the default. Simulation mode currently has no generated camera fixture, so the video start action intentionally reports that no fixture is configured.

## Keyboard controls

| Key | Action |
| --- | --- |
| W / S | Pitch forward / backward |
| A / D | Roll left / right |
| Q / E | Yaw left / right |
| R / F | Rise / descend |
| Space | Stop movement |

The browser sends desired state at 20 Hz. The server owns the actual drone command frequency and resets movement after 250 ms without input.

## Real Bebop mode

Set:

```dotenv
DRONE_MODE=bebop
```

Then connect the computer running this server to the Bebop 2 Wi-Fi network and start the application.

Recommended first validation sequence:

1. Remove the propellers.
2. Start the server.
3. Click **Connect**.
4. Confirm battery and flight-state telemetry.
5. Click **Start video**.
6. Confirm the browser displays live MJPEG video.
7. Check `http://localhost:3000/api/video/health` for frame rate, bytes, viewers, dropped frames, and the timestamp of the latest frame.
8. Only reinstall propellers after control and disconnect behavior are verified.

The `node-bebop` package exposes `getMjpegStream()` as complete JPEG frames. The server wraps those frames in a multipart MJPEG HTTP response for the browser. Each viewer has a one-frame effective buffer. When a browser cannot keep up, old frames are discarded instead of creating growing latency.

## Video endpoints

```text
POST /api/video/start
POST /api/video/stop
GET  /api/video/health
GET  /video.mjpeg
```

The current MJPEG path is the diagnostic and compatibility implementation. It is intentionally separate from the fixed-rate flight scheduler, but JPEG encoding still happens in the legacy `node-bebop` stack and may use more bandwidth than the final H.264/WebRTC path.

## Architecture

```text
Browser
  | WebSocket controls and telemetry
  | multipart MJPEG preview
Node.js server
  | fixed-rate scheduler and watchdog
  | latest-frame-only video fanout
DroneAdapter
  | simulated or node-bebop
Parrot Bebop 2
```

The intended final media path remains:

```text
Bebop H.264 -> supervised GStreamer -> WebRTC -> Browser
```

Node.js will supervise and signal the media process, but it will not decode full video frames on the flight-control event loop.

## Safety limitations

This is experimental software. It does not replace the Bebop firmware failsafes or the original controller. Current code has a movement watchdog and disconnect stop, but it does not yet have the complete arm, battery, altitude, telemetry-staleness, and emergency-confirmation protections planned for the project.

## Next milestone

1. Add a raw `getVideoStream()` capture command.
2. Record timestamped H.264 packet statistics and a replayable fixture.
3. Add a GStreamer dependency check and supervised child process.
4. Measure local MJPEG latency as a baseline.
5. Add H.264 WebRTC delivery and compare measured latency.
