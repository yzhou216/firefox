/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "APZCBasicTester.h"
#include "APZCTreeManagerTester.h"
#include "APZTestCommon.h"
#include "InputUtils.h"

// Letterboxing can magnify the content of a browser, which is the presentation
// scale of its APZCs (see AsyncPanZoomController::GetPresentationScale()). APZ
// must behave as if the content were not magnified, or web content could
// measure the magnification from how input scrolls it, and with it the real
// size of the window. These tests set the presentation scale directly, since
// APZCTreeManager::UpdatePresentationScales() only has to find it.
class APZCPresentationScaleTester : public APZCBasicTester {
 public:
  explicit APZCPresentationScaleTester(
      AsyncPanZoomController::GestureBehavior aGestureBehavior =
          AsyncPanZoomController::DEFAULT_GESTURES)
      : APZCBasicTester(aGestureBehavior) {}

 protected:
  static constexpr float kScale = 2.0f;
  static constexpr int kDpi = 100;

  void SetUp() override {
    APZCBasicTester::SetUp();
    tm->SetDPI(kDpi);
  }

  float ScrollOffsetY() const {
    return apzc->GetFrameMetrics().GetVisualScrollOffset().y;
  }

  // Puts the page back at the top and removes all state of the last input.
  void Reset(float aPresentationScale) {
    apzc->CancelAnimation();
    apzc->SetFrameMetrics(TestFrameMetrics());
    apzc->SetPresentationScale(aPresentationScale);
  }

  // Returns how far input scrolled the page, in CSS pixels, with the given
  // presentation scale.
  template <typename Input>
  float ScrollBy(float aPresentationScale, Input aInput) {
    Reset(aPresentationScale);
    aInput();
    return ScrollOffsetY();
  }
};

// Pinches are only detected from touch input by the gesture detector.
class APZCPresentationScaleGestureDetectorTester
    : public APZCPresentationScaleTester {
 public:
  APZCPresentationScaleGestureDetectorTester()
      : APZCPresentationScaleTester(
            AsyncPanZoomController::USE_GESTURE_DETECTOR) {}
};

TEST_F(APZCPresentationScaleTester, DpiIsMultiplied) {
  EXPECT_FLOAT_EQ(kDpi, apzc->GetDPI());
  apzc->SetPresentationScale(kScale);
  EXPECT_FLOAT_EQ(kDpi * kScale, apzc->GetDPI());
}

// A pixel wheel delta is in the pixels of the screen, which the magnification
// turns into fewer pixels of the page, while web content receives the delta
// without it. The page must scroll by the delta that web content receives.
TEST_F(APZCPresentationScaleTester, PixelWheelDeltaIsMultiplied) {
  auto wheel = [&] {
    Wheel(apzc, ScreenIntPoint(50, 50), ScreenPoint(0, 10), mcc->Time());
  };
  const float unscaled = ScrollBy(1.0f, wheel);
  ASSERT_GT(unscaled, 0.0f);
  EXPECT_FLOAT_EQ(kScale * unscaled, ScrollBy(kScale, wheel));
}

// A line is a distance in the page, so a wheel that scrolls by lines scrolls by
// the same distance, whatever the magnification is.
TEST_F(APZCPresentationScaleTester, LineWheelDeltaIsNotMultiplied) {
  apzc->GetScrollMetadata().SetLineScrollAmount(LayoutDeviceIntSize(20, 20));
  auto wheel = [&] {
    ScrollWheelInput input(mcc->Time(), 0, ScrollWheelInput::SCROLLMODE_INSTANT,
                           ScrollWheelInput::SCROLLDELTA_LINE,
                           ScreenIntPoint(50, 50), 0, 1, false,
                           WheelDeltaAdjustmentStrategy::eNone);
    apzc->ReceiveInputEvent(input);
  };
  const float unscaled = ScrollBy(1.0f, wheel);
  ASSERT_GT(unscaled, 0.0f);
  EXPECT_FLOAT_EQ(unscaled, ScrollBy(kScale, wheel));
}

TEST_F(APZCPresentationScaleTester, PanGestureDisplacementIsMultiplied) {
  auto pan = [&] {
    PanGesture(PanGestureInput::PANGESTURE_START, apzc, ScreenIntPoint(50, 80),
               ScreenPoint(0, 2), mcc->Time());
    mcc->AdvanceByMillis(5);
    PanGesture(PanGestureInput::PANGESTURE_PAN, apzc, ScreenIntPoint(50, 80),
               ScreenPoint(0, 10), mcc->Time());
    const float offset = ScrollOffsetY();
    PanGesture(PanGestureInput::PANGESTURE_END, apzc, ScreenIntPoint(50, 80),
               ScreenPoint(0, 0), mcc->Time());
    return offset;
  };
  Reset(1.0f);
  const float unscaled = pan();
  ASSERT_GT(unscaled, 0.0f);
  Reset(kScale);
  EXPECT_FLOAT_EQ(kScale * unscaled, pan());
}

// The content follows the finger, so touch input scrolls by the distance that
// the finger moved, whatever the magnification is.
TEST_F(APZCPresentationScaleTester, TouchPanDistanceIsNotMultiplied) {
  auto pan = [&] { Pan(apzc, 80, 20, PanOptions::NoFling); };
  const float unscaled = ScrollBy(1.0f, pan);
  ASSERT_GT(unscaled, 0.0f);
  EXPECT_FLOAT_EQ(unscaled, ScrollBy(kScale, pan));
}

// The distance that a finger has to move before the page scrolls is measured in
// the pixels of the screen, so it must grow with the magnification, to stay the
// same in the pixels of the page, which web content sees the finger move in.
TEST_F(APZCPresentationScaleTester, TouchStartToleranceIsMultiplied) {
  // This is 10 pixels at the DPI of the test, and 20 with the scale.
  SCOPED_GFX_PREF_FLOAT("apz.touch_start_tolerance", 0.1f);
  // The finger moves 15 pixels, which pans without the scale and not with it,
  // and then 18, which does not pan with it either.
  auto drag = [&] {
    APZEventResult result =
        TouchDown(apzc, ScreenIntPoint(10, 80), mcc->Time());
    SetDefaultAllowedTouchBehavior(apzc, result.mInputBlockId);
    mcc->AdvanceByMillis(20);
    TouchMove(apzc, ScreenIntPoint(10, 65), mcc->Time());
    mcc->AdvanceByMillis(20);
    TouchMove(apzc, ScreenIntPoint(10, 62), mcc->Time());
    const float offset = ScrollOffsetY();
    TouchUp(apzc, ScreenIntPoint(10, 62), mcc->Time());
    mcc->AdvanceByMillis(20);
    return offset;
  };
  Reset(1.0f);
  EXPECT_GT(drag(), 0.0f);
  Reset(kScale);
  EXPECT_FLOAT_EQ(0.0f, drag());
}

// Likewise for the distance that two fingers have to move apart before they
// pinch.
TEST_F(APZCPresentationScaleGestureDetectorTester,
       PinchStartThresholdIsMultiplied) {
  FrameMetrics fm;
  fm.SetCompositionBounds(ParentLayerRect(0, 0, 200, 200));
  fm.SetScrollableRect(CSSRect(0, 0, 980, 1000));
  fm.SetZoom(CSSToParentLayerScale(1.0));
  fm.SetIsRootContent(true);
  apzc->SetFrameMetrics(fm);
  MakeApzcZoomable();

  // The fingers go from a span of 0 to one of 40 pixels, which is more than the
  // threshold of 35 pixels but less than that with the scale, and then to 100.
  // A pinch that starts at the first span zooms by the second.
  auto pinch = [&] {
    int inputId = 0;
    MultiTouchInput start(MultiTouchInput::MULTITOUCH_START, 0, mcc->Time(), 0);
    start.mTouches.AppendElement(
        CreateSingleTouchData(inputId, ScreenIntPoint(100, 100)));
    start.mTouches.AppendElement(
        CreateSingleTouchData(inputId + 1, ScreenIntPoint(100, 100)));
    APZEventResult result = apzc->ReceiveInputEvent(start);
    SetDefaultAllowedTouchBehavior(apzc, result.mInputBlockId, 2);
    for (int halfSpan : {20, 50}) {
      mcc->AdvanceByMillis(20);
      MultiTouchInput move(MultiTouchInput::MULTITOUCH_MOVE, 0, mcc->Time(), 0);
      move.mTouches.AppendElement(
          CreateSingleTouchData(inputId, ScreenIntPoint(100 - halfSpan, 100)));
      move.mTouches.AppendElement(CreateSingleTouchData(
          inputId + 1, ScreenIntPoint(100 + halfSpan, 100)));
      apzc->ReceiveInputEvent(move);
    }
    mcc->AdvanceByMillis(20);
    MultiTouchInput end(MultiTouchInput::MULTITOUCH_END, 0, mcc->Time(), 0);
    end.mTouches.AppendElement(
        CreateSingleTouchData(inputId, ScreenIntPoint(50, 100)));
    end.mTouches.AppendElement(
        CreateSingleTouchData(inputId + 1, ScreenIntPoint(150, 100)));
    apzc->ReceiveInputEvent(end);
    apzc->CancelAnimation();
    return apzc->GetFrameMetrics().GetZoom().scale;
  };

  EXPECT_CALL(*mcc, RequestContentRepaint(_)).Times(testing::AnyNumber());
  const float unscaled = pinch();
  EXPECT_GT(unscaled, 1.0f);

  apzc->SetFrameMetrics(fm);
  apzc->SetPresentationScale(kScale);
  EXPECT_FLOAT_EQ(1.0f, pinch());
}

// APZCTreeManager::UpdatePresentationScales() has to find the scale that the
// chrome document applies to a browser, from the transform of the <browser>
// element, and has to apply it to everything in the browser.
class APZCPresentationScaleTreeTester : public APZCTreeManagerTester {
 protected:
  static constexpr const char* kLetterboxing =
      "privacy.resistFingerprinting.letterboxing";

  // The root layer is the <browser> element of the chrome document, which has
  // layers id 0 and a scroller. Its descendants belong to the content of the
  // browser, which has layers id 1: first its root scroller, and then an
  // out-of-process iframe, which has layers id 2 and a scroller as well.
  void CreateBrowserTree() {
    CreateScrollData("x(x(x(x)))");
    SetScrollableFrameMetrics(layers[0], START_SCROLL_ID);
    SetScrollableFrameMetrics(layers[1], START_SCROLL_ID);
    ModifyFrameMetrics(layers[1], [](ScrollMetadata&, FrameMetrics& aMetrics) {
      aMetrics.SetIsRootContent(true);
    });
    SetScrollableFrameMetrics(layers[3], START_SCROLL_ID);
    root->SetReferentId(LayersId{1});
    layers[2]->SetReferentId(LayersId{2});
  }

  static gfx::Matrix4x4 Rotation(double aAngle) {
    gfx::Matrix4x4 rotation;
    rotation.RotateZ(aAngle);
    return rotation;
  }

  float PresentationScaleIn(uint64_t aLayersId) {
    RefPtr<AsyncPanZoomController> apzc =
        manager->GetTargetAPZC(LayersId{aLayersId}, START_SCROLL_ID);
    return apzc ? apzc->GetPresentationScale() : -1.0f;
  }

  // Transforms the <browser> element and checks the presentation scales of the
  // scrollers of the chrome document, the content and the iframe.
  void ExpectScales(float aChrome, float aContent, float aIframe,
                    const gfx::Matrix4x4& aBrowserTransform) {
    root->SetTransform(aBrowserTransform);
    UpdateHitTestingTree();
    EXPECT_FLOAT_EQ(aChrome, PresentationScaleIn(0));
    EXPECT_FLOAT_EQ(aContent, PresentationScaleIn(1));
    EXPECT_FLOAT_EQ(aIframe, PresentationScaleIn(2));
  }
};

TEST_F(APZCPresentationScaleTreeTester, LetterboxingMagnifiesTheBrowser) {
  ScopedLayerTreeRegistration registration0(LayersId{0}, mcc);
  ScopedLayerTreeRegistration registration1(LayersId{1}, mcc);
  ScopedLayerTreeRegistration registration2(LayersId{2}, mcc);
  SCOPED_GFX_PREF_BOOL(kLetterboxing, true);
  CreateBrowserTree();

  ExpectScales(1.0f, 1.0f, 1.0f, gfx::Matrix4x4());
  // The scale reaches every scroller of the browser, but not the chrome.
  ExpectScales(1.0f, 1.5f, 1.5f, gfx::Matrix4x4::Scaling(1.5f, 1.5f, 1.0f));
  // Letterboxing also centers the browser.
  ExpectScales(1.0f, 1.25f, 1.25f,
               gfx::Matrix4x4::Scaling(1.25f, 1.25f, 1.0f) *
                   gfx::Matrix4x4::Translation(30.0f, 0.0f, 0.0f));
}

// Letterboxing only magnifies uniformly. Anything else that transforms the
// browser is not the scale that is hidden from web content.
TEST_F(APZCPresentationScaleTreeTester, OtherTransformsAreNotTheScale) {
  ScopedLayerTreeRegistration registration0(LayersId{0}, mcc);
  ScopedLayerTreeRegistration registration1(LayersId{1}, mcc);
  ScopedLayerTreeRegistration registration2(LayersId{2}, mcc);
  SCOPED_GFX_PREF_BOOL(kLetterboxing, true);
  CreateBrowserTree();

  ExpectScales(1.0f, 1.0f, 1.0f,
               gfx::Matrix4x4::Translation(30.0f, 5.0f, 0.0f));
  ExpectScales(1.0f, 1.0f, 1.0f, gfx::Matrix4x4::Scaling(0.8f, 0.8f, 1.0f));
  ExpectScales(1.0f, 1.0f, 1.0f, gfx::Matrix4x4::Scaling(1.5f, 1.2f, 1.0f));
  ExpectScales(1.0f, 1.0f, 1.0f, Rotation(0.1));
  ExpectScales(1.0f, 1.0f, 1.0f,
               Rotation(0.1) * gfx::Matrix4x4::Scaling(1.5f, 1.5f, 1.0f));
}

// Other scales of a browser, such as the zoom of responsive design mode, must
// not be compensated for while letterboxing is disabled, and the scale of
// letterboxing must not stay when it gets disabled.
TEST_F(APZCPresentationScaleTreeTester, OnlyLetterboxingIsCompensatedFor) {
  ScopedLayerTreeRegistration registration0(LayersId{0}, mcc);
  ScopedLayerTreeRegistration registration1(LayersId{1}, mcc);
  ScopedLayerTreeRegistration registration2(LayersId{2}, mcc);
  SCOPED_GFX_PREF_BOOL(kLetterboxing, false);
  CreateBrowserTree();

  const gfx::Matrix4x4 scale = gfx::Matrix4x4::Scaling(1.5f, 1.5f, 1.0f);
  ExpectScales(1.0f, 1.0f, 1.0f, scale);
  Preferences::SetBool(kLetterboxing, true);
  ExpectScales(1.0f, 1.5f, 1.5f, scale);
  Preferences::SetBool(kLetterboxing, false);
  ExpectScales(1.0f, 1.0f, 1.0f, scale);
}
