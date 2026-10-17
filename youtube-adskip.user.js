// ==UserScript==
// @name         YouTube 광고 자동스킵
// @namespace    https://github.com/neul-lov/youtube-ad-autoskip
// @version      1.2.0
// @description  광고 동안 음소거하고 광고 끝으로 넘기며, 광고가 끝나면 소리와 재생 속도를 되돌립니다.
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  // 스킵 버튼은 누르지 않습니다. YouTube는 스크립트가 만든 클릭(isTrusted=false)을 스킵으로 처리하지 않고
  // 비정상 활동(onAbnormalityDetected)으로 기록합니다.
  const OVERLAY_CLOSE = ".ytp-ad-overlay-close-button";
  const AD_RATE = 16;
  // 플레이어가 광고를 곧바로 다시 멈추면 play/pause가 끝없이 반복되므로 play() 사이에 간격을 둡니다.
  const PLAY_RETRY_MS = 500;
  // Safari는 데이터가 들어오는 중에 이동하면 seeking 상태로 멈춰 있을 때가 있어, 이 시간이 지나면 다시 이동합니다.
  const SEEK_RETRY_MS = 500;
  // 창이 가려지거나 백그라운드에 있으면 브라우저가 타이머를 1초 이상으로 늦춥니다.
  // 그래서 타이머 대신 영상 이벤트와 클래스 변화 감지로 바로 반응합니다.
  // pause/waiting/seeking/ratechange/volumechange는 광고가 멈추거나 YouTube가 속도·소리를 되돌린 경우를 잡습니다.
  const VIDEO_EVENTS = [
    "loadstart", "loadedmetadata", "loadeddata", "durationchange", "canplay",
    "play", "playing", "pause", "waiting", "seeking", "seeked", "timeupdate", "ended",
    "ratechange", "volumechange",
  ];

  // 광고가 아닐 때 마지막으로 본 재생 속도와 음소거 상태입니다. 광고가 끝나면 이 값으로 되돌립니다.
  let content = null;
  let inAd = false;
  let restorePending = false;
  let lastPlayAt = -Infinity;
  let lastSeekAt = -Infinity;
  let lastSeekTarget = NaN;
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
        lastPlayAt = -Infinity;
        lastSeekAt = -Infinity;
        lastSeekTarget = NaN;
        // 첫 영상 앞 광고처럼 본편 상태를 아직 못 봤다면 지금 값을 기억합니다.
        if (!content) remember(video);
      }
      skipAd(video);
    } else {
      inAd = false;
      if (restorePending) restore(video);
      else remember(video);
    }
  }

  // 동작 하나가 실패해도 나머지는 계속합니다.
  function skipAd(video) {
    if (!video.muted) attempt(() => { video.muted = true; });
    if (video.playbackRate !== AD_RATE) attempt(() => { video.playbackRate = AD_RATE; });
    seekToEnd(video);
    resume(video);
  }

  function seekToEnd(video) {
    // 광고 길이를 아직 모르면 loadedmetadata/durationchange 때 다시 시도합니다.
    const duration = video.duration;
    if (!isFinite(duration) || duration <= 0) return;
    // 재생 중인 광고는 끝 직전으로 보내면 YouTube가 다음 timeupdate에서 바로 끝냅니다.
    // 멈춘 광고는 timeupdate가 나지 않으므로 정확히 끝에 놓아 재생 없이 ended가 나게 합니다.
    const target = video.paused ? duration : duration - 0.1;
    const now = performance.now();
    if (video.seeking) {
      if (now - lastSeekAt > SEEK_RETRY_MS) seek(video, target, now);
      return;
    }
    // 데이터가 하나도 없을 때 이동하면 Safari에서 seeking 상태로 계속 멈춰 있을 수 있어 loadeddata를 기다립니다.
    if (video.readyState < 2) return;
    // 끝으로 보낸 뒤 길이가 아주 조금 늘어나 끝에 못 미치는 경우가 있어, 늘어난 끝으로 바로 다시 보냅니다.
    const behind = video.currentTime < (video.paused ? duration : duration - 0.2);
    const repeat = target === lastSeekTarget && now - lastSeekAt < SEEK_RETRY_MS;
    if (behind && !repeat) seek(video, target, now);
  }

  function seek(video, target, now) {
    lastSeekAt = now;
    lastSeekTarget = target;
    attempt(() => { video.currentTime = target; });
  }

  function resume(video) {
    // 끝에 도달한 영상에 play()를 부르면 처음부터 다시 재생되므로 부르지 않습니다.
    if (!video.paused || video.ended) return;
    const now = performance.now();
    if (now - lastPlayAt < PLAY_RETRY_MS) return;
    lastPlayAt = now;
    attempt(() => {
      const p = video.play();
      if (p) p.catch(() => {});
    });
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
      // 광고 상태(ad-showing class) 변화를 감지합니다.
      playerObserver = new MutationObserver(schedule);
      playerObserver.observe(player, { attributes: true, attributeFilter: ["class"] });
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

  // 플레이어가 아직 없을 때와 멈춘 seek를 다시 시도하기 위한 보조 확인입니다.
  setInterval(tick, 250);
})();
