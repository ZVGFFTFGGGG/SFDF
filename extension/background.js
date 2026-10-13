"use strict";
importScripts("shared/common.js");

const BUILTIN_CONFIG = { owner: "", repo: "", workflow: "download.yml", ref: "main", token: "", cookieKey: "", updateOwner: "", updateRepo: "" };
try { importScripts("config.js"); } catch {}

const DEFAULTS = { ...BUILTIN_CONFIG, ...(self.DEFAULT_CONFIG || {}) };
const API = "https://api.github.com";
const CFG_KEY = "ytproxy_cfg";
const JOBS_KEY = "ytproxy_jobs";
const UPDATE_HOST = "com.rafi.ytproxy.updater";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jobs = new Map();
const driving = new Set();
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

async function getConfig() {
  const stored = (await chrome.storage.local.get(CFG_KEY))[CFG_KEY] || {};
  const cfg = { ...DEFAULTS, ...stored };
  for (const k of Object.keys(BUILTIN_CONFIG)) cfg[k] = String(cfg[k] || "").trim();
  if (!cfg.workflow) cfg.workflow = "download.yml";
  if (!cfg.ref) cfg.ref = "main";
  return cfg;
}

async function setConfig(patch) {
  const stored = (await chrome.storage.local.get(CFG_KEY))[CFG_KEY] || {};
  await chrome.storage.local.set({ [CFG_KEY]: { ...stored, ...patch } });
  return getConfig();
}

function ghFetch(url, cfg, init = {}) {
  return fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers || {})
    }
  });
}

function hexToBytes(hex) {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "");
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

function bytesToB64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const YT_AUTH_COOKIES = new Set([
  "SID", "HSID", "SSID", "APISID", "SAPISID", "LOGIN_INFO",
  "__Secure-1PSID", "__Secure-3PSID", "__Secure-1PAPISID", "__Secure-3PAPISID",
  "__Secure-1PSIDTS", "__Secure-3PSIDTS", "__Secure-1PSIDCC", "__Secure-3PSIDCC",
  "SIDCC", "PREF", "VISITOR_INFO1_LIVE", "VISITOR_PRIVACY_METADATA", "YSC", "__Secure-YEC", "CONSENT", "SOCS"
]);

async function exportYoutubeCookies() {
  if (!chrome.cookies || !chrome.cookies.getAll) return null;
  try {
    const groups = await Promise.all(["youtube.com", "google.com"].map((d) => chrome.cookies.getAll({ domain: d })));
    const seen = new Set();
    const lines = ["# Netscape HTTP Cookie File"];
    for (const c of groups.flat()) {
      const host = c.domain.replace(/^\./, "");
      if (host !== "youtube.com" && !host.endsWith(".youtube.com") && !YT_AUTH_COOKIES.has(c.name)) continue;
      const key = `${c.domain}|${c.name}|${c.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const domain = !c.hostOnly && !c.domain.startsWith(".") ? `.${c.domain}` : c.domain;
      lines.push(`${c.httpOnly ? "#HttpOnly_" : ""}${domain}\t${c.hostOnly ? "FALSE" : "TRUE"}\t${c.path}\t${c.secure ? "TRUE" : "FALSE"}\t${c.expirationDate ? Math.floor(c.expirationDate) : 0}\t${c.name}\t${c.value}`);
    }
    return lines.length > 1 ? `${lines.join("\n")}\n` : null;
  } catch { return null; }
}

async function encryptCookies(text, hexKey) {
  const raw = hexToBytes(hexKey);
  if (raw.length !== 32) throw new Error("COOKIE_KEY חייב להיות 64 תווי hex");
  const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(text)));
  const blob = new Uint8Array(iv.length + ct.length);
  blob.set(iv, 0); blob.set(ct, iv.length);
  return bytesToB64(blob);
}

async function persistJobs() {
  const plain = {};
  for (const [id, job] of jobs) plain[id] = job;
  try { await chrome.storage.session.set({ [JOBS_KEY]: plain }); } catch {}
  chrome.runtime.sendMessage({ type: "JOBS_CHANGED", jobs: plain }).catch(() => {});
}

async function restoreJobs() {
  if (jobs.size) return;
  try {
    const plain = (await chrome.storage.session.get(JOBS_KEY))[JOBS_KEY] || {};
    for (const [id, job] of Object.entries(plain)) jobs.set(id, job);
  } catch {}
}

function patchJob(id, patch) {
  const job = jobs.get(id);
  if (!job) return null;
  Object.assign(job, patch);
  void persistJobs();
  return job;
}

async function findRun(cfg, requestId, signal, dispatchedAt) {
  const target = `dl-${requestId}`;
  const url = `${API}/repos/${cfg.owner}/${cfg.repo}/actions/runs?event=workflow_dispatch&per_page=30`;
  const since = (dispatchedAt || Date.now()) - 20000;
  for (let i = 0; i < 120; i++) {
    if (signal.cancelled) throw new Error("בוטל");
    const res = await ghFetch(url, cfg);
    if (res.ok) {
      const runs = ((await res.json()).workflow_runs) || [];
      const exact = runs.find((r) => r.display_title === target || r.name === target);
      if (exact) return exact.id;
      const taken = new Set(Array.from(jobs.values()).map((j) => j.runId).filter(Boolean));
      const cands = runs.filter((r) => !taken.has(r.id) && r.status !== "completed" && new Date(r.created_at).getTime() >= since);
      if (cands.length === 1) return cands[0].id;
    }
    await sleep(2000);
  }
  throw new Error("לא נמצאה ריצה ב-GitHub");
}

async function waitForRun(cfg, runId, onTick, signal) {
  for (let i = 0; i < 600; i++) {
    if (signal.cancelled) throw new Error("בוטל");
    const res = await ghFetch(`${API}/repos/${cfg.owner}/${cfg.repo}/actions/runs/${runId}`, cfg);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const run = await res.json();
    onTick(run);
    if (run.status === "completed") return run.conclusion;
    await sleep(4500);
  }
  throw new Error("זמן ההמתנה הסתיים");
}

async function findReleaseAssets(cfg, requestId) {
  const res = await ghFetch(`${API}/repos/${cfg.owner}/${cfg.repo}/releases/tags/dl-${requestId}`, cfg);
  if (!res.ok) return null;
  const assets = ((await res.json()).assets || []).filter((a) => a.browser_download_url).map((a) => ({ name: a.name, url: a.browser_download_url }));
  return assets.length ? assets : null;
}

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (existing.length) return;
  await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["BLOBS"], justification: "Unzip" });
}

async function unpackZipUrl(url, jobId, token = null) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: "offscreen", type: "UNZIP_ARTIFACT", jobId, url, token });
  if (!res || !res.ok) throw new Error((res && res.error) || "שגיאה בפריסת ה-ZIP");
  return res.files;
}

const pendingNames = new Map();
if (chrome.downloads.onDeterminingFilename) {
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    const desired = pendingNames.get(item.url);
    if (!desired) { suggest(); return; }
    pendingNames.delete(item.url);
    suggest({ filename: desired, conflictAction: "uniquify" });
  });
}

function sanitizeFilename(name) {
  const segs = String(name || "").split(/[\\/]+/).map((s) => s.replace(/[<>:"|?*\x00-\x1f]/g, "_").replace(/^[. ]+|[. ]+$/g, "").slice(0, 150)).filter(Boolean);
  return segs.length ? segs.join("/") : "download.mp4";
}

function saveBlob(blobUrl, filename) {
  return new Promise((resolve, reject) => {
    pendingNames.set(blobUrl, filename);
    chrome.downloads.download({ url: blobUrl, filename, saveAs: false }, (downloadId) => {
      if (chrome.runtime.lastError || downloadId === undefined) {
        pendingNames.delete(blobUrl);
        reject(new Error("שגיאה בשמירת הקובץ"));
        return;
      }
      const listener = (delta) => {
        if (delta.id !== downloadId || !delta.state) return;
        if (delta.state.current === "complete" || delta.state.current === "interrupted") {
          chrome.downloads.onChanged.removeListener(listener);
          if (blobUrl.startsWith("blob:")) chrome.runtime.sendMessage({ target: "offscreen", type: "REVOKE", blobUrl }).catch(() => {});
          if (delta.state.current === "complete") resolve(filename);
          else reject(new Error("השמירה הופסקה"));
        }
      };
      chrome.downloads.onChanged.addListener(listener);
    });
  });
}

async function driveJob(jobId) {
  if (driving.has(jobId)) return;
  driving.add(jobId);
  const job = jobs.get(jobId);
  if (!job) { driving.delete(jobId); return; }
  const signal = { get cancelled() { const j = jobs.get(jobId); return !j || j.status === "cancelled"; } };

  try {
    const cfg = await getConfig();
    if (!job.runId) {
      patchJob(jobId, { status: "queued", detail: "מאתר ריצה ב-GitHub...", percent: 10 });
      const runId = await findRun(cfg, job.requestId, signal, job.dispatchedAt);
      patchJob(jobId, { runId });
    }
    patchJob(jobId, { status: "running", detail: "מוריד ב-GitHub Actions...", percent: 30 });
    const conclusion = await waitForRun(cfg, jobs.get(jobId).runId, (run) => {
      patchJob(jobId, { detail: run.status === "queued" ? "ממתין בתור..." : "מעבד ב-GitHub Actions...", percent: 45 });
    }, signal);

    if (conclusion !== "success") throw new Error(`הריצה הסתיימה עם סטטוס: ${conclusion}`);
    patchJob(jobId, { status: "fetching", detail: "מושך קובץ מ-GitHub...", percent: 70 });

    let files = null;
    for (let a = 0; a < 5 && !files; a++) {
      const assets = await findReleaseAssets(cfg, job.requestId).catch(() => null);
      if (assets) {
        const isBundle = job.mode === "collection" || job.mode === "list";
        if (!isBundle && assets.every((x) => /\.zip$/i.test(x.name))) {
          const inner = [];
          for (const x of assets) inner.push(...(await unpackZipUrl(x.url, jobId)));
          files = inner;
        } else {
          files = assets;
        }
        break;
      }
      await sleep(2000);
    }

    if (!files) {
      const res = await ghFetch(`${API}/repos/${cfg.owner}/${cfg.repo}/actions/runs/${jobs.get(jobId).runId}/artifacts`, cfg);
      const list = ((await res.json()).artifacts) || [];
      const found = list.find((x) => x.name === `dl-${job.requestId}`);
      if (!found) throw new Error("לא נמצא תוצר להורדה");
      files = await unpackZipUrl(`${API}/repos/${cfg.owner}/${cfg.repo}/actions/artifacts/${found.id}/zip`, jobId, cfg.token);
    }

    patchJob(jobId, { status: "saving", detail: "שומר במחשב...", percent: 90 });
    const saved = [];
    for (const f of files) {
      const name = sanitizeFilename(f.name);
      await saveBlob(f.url || f.blobUrl, name);
      saved.push(name);
    }
    patchJob(jobId, { status: "completed", detail: "הושלם", files: saved, percent: 100 });
  } catch (err) {
    patchJob(jobId, { status: "failed", detail: err.message, error: err.message });
  } finally {
    driving.delete(jobId);
  }
}

async function startDownload(payload) {
  const cfg = await getConfig();
  if (!cfg.owner || !cfg.repo || !cfg.token || !cfg.cookieKey) {
    return { ok: false, error: "חסרות הגדרות חיבור (owner/repo/token/cookieKey)" };
  }
  const requestId = crypto.randomUUID();
  let cookiesEnc = "";
  const cookies = await exportYoutubeCookies();
  if (cookies) {
    try { cookiesEnc = await encryptCookies(cookies, cfg.cookieKey); }
    catch (e) { return { ok: false, error: e.message }; }
  }
  const mode = payload.mode || "video";
  let urlsJson = "";
  let repUrl = payload.url;
  if (mode === "list") {
    const list = (payload.urls || []).filter(Boolean);
    if (!list.length) return { ok: false, error: "רשימת קישורים ריקה" };
    urlsJson = JSON.stringify(list);
    repUrl = list[0];
  }
  jobs.set(requestId, {
    id: requestId, requestId, url: repUrl, title: payload.title || repUrl,
    quality: payload.quality || "best", mode, status: "preparing", detail: "שולח ל-GitHub...",
    percent: 5, startedAt: Date.now(), dispatchedAt: Date.now(), files: []
  });
  await persistJobs();

  const url = `${API}/repos/${cfg.owner}/${cfg.repo}/actions/workflows/${encodeURIComponent(cfg.workflow)}/dispatches`;
  const res = await ghFetch(url, cfg, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ref: cfg.ref,
      inputs: { request_id: requestId, url: repUrl, quality: payload.quality || "best", mode, urls: urlsJson, cookies_enc: cookiesEnc }
    })
  });
  if (res.status !== 204) {
    patchJob(requestId, { status: "failed", detail: `HTTP ${res.status}`, error: `HTTP ${res.status}` });
    return { ok: false, error: `שגיאה מ-GitHub (HTTP ${res.status})` };
  }
  void driveJob(requestId);
  return { ok: true, jobId: requestId };
}

async function handle(msg) {
  await restoreJobs();
  switch (msg.type) {
    case "GET_PREFS": {
      const cfg = await getConfig();
      return { configured: Boolean(cfg.owner && cfg.repo && cfg.token && cfg.cookieKey), owner: cfg.owner, repo: cfg.repo };
    }
    case "GET_CONFIG": return getConfig();
    case "SET_CONFIG": return setConfig(msg.patch);
    case "RESET_CONFIG": await chrome.storage.local.remove(CFG_KEY); return getConfig();
    case "TEST_CONNECTION": {
      const cfg = await getConfig();
      const res = await ghFetch(`${API}/repos/${cfg.owner}/${cfg.repo}/actions/workflows/${encodeURIComponent(cfg.workflow)}`, cfg);
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      return { ok: true, detail: `${cfg.owner}/${cfg.repo}` };
    }
    case "START_DOWNLOAD": return startDownload(msg.payload);
    case "LIST_JOBS": {
      const plain = {};
      for (const [id, job] of jobs) { plain[id] = job; if (!TERMINAL.has(job.status)) void driveJob(id); }
      return { ok: true, jobs: plain };
    }
    case "CANCEL_JOB": {
      patchJob(msg.jobId, { status: "cancelled", detail: "בוטל" });
      return { ok: true };
    }
    case "OPEN_RUN": {
      const job = jobs.get(msg.jobId);
      const cfg = await getConfig();
      const url = job && job.runId ? `https://github.com/${cfg.owner}/${cfg.repo}/actions/runs/${job.runId}` : `https://github.com/${cfg.owner}/${cfg.repo}/actions`;
      await chrome.tabs.create({ url });
      return { ok: true };
    }
    case "OPEN_DOWNLOADS": chrome.downloads.showDefaultFolder(); return { ok: true };
    case "OPEN_OPTIONS": await chrome.runtime.openOptionsPage(); return { ok: true };
    default: return { ok: false, error: "Unknown command" };
  }
}

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (!msg || msg.target === "offscreen") return undefined;
  handle(msg).then(sendResponse).catch((e) => sendResponse({ ok: false, error: e.message }));
  return true;
});

chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL("panel.html");
  const tabs = await chrome.tabs.query({ url });
  if (tabs.length) await chrome.tabs.update(tabs[0].id, { active: true });
  else await chrome.tabs.create({ url });
});
