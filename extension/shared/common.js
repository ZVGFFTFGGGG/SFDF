"use strict";
const YTPROXY_PRESETS = [
  { id: "video_best", quality: "best", label: "האיכות הטובה ביותר" },
  { id: "video_1080", quality: "1080", label: "וידאו - 1080p" },
  { id: "video_720", quality: "720", label: "וידאו - 720p" },
  { id: "video_480", quality: "480", label: "וידאו - 480p" },
  { id: "audio_only", quality: "audio", label: "אודיו בלבד (MP3)" }
];
const YTPROXY_PRESETS_BY_ID = Object.fromEntries(YTPROXY_PRESETS.map((p) => [p.id, p]));
function formatBytes(n) {
  if (!n || n < 0) return "";
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}
if (typeof self !== "undefined") {
  self.YTPROXY_PRESETS = YTPROXY_PRESETS;
  self.YTPROXY_PRESETS_BY_ID = YTPROXY_PRESETS_BY_ID;
  self.formatBytes = formatBytes;
}
