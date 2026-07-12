# Autonomous flight runtime verification

The physical Bebop adapter must consume the raw `AltitudeChanged` event emitted by `node-bebop`. A lowercase `altitude` listener alone does not receive the drone's altitude telemetry, which leaves the closed-loop climb controller reading zero meters.

Before installing propellers:

1. Start the app with `npm run dev` and connect to the Bebop Wi-Fi.
2. Confirm the dashboard altitude changes when the drone is lifted by hand.
3. Run the props-off control checks and verify STOP, Land, and Emergency independently.
4. Start with a hover-only autonomous mission at 1.0 to 1.2 meters.
5. Reinstall propellers only after telemetry, command direction, and landing behavior are confirmed.

Automated coverage includes the raw altitude-event binding, TypeScript checks, client syntax checks, unit tests, production build, and the simulated autonomous takeoff, navigation, AprilTag alignment, and landing smoke path.
