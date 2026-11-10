/**
 * Decoding of user supplied WAV files.
 *
 * The original read the canonical 44 byte header with fread and refused
 * anything that was not uncompressed PCM:
 *
 *     "Sorry, compressed wav, i dont grok that yet!"
 *
 * The browser can decode far more formats, but the sample data is still
 * expected to be mono PCM at the song rate, exactly as in the original.
 */

export interface DecodedSample {
  /** mono PCM, normalised to [-1, 1] */
  data: Float32Array;
  /** sample rate of the source file */
  rate: number;
  /** original file name, kept for the INI "WavFile" key */
  name: string;
}

/** Downmix an AudioBuffer to a single mono channel. */
export function downmix(buffer: AudioBuffer): Float32Array {
  const frames = buffer.length;
  const out = new Float32Array(frames);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < frames; i++) out[i] = out[i]! + data[i]! / buffer.numberOfChannels;
  }
  return out;
}

/**
 * Decode an audio file into mono PCM.
 *
 * The original's "compressed wav" rejection is preserved as a soft warning:
 * browsers decode formats the original could not handle, so the file is
 * accepted but the user is told about the difference.
 */
export async function decodeSample(ctx: BaseAudioContext, file: File): Promise<DecodedSample> {
  const buffer = await file.arrayBuffer();
  const audio = await ctx.decodeAudioData(buffer);
  return { data: downmix(audio), rate: audio.sampleRate, name: file.name };
}

/** Cheap check for the canonical uncompressed PCM header the original expected. */
export function looksLikePcmWav(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 44) return false;
  const view = new DataView(buffer);
  const tag = (offset: number) => String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return false;
  return view.getUint16(20, true) === 1; // format tag 1 == PCM
}
