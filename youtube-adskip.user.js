// ==UserScript==
// @name         YouTube 광고 자동스킵
// @namespace    https://github.com/neul-lov/youtube-ad-autoskip
// @version      1.3.1
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
  // 광고 영상이 끝난 뒤 나오는 엔드캡("사이트 방문" + "건너뛰기")입니다. 영상과 상관없는 자체 타이머로 돌아가서
  // 영상을 넘겨도 끝나지 않습니다.
  const ENDCAP = ".ytp-ad-action-interstitial";
  const ENDCAP_RETRY_MS = 500;
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
  let bridgeInjected = false;
  let lastEndcapAt = -Infinity;

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
    injectBridge();

    const overlayClose = player.querySelector(OVERLAY_CLOSE);
    if (overlayClose) attempt(() => overlayClose.click());
    skipEndcap(player);

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

  // 엔드캡의 건너뛰기 버튼도 스크립트 클릭은 무시됩니다. 대신 버튼이 내부적으로 부르는 플레이어 API
  // onAdUxClicked("skip-button", 엔드캡 layoutId)를 페이지 쪽에서 직접 부릅니다.
  function skipEndcap(player) {
    const endcap = player.querySelector(ENDCAP);
    if (!endcap || !endcap.getClientRects().length) return;
    const now = performance.now();
    if (now - lastEndcapAt < ENDCAP_RETRY_MS) return;
    lastEndcapAt = now;
    document.dispatchEvent(new CustomEvent("adskip-endcap"));
  }

  // 유저스크립트는 페이지와 분리된 공간에서 돌아 movie_player의 API를 부를 수 없으므로, 작은 스크립트를 페이지에 넣습니다.
  // YouTube의 CSP(nonce)와 Trusted Types를 통과하도록 페이지의 nonce와 TrustedScript를 씁니다. 막히면 아무 일도 일어나지 않습니다.
  function injectBridge() {
    if (bridgeInjected) return;
    bridgeInjected = true;
    attempt(() => {
      let code = `(${pageBridge})();`;
      if (window.trustedTypes && trustedTypes.createPolicy) {
        code = trustedTypes.createPolicy("youtube-adskip", { createScript: (s) => s }).createScript(code);
      }
      const script = document.createElement("script");
      const nonced = document.querySelector("script[nonce]");
      if (nonced && nonced.nonce) script.nonce = nonced.nonce;
      script.textContent = code;
      (document.head || document.documentElement).append(script);
      script.remove();
    });
  }

  // 페이지 안에서 실행되는 코드입니다. 이 함수는 문자열로 바뀌어 들어가므로 바깥 변수를 쓰면 안 됩니다.
  function pageBridge() {
    if (window.__youtubeAdskipBridge) return;
    window.__youtubeAdskipBridge = true;
    document.documentElement.dataset.adskipBridge = "ready";

    // 광고 응답에서 엔드캡 layoutId를 찾습니다. 위치가 두 가지라 둘 다 봅니다.
    function collect(node, ids, depth) {
      if (!node || typeof node !== "object" || depth > 40) return;
      if (Array.isArray(node)) {
        for (const item of node) collect(item, ids, depth + 1);
        return;
      }
      if (typeof node.inPlayerLayoutId === "string") ids.add(node.inPlayerLayoutId);
      const meta = node.adLayoutMetadata;
      if (meta && meta.layoutType === "LAYOUT_TYPE_ENDCAP" && typeof meta.layoutId === "string") ids.add(meta.layoutId);
      for (const key in node) collect(node[key], ids, depth + 1);
    }

    // 영상 중간 광고는 나중에 따로 받아 오므로, 플레이어 응답(/youtubei/v1/player…)을 받을 때 함께 모아 둡니다.
    const seen = new Set();
    const originalFetch = window.fetch;
    window.fetch = function (...args) {
      const result = originalFetch.apply(this, args);
      try {
        const url = String(args[0] && args[0].url || args[0]);
        if (url.includes("/youtubei/v1/player")) {
          result.then((res) => res.clone().json()).then((json) => collect(json, seen, 0)).catch(() => {});
        }
      } catch (e) {}
      return result;
    };

    document.addEventListener("adskip-endcap", () => {
      const player = document.getElementById("movie_player");
      if (!player || typeof player.onAdUxClicked !== "function") return;
      const ids = new Set(seen);
      try { collect(player.getPlayerResponse && player.getPlayerResponse(), ids, 0); } catch (e) {}
      try { collect(window.ytInitialPlayerResponse, ids, 0); } catch (e) {}
      // layoutId가 다른 광고 화면은 이 호출을 무시하므로, 찾은 후보를 모두 넘깁니다.
      for (const id of ids) {
        try { player.onAdUxClicked("skip-button", id); } catch (e) {}
      }
      document.documentElement.dataset.adskipEndcap = String(ids.size);
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
      // 광고 상태(ad-showing class) 변화와 엔드캡 등장(childList)을 감지합니다.
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

  // 플레이어가 아직 없을 때와 멈춘 seek를 다시 시도하기 위한 보조 확인입니다.
  setInterval(tick, 100);
})();
