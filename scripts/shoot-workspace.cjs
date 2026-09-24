'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS CLI entrypoint. */

/**
 * Screenshot the 会话工作台 the way an agent would see it.
 *
 * There is no browser driver in this repository, and there does not need to be:
 * Edge ships with Windows and can be driven over the DevTools protocol from Node
 * alone. This script opens the real console against the real API, signs the tab
 * in with a token handed to it, clicks one conversation, waits until every image
 * in the transcript has actually decoded, and only then takes the picture.
 *
 * Waiting for `naturalWidth > 0` rather than for a selector is the whole point:
 * an `<img>` whose signed URL was refused still matches `img`, and a screenshot
 * of a broken image is indistinguishable from a screenshot of a slow one. The
 * numbers printed here — decoded sizes plus the media responses the page itself
 * received — are what make the picture evidence.
 *
 *   node scripts/shoot-workspace.cjs --token <bearer> --conversation <id> --out shot.png
 *
 * `--route <hash>` shoots any other page of the console instead — the same
 * sign-in, the same real API, no conversation to open. It waits for the page to
 * render a panel or a state rather than for `.conv-row`, and it reaches the page
 * by assigning `location.hash`, which is the console's own navigation:
 *
 *   node scripts/shoot-workspace.cjs --token <bearer> --route dashboard --out dash.png
 *
 * `--probe <expression>` evaluates one expression in the rendered page and prints
 * what it returned alongside the diagnostics. A screenshot says that a box looks
 * narrow; it cannot say how narrow, and estimating widths off a scaled PNG is how
 * a layout bug survives a picture that "looks fine":
 *
 *   node scripts/shoot-workspace.cjs --token <bearer> --route dashboard \
 *     --probe '[...document.querySelectorAll(".funnel-stage")].map((s) => s.getBoundingClientRect().width)'
 *
 * `--click <selector>` clicks one element of the rendered page and waits a beat,
 * for the things that have to be open before they can be photographed — the
 * account menu in the rail footer, most of all, which is shut in every other
 * shot. `>>` opens one layer after another, which is how a modal behind a menu
 * gets photographed at all. It throws when nothing matches, because a picture of
 * a shut panel and a picture of a panel that never opened are the same picture:
 *
 *   node scripts/shoot-workspace.cjs --token <bearer> --route dashboard \
 *     --click '.dock-trigger' --out dock-open.png \
 *     --click '.dock-trigger >> .dock-entry .dock-row' --out dialog.png
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

/** Where the console is served. Vite binds IPv6 locally, so `localhost` matters. */
const WEB_ORIGIN = 'http://localhost:5173';

/**
 * Where Edge lives when it is not on `PATH`, which on Windows it usually is not.
 *
 * The first location that exists wins; `--browser` overrides both.
 */
const EDGE_CANDIDATES = [
  'msedge',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

/** How long any single step may take before the script gives up. */
const STEP_TIMEOUT_MS = 25_000;

/** Options, from the command line. */
function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue;
    options[argv[index].slice(2)] = argv[index + 1];
    index += 1;
  }
  return options;
}

/**
 * Whether a bare command or a path names something runnable.
 *
 * @param {string} candidate - Command name or absolute path.
 * @returns {boolean} `true` when it can be executed.
 */
function executableExists(candidate) {
  if (candidate.includes(path.sep) || candidate.includes('/')) {
    return fs.existsSync(candidate);
  }
  const extensions = (process.env.PATHEXT ?? '.EXE').split(';');
  return (process.env.PATH ?? '')
    .split(path.delimiter)
    .some((directory) =>
      extensions.some((extension) =>
        fs.existsSync(path.join(directory, `${candidate}${extension.toLowerCase()}`)),
      ),
    );
}

/**
 * A DevTools-protocol client over the WebSocket Node already has.
 *
 * @param {string} url - The page target's debugger URL.
 * @returns {Promise<object>} `send`, `once` and `close`.
 */
async function connect(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  const events = [];
  const listeners = [];
  let nextId = 1;

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined) {
      const entry = pending.get(message.id);
      if (entry !== undefined) {
        pending.delete(message.id);
        entry(message.result ?? {});
      }
      return;
    }
    events.push(message);
    for (const listener of listeners) listener(message);
  });

  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  return {
    /** Run one command and resolve with its result. */
    send(method, params = {}) {
      const id = nextId;
      nextId += 1;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    /** Resolve on the next matching event. */
    once(method) {
      return new Promise((resolve) => {
        listeners.push((message) => {
          if (message.method === method) resolve(message.params);
        });
      });
    },
    /** Every event seen so far. */
    events() {
      return events;
    },
    close() {
      socket.close();
    },
  };
}

/** Say where the script is, so a hang names the step it hung on. */
function step(message) {
  console.error(`shoot-workspace: ${message}`);
}

/** Bound a promise, so a missing event is an error rather than a silence. */
function withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), STEP_TIMEOUT_MS),
    ),
  ]);
}

/** Navigate to a URL and wait until that URL is the loaded document. */
async function navigate(client, url) {
  await client.send('Page.navigate', { url });
  // Waiting on the load event alone is not enough: the *previous* document can
  // still be loading when this one is requested, and its load event resolves the
  // wait while the new document is not there yet. Everything that follows —
  // writing the session token above all — would then run against the old page,
  // and a token written to `about:blank` is a token nobody has.
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  for (;;) {
    const state = await evaluate(
      client,
      `({ href: location.href, ready: document.readyState })`,
    ).catch(() => null);
    // Compared without the hash and without a trailing slash: `startsWith` would
    // accept `/api/v1/health/live` as a match for the origin, and then every step
    // after it would run against the wrong document while looking correct.
    if (
      state !== null &&
      state.ready === 'complete' &&
      state.href.split('#')[0].replace(/\/$/, '') === url.replace(/\/$/, '')
    ) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`the document never became ${url} (it is ${state?.href ?? 'unreachable'})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** Wait for a condition, polling the page. */
async function waitFor(client, expression, label) {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  for (;;) {
    const { result } = await client.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.value === true) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Evaluate an expression in the page and return its value. */
async function evaluate(client, expression) {
  const { result, exceptionDetails } = await client.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (exceptionDetails !== undefined) {
    throw new Error(
      `page threw: ${exceptionDetails.text} ${exceptionDetails.exception?.description ?? ''}`,
    );
  }
  return result.value;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const token = options.token;
  const conversationId = options.conversation;
  // A page to shoot instead of the workspace: the same sign-in, the same real
  // API, no conversation to open. `--conversation` and `--route` are mutually
  // exclusive because each has its own readiness signal.
  const route = options.route;
  const out = options.out ?? (route === undefined ? 'workspace.png' : `${route}.png`);
  if (token === undefined || (conversationId === undefined && route === undefined)) {
    throw new Error(
      'usage: node scripts/shoot-workspace.cjs --token <bearer> ' +
        '(--conversation <id> | --route <hash>) [--out <png>]',
    );
  }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kefu-shoot-'));
  const port = 9333;
  const executable =
    options.browser ?? EDGE_CANDIDATES.find((candidate) => executableExists(candidate));
  if (executable === undefined) {
    throw new Error(`no browser found; looked at ${EDGE_CANDIDATES.join(', ')}`);
  }
  const browser = spawn(
    executable,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--window-size=1440,1000',
      '--force-device-scale-factor=1',
      '--no-first-run',
      '--disable-extensions',
      '--disable-gpu',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let client = null;
  try {
    // The debugger endpoint takes a moment to open, and reports its own version
    // as soon as it is there.
    const deadline = Date.now() + STEP_TIMEOUT_MS;
    let targets = null;
    for (;;) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`);
        targets = await response.json();
        if (targets.length > 0) break;
      } catch {
        // Not listening yet.
      }
      if (Date.now() > deadline)
        throw new Error('the headless browser never opened its debugger port');
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    const page = targets.find((target) => target.type === 'page') ?? targets[0];
    step(`attached to ${page.type} target`);
    client = await withTimeout(connect(page.webSocketDebuggerUrl), 'the debugger socket');
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Network.enable');

    // Sign the tab in *before* the console boots: the token lives in
    // sessionStorage under one key, the console reads it as it mounts, and a
    // fresh profile has none. Writing it from another page of the same origin is
    // the same write the sign-in form makes a moment later.
    //
    // A plain HTML page of that origin, and not the API's JSON: a JSON response
    // is rendered by the browser's own viewer, and the frame that answers
    // `Runtime.evaluate` there is the viewer's, whose storage is not the one the
    // console boots into. The write looks like it worked and is gone by the time
    // the console asks — which is exactly how the first version of this script
    // failed.
    await navigate(client, `${WEB_ORIGIN}/customer.html`);
    const stored = await evaluate(
      client,
      `sessionStorage.setItem('kefu.auth.token', ${JSON.stringify(token)}),
       sessionStorage.getItem('kefu.auth.token').length`,
    );
    if (stored !== token.length) {
      throw new Error(`the session token did not stick (stored ${String(stored)} chars)`);
    }
    step('session stored on the console origin');

    await navigate(client, `${WEB_ORIGIN}/`);
    const survived = await evaluate(
      client,
      `(sessionStorage.getItem('kefu.auth.token') ?? '').length`,
    );
    if (survived !== token.length) {
      throw new Error(
        `the console booted without the session: ${String(survived)} of ${String(token.length)} characters survived`,
      );
    }
    step('console booted with the session');

    if (route !== undefined) {
      // Through the console's own navigation: `App` resolves the hash and mounts
      // the view, so what is photographed is what a typed address produces.
      await evaluate(client, `(location.hash = ${JSON.stringify(`#/${route}`)}), location.hash`);
      // A panel or a state, not a spinner: both are what the console renders,
      // and a picture of `加载中…` would be a picture of a request in flight.
      await waitFor(
        client,
        `[...document.querySelectorAll('.panel-title, .state-title')]
           .some((node) => node.textContent.trim().length > 0
             && node.textContent.trim() !== '加载中…')`,
        `the ${route} page to render`,
      );
      step(`${route} rendered`);
    } else {
      await waitFor(
        client,
        `document.querySelectorAll('.conv-row').length > 0`,
        'the conversation queue',
      );
      step('queue rendered');
      const clicked = await evaluate(
        client,
        `(() => {
         const row = [...document.querySelectorAll('.conv-row')]
           .find((button) => button.textContent.includes(${JSON.stringify(conversationId)}));
         if (row === undefined) return false;
         row.click();
         return true;
       })()`,
      );
      if (clicked !== true) {
        const titles = await evaluate(
          client,
          `[...document.querySelectorAll('.conv-row')].map((b) => b.textContent).slice(0, 5)`,
        );
        throw new Error(
          `the conversation was not in the queue; first rows: ${JSON.stringify(titles)}`,
        );
      }

      step('conversation opened');
      // 页面上一个 <img> 都没有的会话（纯文本往来）以前会等到超时：条件恒假，
      // 而这一页确实没有图片要等。没有图片就没有等待，有图片则至少一张要解码。
      await waitFor(
        client,
        `(() => {
           const images = [...document.querySelectorAll('img')];
           return images.length === 0 || images.some((i) => i.naturalWidth > 0);
         })()`,
        'a decoded image in the transcript',
      );
      step('image decoded');
    }
    // A disclosure that has to be open to be photographed — the account menu at
    // the foot of the rail, most of all, since it is shut in every other shot.
    // `--click '.dock-trigger >> .dock-entry .dock-row'` opens the menu and then
    // the row inside it. The selectors are deliberately the console's own, so
    // the picture is of the real panel and not of a stub.
    if (options.click !== undefined) {
      const steps = options.click.split('>>').map((selector) => selector.trim());
      for (const [index, selector] of steps.entries()) {
        const clicked = await evaluate(
          client,
          `(() => {
             const node = document.querySelector(${JSON.stringify(selector)});
             if (node === null) return null;
             node.click();
             return node.className;
           })()`,
        );
        if (clicked === null) {
          throw new Error(`nothing in the page matched ${selector} (step ${index + 1})`);
        }
        step(`clicked ${selector} (${String(clicked)})`);
        // React renders what that click disclosed on the state it set, so the
        // next selector in the chain is looked up a beat later, not in the same
        // turn as the click that was supposed to reveal it.
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
    }

    // A beat for the remaining rows and the caption layout to settle.
    await new Promise((resolve) => setTimeout(resolve, 800));

    const diagnostics = await evaluate(
      client,
      `(() => {
         const images = [...document.querySelectorAll('img')].map((i) => ({
           src: i.getAttribute('src')?.slice(0, 90),
           natural: [i.naturalWidth, i.naturalHeight],
           complete: i.complete,
         }));
         const placeholders = [...document.querySelectorAll('.message-placeholder')].map((p) => p.textContent.trim());
         const media = performance.getEntriesByType('resource')
           .filter((entry) => entry.name.includes('/api/v1/media/'))
           .map((entry) => ({ url: entry.name.slice(0, 90), bytes: entry.transferSize, duration: Math.round(entry.duration) }));
         return { title: document.title, hash: location.hash, images, placeholders, media };
       })()`,
    );

    const shot = await client.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
    });
    fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));

    // A transcript is a scroll container, so a window-sized shot shows whatever
    // happens to be at the top of it. The second frame exists for the case the
    // acceptance is actually about: every rendering in one picture. The viewport
    // is grown first (a scroll container cannot be captured past its own height)
    // and then scrolled to the end.
    const tall = options.tall;
    if (tall !== undefined) {
      await client.send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 1700,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await evaluate(
        client,
        `(() => {
           const anchor = document.querySelector('img') ?? document.body;
           let container = anchor.parentElement;
           while (container !== null && container.scrollHeight <= container.clientHeight) {
             container = container.parentElement;
           }
           if (container !== null) container.scrollTop = container.scrollHeight;
           return true;
         })()`,
      );
      await new Promise((resolve) => setTimeout(resolve, 700));
      const full = await client.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
      });
      fs.writeFileSync(tall, Buffer.from(full.data, 'base64'));
    }

    console.log(JSON.stringify({ out, tall: options.tall ?? null, ...diagnostics }, null, 2));

    if (options.probe !== undefined) {
      console.log(JSON.stringify({ probe: await evaluate(client, options.probe) }, null, 2));
    }
  } catch (error) {
    // What the page was actually showing, since "the queue never appeared" has
    // half a dozen causes and a screenshot of the login gate is the fastest way
    // to tell them apart.
    if (client !== null) {
      try {
        for (const event of client.events()) {
          if (
            event.method === 'Network.requestWillBeSent' &&
            event.params.request.url.includes('/api/')
          ) {
            console.error(
              `shoot-workspace: → ${event.params.request.method} ${event.params.request.url.slice(0, 110)}`,
            );
          }
          if (event.method === 'Network.loadingFailed') {
            console.error(`shoot-workspace: ✗ ${event.params.errorText}`);
          }
          if (event.method === 'Runtime.exceptionThrown') {
            console.error(
              `shoot-workspace: page threw ${event.params.exceptionDetails.exception?.description?.slice(0, 200) ?? event.params.exceptionDetails.text}`,
            );
          }
        }
        const state = await evaluate(
          client,
          `({
             href: location.href,
             token: (sessionStorage.getItem('kefu.auth.token') ?? '').slice(0, 6),
             text: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 400)
           })`,
        );
        console.error(`shoot-workspace: page state ${JSON.stringify(state)}`);
        const shot = await client.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(`${out}.debug.png`, Buffer.from(shot.data, 'base64'));
        console.error(`shoot-workspace: wrote ${out}.debug.png`);
      } catch {
        // Nothing more to learn from a page that will not answer.
      }
    }
    throw error;
  } finally {
    if (client !== null) client.close();
    browser.kill();
  }
}

main().catch((error) => {
  console.error(`shoot-workspace: ${error.message}`);
  process.exitCode = 1;
});
