/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Tests that letterboxing magnifies the rounded browser until it reaches the
 * edge of the available space along one axis. The viewport size reported to
 * the page must stay rounded, tabs which are exempt from letterboxing or in DOM
 * fullscreen must not be scaled, and the page must not be able to measure the
 * scale through input events.
 */

const { RFPHelper } = ChromeUtils.importESModule(
  "resource://gre/modules/RFPHelper.sys.mjs"
);

// The window is resized many times, which is slow in debug builds.
requestLongerTimeout(2);

const DEFAULT_URL = TEST_PATH + "file_dummy.html";

// Outer window sizes, as in browser_dynamical_window_rounding.js.
const TEST_CASES = [
  { width: 1250, height: 1000 },
  { width: 1120, height: 760 },
  { width: 800, height: 600 },
  { width: 640, height: 400 },
];

// Tolerance, in CSS pixels, when comparing the browser with its stack.
const EPSILON = 1;

// Tolerance when comparing scale factors.
const SCALE_EPSILON = 0.01;

function matchesSteppedSize(aContent, aTarget) {
  // See handleOSFuzziness() in browser_dynamical_window_rounding.js.
  if (Services.appinfo.OS == "WINNT") {
    return Math.abs(aContent - aTarget) <= 1;
  }
  return aContent == aTarget;
}

async function resizeWindow(aWindow, aWidth, aHeight) {
  if (aWindow.outerWidth == aWidth && aWindow.outerHeight == aHeight) {
    return;
  }
  let resized = BrowserTestUtils.waitForEvent(aWindow, "resize");
  aWindow.resizeTo(aWidth, aHeight);
  await resized;
}

async function getChromeState(aTab) {
  let browser = aTab.linkedBrowser;
  let win = browser.documentGlobal;
  return win.promiseDocumentFlushed(() => {
    let container = win.gBrowser.getBrowserContainer(browser);
    return {
      containerWidth: container.clientWidth,
      containerHeight: container.clientHeight,
      stack: browser.parentElement.getBoundingClientRect(),
      visual: browser.getBoundingClientRect(),
      layoutWidth: browser.clientWidth,
      layoutHeight: browser.clientHeight,
      scale: win.getComputedStyle(browser).scale,
    };
  });
}

async function getState(aTab) {
  let state = await getChromeState(aTab);
  state.pageSize = await SpecialPowers.spawn(aTab.linkedBrowser, [], () => ({
    width: content.innerWidth,
    height: content.innerHeight,
  }));
  return state;
}

function isRounded(aState) {
  return (
    matchesSteppedSize(
      aState.pageSize.width,
      RFPHelper.steppedSize(aState.containerWidth, true)
    ) &&
    matchesSteppedSize(
      aState.pageSize.height,
      RFPHelper.steppedSize(aState.containerHeight)
    )
  );
}

function getFit(aState) {
  let { stack, visual } = aState;
  return {
    fillsWidth: Math.abs(visual.width - stack.width) <= EPSILON,
    fillsHeight: Math.abs(visual.height - stack.height) <= EPSILON,
  };
}

function isScaledToFit(aState) {
  let { fillsWidth, fillsHeight } = getFit(aState);
  // The browser size can be stale while the window is resized, in which case
  // the browser is shrunk to fit.
  return (
    aState.scale != "none" &&
    aState.visual.width / aState.layoutWidth >= 1 - SCALE_EPSILON &&
    (fillsWidth || fillsHeight)
  );
}

function checkScaledToFit(aState, aCaseString) {
  let { stack, visual, layoutWidth, layoutHeight, pageSize } = aState;
  let scaleX = visual.width / layoutWidth;
  let scaleY = visual.height / layoutHeight;
  let { fillsWidth, fillsHeight } = getFit(aState);

  ok(
    isRounded(aState),
    `${aCaseString}: The page viewport stays rounded (${pageSize.width}x${pageSize.height} in ${aState.containerWidth}x${aState.containerHeight}).`
  );
  Assert.lessOrEqual(
    Math.abs(scaleX - scaleY),
    SCALE_EPSILON,
    `${aCaseString}: The browser is scaled uniformly (${scaleX}, ${scaleY}).`
  );
  Assert.greaterOrEqual(
    scaleX,
    1 - SCALE_EPSILON,
    `${aCaseString}: The rounded browser is magnified, never shrunk.`
  );
  Assert.lessOrEqual(
    visual.width,
    stack.width + EPSILON,
    `${aCaseString}: The scaled browser fits horizontally.`
  );
  Assert.lessOrEqual(
    visual.height,
    stack.height + EPSILON,
    `${aCaseString}: The scaled browser fits vertically.`
  );
  ok(
    fillsWidth || fillsHeight,
    `${aCaseString}: The scaled browser fills the stack along one axis (${visual.width}x${visual.height} in ${stack.width}x${stack.height}).`
  );
  Assert.lessOrEqual(
    Math.abs(visual.top - stack.top),
    EPSILON,
    `${aCaseString}: The scaled browser stays attached to the top.`
  );
  Assert.lessOrEqual(
    Math.abs(visual.left - stack.left - (stack.right - visual.right)),
    EPSILON,
    `${aCaseString}: The scaled browser stays horizontally centered.`
  );
}

function checkNotScaled(aState, aDetail) {
  let { stack, visual } = aState;
  is(aState.scale, "none", `The browser is not scaled (${aDetail}).`);
  is(
    visual.width,
    stack.width,
    `The browser is as wide as its stack (${aDetail}).`
  );
  is(
    visual.height,
    stack.height,
    `The browser is as tall as its stack (${aDetail}).`
  );
}

async function waitForScale(aTab, aPredicate, aMessage) {
  let state;
  await TestUtils.waitForCondition(async () => {
    state = await getChromeState(aTab);
    return aPredicate(state.scale);
  }, aMessage);
  return state;
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [["privacy.resistFingerprinting.letterboxing", true]],
  });
  await TestUtils.waitForCondition(
    () => gBrowser.tabpanels.classList.contains("letterboxing-ready"),
    "Letterboxing is ready."
  );
});

add_task(async function test_scale_to_fit() {
  let originalWidth = window.outerWidth;
  let originalHeight = window.outerHeight;
  let tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, DEFAULT_URL);

  for (let { width, height } of TEST_CASES) {
    let caseString = `Case ${width}x${height}`;
    info(`${caseString}: Resize the window.`);
    await resizeWindow(window, width, height);

    // The window can report intermediate sizes and letterboxing can round
    // more than once before it settles (see
    // browser_dynamical_window_rounding.js), so wait for a consistent state
    // and then assert it once.
    let state;
    await TestUtils.waitForCondition(async () => {
      state = await getState(tab);
      return isRounded(state) && isScaledToFit(state);
    }, `${caseString}: Wait until the browser is rounded and scaled.`).catch(
      () => {}
    );
    checkScaledToFit(state, caseString);
  }

  BrowserTestUtils.removeTab(tab);
  await resizeWindow(window, originalWidth, originalHeight);
});

add_task(async function test_no_scaling_without_letterboxing() {
  let tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, DEFAULT_URL);
  await waitForScale(
    tab,
    scale => scale != "none",
    "The browser is scaled while letterboxing is enabled."
  );

  await SpecialPowers.pushPrefEnv({
    set: [["privacy.resistFingerprinting.letterboxing", false]],
  });
  let state = await waitForScale(
    tab,
    scale => scale == "none",
    "The browser stops being scaled when letterboxing is disabled."
  );
  checkNotScaled(state, "letterboxing is disabled");

  await SpecialPowers.popPrefEnv();
  await waitForScale(
    tab,
    scale => scale != "none",
    "The browser is scaled again when letterboxing is re-enabled."
  );
  await TestUtils.waitForCondition(
    () => gBrowser.tabpanels.classList.contains("letterboxing-ready"),
    "Letterboxing is ready again."
  );

  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_no_scaling_for_exempt_tabs() {
  let tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "about:config"
  );
  checkNotScaled(await getChromeState(tab), "about:config");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_no_scaling_in_fullscreen() {
  let tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, DEFAULT_URL);
  await waitForScale(
    tab,
    scale => scale != "none",
    "The browser is scaled before entering fullscreen."
  );

  let { promise: focusPromise, resolve } = Promise.withResolvers();
  SimpleTest.waitForFocus(resolve, tab.linkedBrowser.documentGlobal);
  await focusPromise;

  let fullscreenPromise = BrowserTestUtils.waitForContentEvent(
    tab.linkedBrowser,
    "fullscreenchange"
  );
  await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    await content.document.body.requestFullscreen();
  });
  await fullscreenPromise;
  checkNotScaled(await getChromeState(tab), "fullscreen");

  fullscreenPromise = BrowserTestUtils.waitForContentEvent(
    tab.linkedBrowser,
    "fullscreenchange"
  );
  await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    await content.document.exitFullscreen();
  });
  await fullscreenPromise;
  await waitForScale(
    tab,
    scale => scale != "none",
    "The browser is scaled again after leaving fullscreen."
  );

  BrowserTestUtils.removeTab(tab);
});

// Resizes the window so that the content area is aWidth x aHeight. This
// resizes relative to the measured content area, since outerWidth and
// outerHeight can be out of date, for example in headless mode after other
// tests resized the window beyond the screen.
async function resizeContentArea(aWidth, aHeight) {
  let container = gBrowser.getBrowserContainer(gBrowser.selectedBrowser);
  for (let i = 0; i < 4; i++) {
    let width = container.clientWidth;
    let height = container.clientHeight;
    if (width == aWidth && height == aHeight) {
      return;
    }
    window.resizeBy(aWidth - width, aHeight - height);
    await TestUtils.waitForCondition(
      () => container.clientWidth != width || container.clientHeight != height,
      "The content area changes size."
    ).catch(() => {});
  }
}

// Opens a tab and makes letterboxing magnify it by more than 10%.
async function openMagnifiedTab() {
  let tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, DEFAULT_URL);
  // Just below a step in both dimensions, so that the rounded size is much
  // smaller than the content area.
  await resizeContentArea(1190, 790);
  let state;
  await TestUtils.waitForCondition(async () => {
    state = await getChromeState(tab);
    return (
      state.scale != "none" && state.visual.width / state.layoutWidth > 1.1
    );
  }, "The browser is magnified by more than 10%.").catch(aError => {
    info(
      `Window ${window.outerWidth}x${window.outerHeight} on a ` +
        `${screen.availWidth}x${screen.availHeight} screen, browser ` +
        `${JSON.stringify(state)}`
    );
    throw aError;
  });
  return tab;
}

// Calls aMeasure with a tab that letterboxing magnifies, and then again with
// the magnification overridden in the style of the browser, which leaves the
// rounded size of the browser as it is, and returns both results.
async function measureWithAndWithoutScale(aMeasure) {
  let originalWidth = window.outerWidth;
  let originalHeight = window.outerHeight;
  let tab = await openMagnifiedTab();
  try {
    let scaled = await aMeasure(tab);
    tab.linkedBrowser.style.setProperty("scale", "none", "important");
    await waitForScale(
      tab,
      scale => scale == "none",
      "The browser is not scaled while its scale is overridden."
    );
    let unscaled = await aMeasure(tab);
    return { scaled, unscaled };
  } finally {
    BrowserTestUtils.removeTab(tab);
    await resizeWindow(window, originalWidth, originalHeight);
  }
}

// Returns the center of the browser in screen device pixels.
function getBrowserCenterOnScreen(aBrowser) {
  let rect = aBrowser.getBoundingClientRect();
  let scale = window.devicePixelRatio;
  return {
    x: Math.round(
      (window.mozInnerScreenX + rect.left + rect.width / 2) * scale
    ),
    y: Math.round(
      (window.mozInnerScreenY + rect.top + rect.height / 2) * scale
    ),
  };
}

// Waits until the chrome document has painted, so that APZ knows about the
// latest scale.
function waitForChromePaint() {
  return new Promise(resolve =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  );
}

// Native mouse moves can't be synthesized on Wayland (bug 1857059).
function canSynthesizeNativeMouseMoves() {
  return (
    AppConstants.platform != "linux" ||
    Cc["@mozilla.org/gfx/info;1"].getService(Ci.nsIGfxInfo).windowProtocol !=
      "wayland"
  );
}

// Calls aGetValues until it returns the same values twice in a row.
async function waitForStableValues(aGetValues, aMessage) {
  let values;
  await TestUtils.waitForCondition(async () => {
    let previous = values;
    values = await aGetValues();
    return JSON.stringify(values) == JSON.stringify(previous);
  }, aMessage);
  return values;
}

// Calls aScroll with a point in the chrome document to scroll aBrowser, and
// returns the pixel deltas that the page received in wheel events and the
// distance that it scrolled. If aTransform is given, the input scrolls a
// fixed-position scroller with that transform instead of the page.
async function measureWheelScrolling(aBrowser, aScroll, aTransform) {
  await waitForChromePaint();
  let { start, center } = await SpecialPowers.spawn(
    aBrowser,
    [aTransform],
    async aScrollerTransform => {
      let doc = content.document;
      let root = doc.documentElement;
      if (!root.dataset.reportedDelta) {
        doc.body.style.height = "100000px";
        content.addEventListener(
          "wheel",
          event => {
            if (event.deltaMode == event.DOM_DELTA_PIXEL) {
              root.dataset.reportedDelta =
                Number(root.dataset.reportedDelta) + event.deltaY;
            }
          },
          { passive: true }
        );
      }
      root.dataset.reportedDelta = 0;
      let scroller = doc.scrollingElement;
      if (aScrollerTransform) {
        scroller = doc.getElementById("scroller");
        if (!scroller) {
          scroller = doc.createElement("div");
          scroller.id = "scroller";
          scroller.style.cssText =
            "position: fixed; left: 100px; top: 100px; width: 400px;" +
            "height: 300px; overflow: scroll; transform-origin: 0 0;";
          let child = doc.createElement("div");
          child.style.height = "100000px";
          scroller.append(child);
          doc.body.append(scroller);
        }
        scroller.style.transform = aScrollerTransform;
      }
      scroller.scrollTop = 10000;
      await new Promise(resolve =>
        content.requestAnimationFrame(() =>
          content.requestAnimationFrame(resolve)
        )
      );
      // Wait until APZ knows the new size and scroll offset of the scroller,
      // since it can ignore the first wheel events before that.
      await new Promise(resolve => {
        let flushed = () => {
          SpecialPowers.Services.obs.removeObserver(
            flushed,
            "apz-repaints-flushed"
          );
          resolve();
        };
        SpecialPowers.Services.obs.addObserver(flushed, "apz-repaints-flushed");
        if (!SpecialPowers.getDOMWindowUtils(content).flushApzRepaints()) {
          flushed();
        }
      });
      let rect = aScrollerTransform
        ? scroller.getBoundingClientRect()
        : new content.DOMRect(0, 0, content.innerWidth, content.innerHeight);
      return {
        start: scroller.scrollTop,
        center: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
      };
    }
  );

  // Map the center of the scroller into the chrome document.
  let rect = aBrowser.getBoundingClientRect();
  let scale = rect.width / aBrowser.clientWidth;
  await aScroll({
    x: rect.left + center.x * scale,
    y: rect.top + center.y * scale,
  });

  let [reported, scrolled] = await waitForStableValues(
    () =>
      SpecialPowers.spawn(aBrowser, [start, !!aTransform], (aStart, aFixed) => {
        let doc = content.document;
        let scroller = aFixed
          ? doc.getElementById("scroller")
          : doc.scrollingElement;
        return [
          Number(doc.documentElement.dataset.reportedDelta),
          scroller.scrollTop - aStart,
        ];
      }),
    "Wait for the scrolling to finish."
  );
  return { reported, scrolled };
}

// Pans with the touchpad at aPoint in the chrome document.
async function panWithTouchpad(aPoint) {
  // About 20 screen pixels per event. GTK multiplies its deltas by
  // apz.gtk.pangesture.pixel_delta_mode_multiplier and inverts them.
  const delta =
    AppConstants.platform == "linux" && !SpecialPowers.isHeadless ? -0.5 : 20;
  let x = Math.round(
    (window.mozInnerScreenX + aPoint.x) * window.devicePixelRatio
  );
  let y = Math.round(
    (window.mozInnerScreenY + aPoint.y) * window.devicePixelRatio
  );
  let utils = window.windowUtils;
  let pan = (aPhase, aDelta) =>
    new Promise(resolve =>
      utils.sendNativeTouchpadPan(aPhase, x, y, 0, aDelta, 0, resolve)
    );
  await pan(utils.PHASE_BEGIN, delta);
  for (let i = 0; i < 10; i++) {
    await new Promise(resolve => requestAnimationFrame(resolve));
    await pan(utils.PHASE_UPDATE, delta);
  }
  await pan(utils.PHASE_END, 0);
}

// Scrolls at aPoint in the chrome document with wheel events in pixels, which
// precise mice and touchpads send on some platforms.
async function scrollWithPixelWheel(aPoint) {
  for (let i = 0; i < 10; i++) {
    EventUtils.synthesizeWheelAtPoint(
      aPoint.x,
      aPoint.y,
      { deltaMode: WheelEvent.DOM_DELTA_PIXEL, deltaY: 20, asyncEnabled: true },
      window
    );
    await new Promise(resolve => requestAnimationFrame(resolve));
  }
}

// The page receives the unscaled pixel deltas in wheel events, so it must also
// scroll by the unscaled deltas when aScroll scrolls it. Otherwise it could
// compute the scale, and with it the real size of the content area, from the
// ratio. See measureWheelScrolling() for aTransform.
async function checkWheelScrollingIsNotScaled(aScroll, aTransform) {
  await SpecialPowers.pushPrefEnv({
    set: [
      // Only measure the scrolling caused by the input itself.
      ["general.smoothScroll", false],
      ["apz.gtk.kinetic_scroll.enabled", false],
    ],
  });
  let { scaled, unscaled } = await measureWithAndWithoutScale(tab =>
    measureWheelScrolling(tab.linkedBrowser, aScroll, aTransform)
  );

  Assert.greaterOrEqual(
    Math.abs(unscaled.reported),
    100,
    "The page received pixel deltas."
  );
  is(
    scaled.reported,
    unscaled.reported,
    "The page receives the same deltas with and without the scale."
  );
  // Without compensating for the scale, the page would scroll by less than 91%
  // of the distance, since openMagnifiedTab() makes the scale larger than 1.1.
  Assert.lessOrEqual(
    Math.abs(scaled.scrolled - unscaled.scrolled),
    1,
    `The page scrolls by the same distance with and without the scale (${scaled.scrolled} vs ${unscaled.scrolled}).`
  );
  if (!aTransform) {
    Assert.lessOrEqual(
      Math.abs(Math.abs(scaled.scrolled) - Math.abs(scaled.reported)),
      1,
      `The page scrolls by the deltas that it receives (${scaled.scrolled} vs ${scaled.reported}).`
    );
  }

  await SpecialPowers.popPrefEnv();
}

add_task(async function test_touchpad_pan_is_not_scaled() {
  if (
    !SpecialPowers.isHeadless &&
    !["linux", "win"].includes(AppConstants.platform)
  ) {
    ok(
      true,
      "Native touchpad pans can only be synthesized on Linux, on Windows and in headless mode."
    );
    return;
  }
  await checkWheelScrollingIsNotScaled(panWithTouchpad);
});

add_task(async function test_pixel_wheel_is_not_scaled() {
  await checkWheelScrollingIsNotScaled(scrollWithPixelWheel);
});

// APZ doesn't nest fixed-position scrollers in the root scroller of the page,
// so transforms of the page can apply to them in addition to the scale. The
// page must not be able to keep APZ from compensating for the scale with them,
// for example by rotating a scroller slightly, or make APZ compensate for its
// own scale.
add_task(async function test_transformed_fixed_scroller_is_not_scaled() {
  for (let transform of ["rotate(0.01deg)", "scale(2)"]) {
    info(`Scroll a fixed-position scroller with transform: ${transform}`);
    await checkWheelScrollingIsNotScaled(scrollWithPixelWheel, transform);
  }
});

// Moving the pointer by one device pixel moves it by less than one pixel in
// the magnified content, so some moves don't change its position there. Such
// moves never happen without the magnification, so they must not reach the
// page.
add_task(async function test_no_pointer_moves_by_zero_pixels() {
  let originalWidth = window.outerWidth;
  let originalHeight = window.outerHeight;
  let tab = await openMagnifiedTab();
  let browser = tab.linkedBrowser;

  await SpecialPowers.spawn(browser, [], () => {
    let root = content.document.documentElement;
    root.dataset.moves = 0;
    root.dataset.zeroMoves = 0;
    let lastPosition = null;
    content.addEventListener("pointermove", event => {
      for (let move of event.getCoalescedEvents()) {
        let position = `${move.clientX},${move.clientY}`;
        root.dataset.moves = Number(root.dataset.moves) + 1;
        if (position == lastPosition) {
          root.dataset.zeroMoves = Number(root.dataset.zeroMoves) + 1;
        }
        lastPosition = position;
      }
    });
  });

  // Move by one device pixel at a time, as a slow pointer does. These events
  // are sent from the parent process, like the events of a pointer, so this
  // works on every platform, unlike native mouse events, which Wayland can't
  // synthesize.
  const STEPS = 100;
  let rect = browser.getBoundingClientRect();
  let x = rect.left + rect.width / 2;
  let y = rect.top + rect.height / 2;
  for (let i = 0; i <= STEPS; i++) {
    EventUtils.synthesizeMouseAtPoint(
      x + i / window.devicePixelRatio,
      y,
      { type: "mousemove" },
      window
    );
    // Give each move a frame, so that nothing coalesces them.
    await new Promise(resolve => requestAnimationFrame(resolve));
  }

  let [moves, zeroMoves] = await waitForStableValues(
    () =>
      SpecialPowers.spawn(browser, [], () => {
        let root = content.document.documentElement;
        return [Number(root.dataset.moves), Number(root.dataset.zeroMoves)];
      }),
    "Wait for the pointer moves to arrive."
  );
  Assert.greater(moves, STEPS / 2, "The page received pointer moves.");
  is(zeroMoves, 0, "The page received no pointer moves by zero pixels.");

  BrowserTestUtils.removeTab(tab);
  await resizeWindow(window, originalWidth, originalHeight);
});

// Autoscrolls aBrowser with the pointer aDistance pixels of the page below the
// anchor, and returns the speed of the scrolling in pixels per millisecond.
async function measureAutoscrollSpeed(aBrowser, aDistance) {
  await waitForChromePaint();
  let { viewId, presShellId } = await SpecialPowers.spawn(
    aBrowser,
    [],
    async () => {
      content.document.body.style.height = "100000px";
      content.scrollTo(0, 0);
      // Wait for a paint, so that APZ knows that the page can scroll.
      await new Promise(resolve =>
        content.requestAnimationFrame(() =>
          content.requestAnimationFrame(resolve)
        )
      );
      let utils = SpecialPowers.getDOMWindowUtils(content);
      return {
        viewId: utils.getViewId(content.document.documentElement),
        presShellId: utils.getPresShellId(),
      };
    }
  );
  let { x, y } = getBrowserCenterOnScreen(aBrowser);
  let movePointer = aY =>
    EventUtils.promiseNativeMouseEvent({
      type: "mousemove",
      target: aBrowser,
      screenX: x,
      screenY: aY,
      scale: "inScreenPixels",
    });
  await movePointer(y);
  ok(
    aBrowser.browsingContext.startApzAutoscroll(x, y, viewId, presShellId),
    "APZ autoscrolls the page."
  );
  let scale = aBrowser.getBoundingClientRect().width / aBrowser.clientWidth;
  await movePointer(y + Math.round(aDistance * scale));

  let sample = aFrames =>
    SpecialPowers.spawn(aBrowser, [aFrames], async aCount => {
      for (let i = 0; i < aCount; i++) {
        await new Promise(resolve => content.requestAnimationFrame(resolve));
      }
      return [content.performance.now(), content.scrollY];
    });
  await TestUtils.waitForCondition(
    async () => (await sample(1))[1] > 0,
    "The page starts autoscrolling."
  );
  let [startTime, startY] = await sample(1);
  let [endTime, endY] = await sample(120);
  aBrowser.browsingContext.stopApzAutoscroll(viewId, presShellId);
  return (endY - startY) / (endTime - startTime);
}

// The page sees how far the pointer is from the anchor of autoscrolling, and
// the speed of autoscrolling grows with that distance, so the speed must depend
// on the distance in the page's own pixels. Otherwise the page could compute
// the scale from the speed.
add_task(async function test_autoscroll_is_not_scaled() {
  if (!canSynthesizeNativeMouseMoves()) {
    ok(true, "Native mouse moves can't be synthesized on Wayland.");
    return;
  }
  let { scaled, unscaled } = await measureWithAndWithoutScale(tab =>
    measureAutoscrollSpeed(tab.linkedBrowser, 80)
  );

  Assert.greater(unscaled, 0, "The page autoscrolls.");
  // Without compensating for the scale, the page would scroll more than 15%
  // faster, since openMagnifiedTab() makes the scale larger than 1.1.
  Assert.lessOrEqual(
    Math.abs(scaled / unscaled - 1),
    0.08,
    `The page autoscrolls at the same speed with and without the scale (${scaled} vs ${unscaled} pixels per millisecond).`
  );
});

// Starts autoscrolling in aBrowser, moves the pointer away from the anchor by
// the snap distance of autoscrolling and by one device pixel more, and returns
// for both whether a click would now end autoscrolling.
async function measureAutoscrollSnap(aBrowser) {
  let scale = aBrowser.getBoundingClientRect().width / aBrowser.clientWidth;
  let { x, y } = getBrowserCenterOnScreen(aBrowser);
  let snap = Math.floor(
    aBrowser._AUTOSCROLL_SNAP * scale * window.devicePixelRatio
  );
  let isAutoscroller = event => event.originalTarget.id == "autoscroller";
  let results = [];
  for (let distance of [snap, snap + 1]) {
    let shown = BrowserTestUtils.waitForEvent(
      window,
      "popupshown",
      { capture: true },
      isAutoscroller
    );
    aBrowser.startScroll({
      scrolldir: "NSEW",
      screenXDevPx: x,
      screenYDevPx: y,
      scrollId: null,
      presShellId: null,
      browsingContext: aBrowser.browsingContext,
    });
    await shown;
    // The browser listens for mouse moves first, so it has seen this one when
    // the listener of the test runs.
    let moved = new Promise(resolve => {
      let listener = event => {
        if (
          Math.abs(event.screenY - (y + distance) / window.devicePixelRatio) < 1
        ) {
          window.removeEventListener("mousemove", listener, true);
          resolve();
        }
      };
      window.addEventListener("mousemove", listener, true);
    });
    await EventUtils.promiseNativeMouseEvent({
      type: "mousemove",
      target: aBrowser,
      screenX: x,
      screenY: y + distance,
      scale: "inScreenPixels",
    });
    await moved;
    results.push(!aBrowser._ignoreMouseEvents);
    let hidden = BrowserTestUtils.waitForEvent(
      window,
      "popuphidden",
      { capture: true },
      isAutoscroller
    );
    aBrowser.cancelScroll();
    await hidden;
  }
  return results;
}

// A click ends autoscrolling once the pointer is far enough from the anchor,
// and the page sees that distance in its own pixels, so it must be measured in
// those too. Otherwise the page could compute the scale from the distance at
// which a click ends autoscrolling.
add_task(async function test_autoscroll_snap_is_not_scaled() {
  if (!canSynthesizeNativeMouseMoves()) {
    ok(true, "Native mouse moves can't be synthesized on Wayland.");
    return;
  }
  await SpecialPowers.pushPrefEnv({ set: [["general.autoScroll", true]] });
  let { scaled, unscaled } = await measureWithAndWithoutScale(tab =>
    measureAutoscrollSnap(tab.linkedBrowser)
  );

  // Without compensating for the scale, the snap distance of the page would be
  // more than 11 pixels of the screen, which ends autoscrolling, since
  // openMagnifiedTab() makes the scale larger than 1.1.
  Assert.deepEqual(
    unscaled,
    [false, true],
    "A click ends autoscrolling beyond the snap distance without the scale."
  );
  Assert.deepEqual(
    scaled,
    unscaled,
    "A click ends autoscrolling at the same distance in the pixels of the page with the scale."
  );
  await SpecialPowers.popPrefEnv();
});

// Other scales of the browser, such as the zoom of responsive design mode, are
// not the magnification of letterboxing, so APZ must not compensate for them
// when letterboxing is disabled.
add_task(async function test_other_scales_are_not_compensated() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["privacy.resistFingerprinting.letterboxing", false],
      // Only measure the scrolling caused by the input itself.
      ["general.smoothScroll", false],
      ["apz.gtk.kinetic_scroll.enabled", false],
    ],
  });
  let tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, DEFAULT_URL);
  let browser = tab.linkedBrowser;
  browser.style.transform = "scale(2)";
  let { reported, scrolled } = await measureWheelScrolling(
    browser,
    scrollWithPixelWheel
  );

  Assert.greaterOrEqual(
    Math.abs(reported),
    100,
    "The page received pixel deltas."
  );
  // APZ scrolls by the deltas divided by the scale, as it always has.
  let ratio = Math.abs(scrolled) / Math.abs(reported);
  Assert.lessOrEqual(
    Math.abs(ratio - 0.5),
    0.1,
    `The page scrolls by half of the deltas that it receives (${scrolled} vs ${reported}).`
  );

  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});
