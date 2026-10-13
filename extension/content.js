"use strict";
(() => {
  function inject() {
    if (location.pathname !== "/watch") return;
    if (document.querySelector(".ytproxy-btn")) return;
    const bar = document.querySelector("ytd-watch-metadata #top-level-buttons-computed") || document.querySelector("#top-level-buttons-computed");
    if (!bar) return;
    const btn = document.createElement("button");
    btn.className = "ytproxy-btn";
    btn.textContent = "הורדה (Proxy)";
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = "שולח...";
      const res = await chrome.runtime.sendMessage({
        type: "START_DOWNLOAD",
        payload: { url: location.href, title: document.title.replace(/\s*-\s*YouTube$/i, ""), quality: "best", mode: "video" }
      }).catch(() => null);
      btn.textContent = res && res.ok ? "נשלח!" : "שגיאה";
      setTimeout(() => { btn.disabled = false; btn.textContent = "הורדה (Proxy)"; }, 2500);
    };
    bar.appendChild(btn);
  }
  setInterval(inject, 2000);
})();
