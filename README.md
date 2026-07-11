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

Not implemented yet:

- Live H.264 capture
- GStreamer pipeline
- WebRTC browser video
- Hardware-tested telemetry event mapping
- Arm/confirmation safety state machine

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

Click **Connect**, then **Acquire controls**. Simulation mode is the default.

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

Do the first hardware test with the propellers removed. The `node-bebop` package is old, and its exact telemetry event names and behavior still need validation against a physical Bebop 2.

## Architecture

```text
Browser
  | WebSocket controls and telemetry
Node.js server
  | fixed-rate scheduler and watchdog
DroneAdapter
  | simulated or node-bebop
Parrot Bebop 2
```

Video will be a separate native media path so decoding or transcoding cannot stall flight control:

```text
Bebop H.264 -> GStreamer -> WebRTC -> Browser
```

## Safety limitations

This is experimental software. It does not replace the Bebop firmware failsafes or the original controller. Current code has a movement watchdog and disconnect stop, but it does not yet have the complete arm, battery, altitude, telemetry-staleness, and emergency-confirmation protections planned for the project.

## Next milestone

1. Capture and characterize the exact video payload emitted by `node-bebop`.
2. Save a replayable H.264 fixture.
3. Add a supervised GStreamer process.
4. Add low-latency local preview.
5. Bridge the stream to the browser through WebRTC.
