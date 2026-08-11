/* eslint-env browser */
/**
 * Sustained-playback probe for an in-browser Swarm node (weeb-3). Answers in-browser question 2:
 * can a browser viewer hold 2.86 Mbps, measured as playhead advance per wall second rather than as
 * arithmetic over per-chunk fetches.
 *
 * ⛔ THIS CANNOT RUN IN AN AUTOMATED BROWSER PANE, AND THE SCRIPT REFUSES TO TRY.
 *
 * An agent-driven pane runs as a hidden document that has never had user activation, so autoplay is
 * forbidden and media is suspended. The failure is silent and looks exactly like weeb-3 being unable
 * to deliver: `readyState` sticks at 1, the buffer freezes at a fraction of a second, the second
 * segment request is aborted, and `video.error` stays null because nothing is actually broken. Two
 * sittings lost time to that before the cause was named, so the visibility assertion below is the
 * null control for this instrument and must not be removed to "make it work".
 *
 * ⛔ ONE TAB, and no other weeb-3 tab anywhere. Every tab runs its own libp2p node dialing 160
 * bootnodes and they starve each other: measured 2026-08-11, a second tab halved the newer node's
 * peers and a third left it at zero connected with no error shown. This probe reports `peersAtStart`
 * for exactly that reason. Read it before reading the ratio.
 *
 * HOW TO RUN
 *   1. On the machine, from the repo: `node deploy/scripts/serve-sweep-plan.mjs <any-plan.json>`
 *      (this probe needs no plan, but the server wants the argument).
 *   2. Open https://lat-murmeldjur.github.io/weeb-3/ in a normal Chrome window, with no other
 *      weeb-3 tab open anywhere.
 *   3. Keep the tab visible and focused for the whole run. Do not background it.
 *   4. In the console, one line, which fetches THIS file rather than a pasted copy of it:
 *        fetch('http://127.0.0.1:8899/script/in-browser-sustain.js').then((r) => r.text()).then(eval)
 *      Pasting the file by hand still works and is the fallback if the server is not running.
 *   5. Click the page once when told to. Autoplay needs a real gesture.
 *   6. Wait 12 minutes. It prints a summary and leaves the raw samples on `window.__sustain.samples`.
 *
 * ⚠️ `peers: plateaued at ~140` is the ordinary message, not a fault. `PEER_TARGET` of 190 was set
 * when one load reached 200; the loads measured on 2026-08-11 settled at 134 and 147, so the plateau
 * branch is the one that fires and it costs 20 seconds of quiet before it does.
 *
 * WHAT IT REPORTS
 *   realtimeRatio   playhead seconds gained per wall second. **The verdict. Needs >= 0.999.**
 *   stallCount      samples where the playhead did not move while unpaused
 *   stallSeconds    wall time spent in those samples
 *   startupS        wall seconds from stream attach to the first playhead advance
 *
 * ⚠️ Quote the ratio and the stalls together. A run can average close to 1.0 by racing ahead after
 * each stall, and a viewer experiences the stalls, not the average.
 */
(() => {
  const OWNER = '8d8a30ff4cbcf8ad0e0773547686295f8157feb0';
  const TOPIC = '7fd811aa6aedbced02d010f5e7987039e3a6033dc59bbce668b8515890ed5efd';

  /** Peer buildup is not monotonic: one load stalled at 150/50 and never moved, the next reached 200/0 in 59s. */
  const PEER_TARGET = 190;
  const PEER_QUIET_MS = 20000;
  const PEER_DEADLINE_MS = 240000;
  const SAMPLE_MS = 1000;
  const RUN_MS = 12 * 60 * 1000;
  /**
   * How often to re-read the peer counter during the run.
   *
   * ⛔ The 2026-08-11 run recorded peers only at the start and delivery fell 18% across its twelve
   * minutes, 253 to 207 KB/s, with buffer depth flat. A node losing peers and later content simply
   * being slower to retrieve produce the same shape in those samples, so the finding had to be left
   * as a question. Reading the counter costs one `innerText` regex, so there was never a reason not to.
   */
  const PEER_SAMPLE_EVERY = 10;

  if (document.visibilityState !== 'visible') {
    throw new Error(
      'Refusing to run: document is not visible, so autoplay is blocked and media is suspended. ' +
        'Any number this produced would be a fact about the harness. Run it in a focused Chrome tab.',
    );
  }

  const P = (window.__sustain = {
    state: 'waiting-peers',
    samples: [],
    log: [],
    err: null,
    peersAtStart: null,
    gateReason: null,
  });
  const note = (m) => {
    P.log.push(`[${Math.round(performance.now())}ms] ${m}`);
    console.log('[sustain]', m);
  };

  function readPeers() {
    const text = document.body.innerText || '';
    const connected = text.match(/Connected:\s*(\d+)/);
    const connecting = text.match(/Connecting:\s*(\d+)/);
    return { connected: connected ? +connected[1] : -1, connecting: connecting ? +connecting[1] : -1 };
  }

  async function waitForPeers() {
    const started = performance.now();
    let lastCount = -1;
    let lastChange = started;
    for (;;) {
      const peers = readPeers();
      const now = performance.now();
      if (peers.connected !== lastCount) {
        lastCount = peers.connected;
        lastChange = now;
      }
      if (peers.connected >= PEER_TARGET && peers.connecting === 0) {
        return 'full table';
      }
      if (peers.connected >= 40 && now - lastChange >= PEER_QUIET_MS) {
        return `plateaued at ${peers.connected}`;
      }
      if (now - started >= PEER_DEADLINE_MS) {
        return `deadline at ${peers.connected}`;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  function attachStream() {
    const input = [...document.querySelectorAll('input[type=text]')].find((e) =>
      /stream\/owner\/topic/i.test(e.placeholder || ''),
    );
    if (!input) {
      throw new Error('navigation input not found, the weeb-3 UI has changed');
    }
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setValue.call(input, `/stream/${OWNER}/${TOPIC}`);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (const type of ['keydown', 'keypress', 'keyup']) {
      input.dispatchEvent(
        new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }),
      );
    }
  }

  async function waitForElement(selector, seconds) {
    for (let i = 0; i < seconds; i++) {
      const found = document.querySelector(selector);
      if (found) {
        return found;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    return null;
  }

  /** Autoplay needs a real gesture, and a hidden document never gets one. */
  function waitForGesture() {
    return new Promise((resolve) => {
      if (navigator.userActivation && navigator.userActivation.hasBeenActive) {
        resolve('already activated');
        return;
      }
      note('👉 CLICK ANYWHERE ON THE PAGE NOW to grant autoplay permission.');
      const onClick = () => {
        window.removeEventListener('click', onClick, true);
        resolve('clicked');
      };
      window.addEventListener('click', onClick, true);
    });
  }

  function summarise() {
    const samples = P.samples;
    if (samples.length < 2) {
      return { verdict: 'no samples' };
    }
    const first = samples[0];
    const last = samples[samples.length - 1];
    const wallS = (last.t - first.t) / 1000;
    const playheadS = last.ct - first.ct;
    const stalls = samples.filter((s) => s.stalled);
    return {
      peersAtStart: P.peersAtStart,
      gateReason: P.gateReason,
      samples: samples.length,
      wallS: +wallS.toFixed(1),
      playheadS: +playheadS.toFixed(1),
      realtimeRatio: +(playheadS / wallS).toFixed(4),
      stallCount: stalls.length,
      stallSeconds: +((stalls.length * SAMPLE_MS) / 1000).toFixed(1),
      startupS: P.firstAdvanceAt === undefined ? null : +(P.firstAdvanceAt / 1000).toFixed(1),
      verdict: playheadS / wallS >= 0.999 ? '✅ SUSTAINS' : '⛔ DOES NOT SUSTAIN',
    };
  }

  (async () => {
    try {
      P.gateReason = await waitForPeers();
      P.peersAtStart = readPeers();
      note(`peers: ${P.gateReason}, ${JSON.stringify(P.peersAtStart)}`);

      P.state = 'attaching';
      attachStream();
      const video = await waitForElement('video', 200);
      if (!video) {
        throw new Error('no <video> element appeared within 200s');
      }
      window.__video = video;
      video.muted = true;

      note(await waitForGesture());
      // ⛔ Never await play() bare. It resolves when playback actually BEGINS, so at readyState 0 it
      // stays pending for as long as no data arrives, and the sampler below never starts. A wedged
      // probe then reports nothing at all, which is strictly worse than reporting a stalled stream:
      // "no data ever arrived" is a result, and it is the result this run is most likely to find.
      video.play().then(
        () => note('play() resolved'),
        (e) => note(`play() rejected: ${e.name}`),
      );

      P.state = 'sampling';
      note(`sampling for ${RUN_MS / 60000} minutes`);
      const startedAt = performance.now();
      let previous = null;
      while (performance.now() - startedAt < RUN_MS) {
        const buffered = video.buffered;
        const sample = {
          t: Math.round(performance.now() - startedAt),
          ct: +video.currentTime.toFixed(3),
          rs: video.readyState,
          paused: video.paused,
          buffEnd: buffered.length ? +buffered.end(buffered.length - 1).toFixed(2) : null,
        };
        if (P.samples.length % PEER_SAMPLE_EVERY === 0) {
          const peers = readPeers();
          sample.peers = peers.connected;
          sample.connecting = peers.connecting;
        }
        if (previous && !sample.paused && sample.ct === previous.ct) {
          sample.stalled = true;
        }
        if (previous && sample.ct > previous.ct && P.firstAdvanceAt === undefined) {
          P.firstAdvanceAt = sample.t;
        }
        P.samples.push(sample);
        previous = sample;
        if (video.paused && video.readyState >= 2) {
          try {
            await video.play();
          } catch (e) {
            /* a rejected resume is recorded by the paused flag on the next sample */
          }
        }
        await new Promise((r) => setTimeout(r, SAMPLE_MS));
      }
      P.state = 'done';
      P.summary = summarise();
      console.table(P.summary);
      note('done. Raw samples on window.__sustain.samples');
    } catch (e) {
      P.err = String(e);
      P.state = 'error';
      console.error('[sustain]', e);
    }
  })();

  return 'armed. Keep this tab visible and focused.';
})();
