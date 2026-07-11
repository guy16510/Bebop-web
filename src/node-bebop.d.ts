declare module 'node-bebop' {
  interface BebopClient {
    connect(callback: () => void): void;
    disconnect?(): void;
    takeOff(): void;
    land(): void;
    emergency(): void;
    stop(): void;
    forward(value: number): void;
    backward(value: number): void;
    right(value: number): void;
    left(value: number): void;
    clockwise(value: number): void;
    counterClockwise(value: number): void;
    up(value: number): void;
    down(value: number): void;
    getVideoStream(): import('node:stream').Readable;
    getMjpegStream(): import('node:stream').Readable;
    MediaStreaming: { videoEnable(value: 0 | 1): void };
    on(event: string, listener: (...args: any[]) => void): void;
  }

  const bebop: {
    createClient(): BebopClient;
  };

  export default bebop;
}
