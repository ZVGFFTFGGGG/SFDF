"use strict";
(() => {
  const MIME = { mp4: "video/mp4", webm: "video/webm", mkv: "video/x-matroska", mp3: "audio/mpeg", m4a: "audio/mp4" };
  async function unzipArtifact(msg) {
    try {
      const res = await fetch(msg.url, msg.token ? {
        headers: { Authorization: `Bearer ${msg.token}`, Accept: "application/vnd.github+json" }
      } : undefined);
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const buf = new Uint8Array(await res.arrayBuffer());
      const entries = fflate.unzipSync(buf);
      const files = [];
      for (const name of Object.keys(entries)) {
        const data = entries[name];
        delete entries[name];
        if (!data || !data.length || name.endsWith("/")) continue;
        const ext = (name.toLowerCase().split(".").pop() || "");
        const blob = new Blob([data], { type: MIME[ext] || "application/octet-stream" });
        files.push({ name, size: data.length, blobUrl: URL.createObjectURL(blob) });
      }
      return files.length ? { ok: true, files } : { ok: false, error: "ארכיון ריק" };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (!msg || msg.target !== "offscreen") return undefined;
    if (msg.type === "UNZIP_ARTIFACT") { unzipArtifact(msg).then(sendResponse); return true; }
    if (msg.type === "REVOKE") { try { URL.revokeObjectURL(msg.blobUrl); } catch {} sendResponse({ ok: true }); return true; }
  });
})();
