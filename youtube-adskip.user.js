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
  // 창이 가려지거나 백그라운드에 있으면 브라우저가 타이머를 1초 이상으로 늦춥니다.
  // 그래서 타이머 대신 영상 이벤트와 클래스 변화 감지로 바로 반응합니다.
  const VIDEO_EVENTS = ["loadstart", "loadedmetadata", "durationchange", "play", "playing", "timeupdate"];

  let inAd = false;
  let wasMuted = false;
  let savedVolume = 1;
  let savedRate = 1;
  let watchedPlayer = null;
  let watchedVideo = null;

  function tick() {
    const player = document.querySelector("#movie_player");
    const video = player && player.querySelector("video");
    if (!player || !video) return;
    watch(player, video);

    const overlayClose = document.querySelector(OVERLAY_CLOSE);
    if (overlayClose) overlayClose.click();

    if (player.classList.contains("ad-showing")) {
      if (!inAd) {
        inAd = true;
        wasMuted = video.muted;
        savedVolume = video.volume;
        savedRate = video.playbackRate || 1;
      }
      video.muted = true;
      video.volume = 0;
      video.playbackRate = 16;
      // 광고 길이를 아직 모르면 loadedmetadata/durationchange 때 다시 시도합니다.
      if (isFinite(video.duration) && video.duration > 0 && video.currentTime < video.duration - 0.2) {
        video.currentTime = video.duration - 0.1;
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

  function watch(player, video) {
    if (player !== watchedPlayer) {
      watchedPlayer = player;
      new MutationObserver(tick).observe(player, { attributes: true, attributeFilter: ["class"] });
    }
    if (video !== watchedVideo) {
      watchedVideo = video;
      for (const ev of VIDEO_EVENTS) video.addEventListener(ev, tick);
    }
  }

  // 플레이어가 아직 없을 때를 위한 보조 확인입니다.
  setInterval(tick, 250);
})();
