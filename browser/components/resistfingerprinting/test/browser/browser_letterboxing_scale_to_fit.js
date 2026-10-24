/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Tests that letterboxing magnifies the rounded browser until it reaches the
 * edge of the available space along one axis. The viewport size reported to
 * the page must stay rounded, and tabs which are exempt from letterboxing or
 * in DOM fullscreen must not be scaled.
 */

const { RFPHelper } = ChromeUtils.importESModule(
  "resource://gre/modules/RFPHelper.sys.mjs"
);

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
  return aState.scale != "none" && (fillsWidth || fillsHeight);
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
