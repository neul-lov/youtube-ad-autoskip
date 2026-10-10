// ==UserScript==
// @name         YouTube 광고 자동스킵
// @description  광고 동안 음소거하고 빨리감기·스킵하며, 광고가 끝나면 소리를 되돌립니다.
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  const SKIP_SELECTORS = [
    ".ytp-skip-ad-button",
    ".ytp-ad-skip-button",
    ".ytp-ad-skip-button-modern",
    ".ytp-ad-skip-button-slot button",
  ];
  const OVERLAY_CLOSE = ".ytp-ad-overlay-close-button";

  let inAd = false;
  let wasMuted = false;
  let savedVolume = 1;
  let savedRate = 1;

  function tick() {
    const player = document.querySelector("#movie_player");
    const video = player && player.querySelector("video");
    if (!player || !video) return;

    const overlayClose = document.querySelector(OVERLAY_CLOSE);
    if (overlayClose) overlayClose.click();

    if (player.classList.contains("ad-showing")) {
      if (!inAd) {
        inAd = true;
        wasMuted = video.muted;
        savedVolume = video.volume;
        savedRate = video.playbackRate || 1;
      }
      // 스킵 버튼이 있든 없든 광고 동안은 항상 무음으로 유지합니다.
      video.muted = true;
      video.volume = 0;
      video.playbackRate = 16;
      if (isFinite(video.duration) && video.duration > 0) {
        video.currentTime = Math.max(0, video.duration - 0.1);
      }
      for (const sel of SKIP_SELECTORS) {
        const btn = document.querySelector(sel);
        if (btn) btn.click();
      }
    } else if (inAd) {
      inAd = false;
      video.playbackRate = savedRate;
      video.volume = savedVolume;
      video.muted = wasMuted;
    }
  }

  setInterval(tick, 100);
})();
