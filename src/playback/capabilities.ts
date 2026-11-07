let cached: Promise<boolean> | undefined;

/** HEVC passthrough is used only when this renderer reports smooth, power-efficient decoding. */
export function hardwareHevc(): Promise<boolean> {
  if (typeof navigator === 'undefined' || typeof MediaSource === 'undefined' || !navigator.mediaCapabilities) return Promise.resolve(false);
  return cached ??= (async () => {
    const contentType = 'video/mp4; codecs="hvc1.1.6.L123.B0"';
    try {
      if (!MediaSource.isTypeSupported(contentType)) return false;
      const info = await navigator.mediaCapabilities.decodingInfo({ type: 'media-source', video: {
        contentType, width: 1920, height: 1080, bitrate: 8000000, framerate: 30,
      } });
      return info.supported && info.smooth && info.powerEfficient;
    } catch { return false; }
  })();
}
