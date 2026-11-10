/**
 * Ambient declarations for the AudioWorklet global scope.
 * lib.dom.d.ts does not describe the worklet global scope, so the handful of
 * globals the processor uses are declared here.
 */

export {};

declare global {
  interface AudioWorkletProcessor {
    readonly port: MessagePort;
    readonly parameters: Record<string, AudioParam>;
    readonly length: number;
  }

  var AudioWorkletProcessor: {
    prototype: AudioWorkletProcessor;
    new (options?: AudioWorkletNodeOptions): AudioWorkletProcessor;
  };

  var registerProcessor: (name: string, processorCtor: unknown) => void;

  var currentTime: number;
  var currentFrame: number;
  var sampleRate: number;
  var sampleIndex: number;
}
