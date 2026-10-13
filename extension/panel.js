"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const formatSelect = $("formatSelect");
  for (const p of self.YTPROXY_PRESETS) {
    const opt = document.createElement("option");
    opt.value = p.quality;
    opt.textContent = p.label;
    formatSelect.append(opt);
  }

  $("settingsBtn").onclick = () => chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" });

  $("downloadBtn").onclick = async () => {
    const raw = $("urlInput").value.trim();
    if (!raw) return;
    const urls = raw.split(/[\s,]+/).filter((u) => u.startsWith("http"));
    if (!urls.length) { $("hint").textContent = "קישור לא תקין"; return; }
    const payload = urls.length > 1
      ? { urls, quality: formatSelect.value, mode: "list" }
      : { url: urls[0], quality: formatSelect.value, mode: $("collectionToggle").checked ? "collection" : "video" };
    $("hint").textContent = "שולח בקשה...";
    const res = await chrome.runtime.sendMessage({ type: "START_DOWNLOAD", payload });
    if (res && res.ok) {
      $("urlInput").value = "";
      $("hint").textContent = "נשלח ל-GitHub Actions!";
      void refresh();
    } else {
      $("hint").textContent = (res && res.error) || "שגיאה";
    }
  };

  function renderJobs(jobsObj) {
    const list = $("jobList");
    list.replaceChildren();
    const ids = Object.keys(jobsObj || {}).sort((a, b) => (jobsObj[b].startedAt || 0) - (jobsObj[a].startedAt || 0));
    if (!ids.length) {
      list.textContent = "אין הורדות פעילות";
      return;
    }
    for (const id of ids) {
      const j = jobsObj[id];
      const card = document.createElement("div");
      card.style.cssText = "background:var(--surface-2);padding:10px;border-radius:8px;display:flex;flex-direction:column;gap:6px;";
      const title = document.createElement("div");
      title.style.fontWeight = "600";
      title.textContent = (j.files && j.files[0]) || j.title || j.url;
      const info = document.createElement("div");
      info.className = "small muted";
      info.textContent = `${j.detail || j.status} (${j.percent || 0}%)`;
      const actions = document.createElement("div");
      actions.style.cssText = "display:flex;gap:6px;";
      if (j.runId) {
        const b = document.createElement("button");
        b.className = "btn";
        b.textContent = "פתח ב-GitHub";
        b.onclick = () => chrome.runtime.sendMessage({ type: "OPEN_RUN", jobId: j.id });
        actions.append(b);
      }
      if (j.status === "completed") {
        const b = document.createElement("button");
        b.className = "btn btn--primary";
        b.textContent = "תיקיית הורדות";
        b.onclick = () => chrome.runtime.sendMessage({ type: "OPEN_DOWNLOADS" });
        actions.append(b);
      }
      card.append(title, info, actions);
      list.append(card);
    }
  }

  async function refresh() {
    const prefs = await chrome.runtime.sendMessage({ type: "GET_PREFS" });
    $("conn-dot").className = "dot " + (prefs && prefs.configured ? "is-ok" : "is-fail");
    $("conn-text").textContent = prefs && prefs.configured ? `${prefs.owner}/${prefs.repo}` : "לא מוגדר — לחץ על הגדרות";
    const res = await chrome.runtime.sendMessage({ type: "LIST_JOBS" });
    if (res && res.jobs) renderJobs(res.jobs);
  }

  chrome.runtime.onMessage.addListener((m) => { if (m && m.type === "JOBS_CHANGED") renderJobs(m.jobs); });
  setInterval(refresh, 3000);
  void refresh();
})();
