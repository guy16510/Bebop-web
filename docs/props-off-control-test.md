# Propeller-off control verification

This procedure validates the browser, WebSocket server, safety controller, Bebop adapter mapping, command watchdog, STOP path, Land, and Emergency before installing the propellers.

It cannot prove thrust balance or individual motor RPM. The current Bebop adapter does not receive per-motor speed acknowledgements from the drone.

## Setup

1. Remove all four propellers.
2. Put the drone on a stable, nonconductive surface with open space around it.
3. Use a charged battery.
4. Connect the computer directly to the Bebop Wi-Fi network.
5. Start the server in Bebop mode and open the dashboard.

## Transport and mapping test

1. Connect and acquire controls.
2. Run the 20-sample latency test. This measures browser-to-server-to-browser WebSocket latency only.
3. Press and release each control individually.
4. Verify the dashboard's `Last server-applied command` shows the expected mapping:

| Control | Expected command |
| --- | --- |
| Forward | positive pitch |
| Backward | negative pitch |
| Right | positive roll |
| Left | negative roll |
| Yaw right | positive yaw |
| Yaw left | negative yaw |
| Up | positive gaz |
| Down | negative gaz |

5. Verify every release returns roll, pitch, yaw, and gaz to zero.
6. Hold a direction and press STOP. Verify the STOP round-trip time appears and the accepted command returns to all zeros.

## Watchdog and motor test

Keep the propellers removed for every step.

1. Start the motors using the normal arm and takeoff flow.
2. Verify all four motors start without grinding, repeated hesitation, or a motor failing to start.
3. Briefly press each directional control and listen or record slow-motion video for the expected change in motor mix.
4. Press STOP while holding a direction. Directional motor mixing should stop immediately, but the motors may continue at hover or takeoff speed.
5. Test Land and verify the motors wind down normally.
6. Start again and test Emergency. Emergency must cut the motors immediately.
7. Start again, hold a direction, and close the controlling browser tab. The server should clear movement immediately when the WebSocket closes. If the close event is lost, the command watchdog clears movement after `COMMAND_TIMEOUT_MS`, 250 ms by default.

## Latency interpretation

The dashboard reports:

- WebSocket RTT, browser to Node server and back.
- WebSocket p95, the slowest typical result across recent samples.
- Last command RTT, including the synchronous adapter method call.
- Last STOP RTT.
- Server apply time, time spent parsing, validating, and applying the command in Node.

These values do not measure the final radio delivery or motor-controller response inside the drone. For motor-level validation, use slow-motion video, audio comparison, or a noncontact optical tachometer with the propellers removed.
