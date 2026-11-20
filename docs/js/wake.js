// Keeps the screen on while captions are running.
//
// Uses the Screen Wake Lock API where it works. On older iPhones (and older
// Home Screen web apps) that API is missing or refuses, so we fall back to
// quietly playing a tiny silent video, which also stops the screen dimming.

let wanted = false;
let sentinel = null;
let video = null;

async function acquire() {
  if (!wanted || document.visibilityState !== 'visible' || sentinel) return;
  if ('wakeLock' in navigator) {
    try {
      const lock = await navigator.wakeLock.request('screen');
      if (!wanted) {
        lock.release().catch(() => {});
        return;
      }
      sentinel = lock;
      lock.addEventListener('release', () => {
        if (sentinel === lock) sentinel = null;
      });
      stopVideo();
      return;
    } catch (e) {
      // Not allowed here: use the fallback below.
    }
  }
  startVideo();
}

function startVideo() {
  if (video) return;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 2;
    const g = canvas.getContext('2d');
    let flip = false;
    const paint = () => {
      flip = !flip;
      g.fillStyle = flip ? '#000000' : '#010101';
      g.fillRect(0, 0, 2, 2);
    };
    paint();
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.setAttribute('muted', '');
    v.setAttribute('playsinline', '');
    v.setAttribute('aria-hidden', 'true');
    v.style.cssText =
      'position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0.01;pointer-events:none;';
    v.srcObject = canvas.captureStream(1);
    document.body.appendChild(v);
    v._timer = setInterval(paint, 1000);
    const playing = v.play();
    if (playing && playing.catch) playing.catch(() => {});
    video = v;
  } catch (e) {
    video = null;
  }
}

function stopVideo() {
  if (!video) return;
  clearInterval(video._timer);
  try {
    video.pause();
    video.srcObject = null;
  } catch (e) {}
  video.remove();
  video = null;
}

/** Turn "keep the screen on" on or off. */
export function keepAwake(on) {
  wanted = !!on;
  if (wanted) {
    acquire();
  } else {
    if (sentinel) sentinel.release().catch(() => {});
    sentinel = null;
    stopVideo();
  }
}

// The lock is dropped whenever the app goes to the background; take it again on return.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') acquire();
});
