// ==UserScript==
// @name         YouTube 광고 자동스킵
// @namespace    https://github.com/neul-lov/youtube-ad-autoskip
// @version      1.1.0
// @description  광고 동안 음소거하고 빨리감기·스킵하며, 광고가 끝나면 소리와 재생 속도를 되돌립니다.
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
    ".ytp-ad-skip-button-container button",
    "button[id^='skip-button']",
  ].join(",");
  const OVERLAY_CLOSE = ".ytp-ad-overlay-close-button";
  const AD_RATE = 16;
  // 창이 가려지거나 백그라운드에 있으면 브라우저가 타이머를 1초 이상으로 늦춥니다.
  // 그래서 타이머 대신 영상 이벤트와 DOM 변화 감지로 바로 반응합니다.
  // pause/waiting/ratechange/volumechange는 광고가 멈추거나 YouTube가 속도·소리를 되돌린 경우를 잡습니다.
  const VIDEO_EVENTS = [
    "loadstart", "loadedmetadata", "durationchange", "canplay",
    "play", "playing", "pause", "waiting", "seeked", "timeupdate", "ended",
    "ratechange", "volumechange",
  ];

  // 광고가 아닐 때 마지막으로 본 재생 속도와 음소거 상태입니다. 광고가 끝나면 이 값으로 되돌립니다.
  let content = null;
  let inAd = false;
  let restorePending = false;
  let watchedPlayer = null;
  let playerObserver = null;
  let watchedVideo = null;
  let scheduled = false;

  // 이벤트가 한꺼번에 몰려도 한 번만 처리합니다.
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      tick();
    });
  }

  function tick() {
    const player = document.querySelector("#movie_player");
    const video = player && player.querySelector("video");
    if (!player || !video) return;
    watch(player, video);

    const overlayClose = player.querySelector(OVERLAY_CLOSE);
    if (overlayClose) attempt(() => overlayClose.click());

    if (player.classList.contains("ad-showing")) {
      if (!inAd) {
        inAd = true;
        restorePending = true;
        // 첫 영상 앞 광고처럼 본편 상태를 아직 못 봤다면 지금 값을 기억합니다.
        if (!content) remember(video);
      }
      skipAd(player, video);
    } else {
      inAd = false;
      if (restorePending) restore(video);
      else remember(video);
    }
  }

  function skipAd(player, video) {
    // 스킵 버튼을 먼저 누르고, 이후 동작 하나가 실패해도 나머지는 계속합니다.
    for (const btn of player.querySelectorAll(SKIP_SELECTORS)) attempt(() => btn.click());
    if (!video.muted) attempt(() => { video.muted = true; });
    if (video.playbackRate !== AD_RATE) attempt(() => { video.playbackRate = AD_RATE; });
    // 광고 길이를 아직 모르면 loadedmetadata/durationchange 때 다시 시도합니다.
    const duration = video.duration;
    if (isFinite(duration) && duration > 0 && video.currentTime < duration - 0.2) {
      attempt(() => { video.currentTime = duration - 0.1; });
    }
    // 광고가 멈춰 있으면 끝 지점에 도달하지 못해 넘어가지 않으므로 다시 재생합니다.
    if (video.paused && !video.ended) {
      attempt(() => {
        const p = video.play();
        if (p) p.catch(() => {});
      });
    }
  }

  function restore(video) {
    if (content) {
      // 광고 속도(16배)나 새 영상을 불러올 때 초기화된 기본 속도로 남아 있으면 본편 속도로 되돌립니다.
      // 그 밖의 값은 YouTube가 이미 정한 것이므로 건드리지 않습니다.
      const rate = video.playbackRate;
      if (rate !== content.rate && (rate === AD_RATE || rate === video.defaultPlaybackRate)) {
        attempt(() => { video.playbackRate = content.rate; });
      }
      if (video.muted !== content.muted) attempt(() => { video.muted = content.muted; });
    }
    // 본편을 불러오며 YouTube가 값을 덮어쓸 수 있어, 본편이 실제로 재생될 때까지 확인합니다.
    if (!video.paused && video.playbackRate !== AD_RATE) restorePending = false;
  }

  function remember(video) {
    content = { rate: video.playbackRate, muted: video.muted };
  }

  function watch(player, video) {
    if (player !== watchedPlayer) {
      if (playerObserver) playerObserver.disconnect();
      watchedPlayer = player;
      // 광고 상태(class)와 스킵 버튼 등장(childList)을 감지합니다.
      playerObserver = new MutationObserver(schedule);
      playerObserver.observe(player, { attributes: true, attributeFilter: ["class"], childList: true, subtree: true });
    }
    if (video !== watchedVideo) {
      if (watchedVideo) for (const ev of VIDEO_EVENTS) watchedVideo.removeEventListener(ev, schedule);
      watchedVideo = video;
      for (const ev of VIDEO_EVENTS) video.addEventListener(ev, schedule);
    }
  }

  function attempt(fn) {
    try {
      fn();
    } catch (e) {
      // 한 동작이 막혀도 다른 스킵 시도는 계속되어야 합니다.
    }
  }

  // 플레이어가 아직 없을 때를 위한 보조 확인입니다.
  setInterval(tick, 250);
})();
