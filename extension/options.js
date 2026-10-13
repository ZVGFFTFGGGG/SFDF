"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const FIELDS = ["owner", "repo", "workflow", "ref", "token", "cookieKey", "updateOwner", "updateRepo"];
  async function load() {
    const cfg = await chrome.runtime.sendMessage({ type: "GET_CONFIG" });
    if (!cfg) return;
    for (const f of FIELDS) $(f).value = cfg[f] || "";
  }
  $("save").onclick = async () => {
    const patch = {};
    for (const f of FIELDS) patch[f] = $(f).value.trim();
    await chrome.runtime.sendMessage({ type: "SET_CONFIG", patch });
    $("msg").textContent = "ההגדרות נשמרו בהצלחה!";
  };
  $("reset").onclick = async () => {
    await chrome.runtime.sendMessage({ type: "RESET_CONFIG" });
    await load();
    $("msg").textContent = "אופס לברירת המחדל";
  };
  $("recheck").onclick = async () => {
    $("conn-text").textContent = "בודק...";
    const res = await chrome.runtime.sendMessage({ type: "TEST_CONNECTION" });
    $("conn-dot").className = "dot " + (res && res.ok ? "is-ok" : "is-fail");
    $("conn-text").textContent = res && res.ok ? `מחובר: ${res.detail}` : (res && res.error) || "נכשל";
  };
  void load();
})();
