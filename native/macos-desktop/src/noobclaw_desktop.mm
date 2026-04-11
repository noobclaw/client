// NoobClaw macOS native desktop automation addon.
//
// Replaces the osascript / screencapture / Python fallbacks in
// src/main/libs/desktopControlMcp.ts with direct CGEvent + NSPasteboard +
// CGDisplayCreateImage calls. Loaded by the pkg-bundled sidecar via the
// loader in src/main/libs/nativeDesktopMac.ts.
//
// Exports (all sync):
//
//   screenshot({quality?, format?}) -> { data: Buffer, width, height, format }
//   mouseMove(x, y, {durationMs?, easing?})
//   mouseClick(x, y, button?, clickCount?)
//   mouseDrag(x1, y1, x2, y2, durationMs?)
//   keyType(text)
//   keyPress(keyName, modifiers?[])
//   clipboardGet() -> string
//   clipboardSet(text)
//   clipboardVerify(expected) -> boolean
//   getActiveWindow() -> { title, bundleId, pid } | null
//   listWindows() -> [{ title, bundleId, pid }]
//   isAccessibilityTrusted({prompt?}) -> boolean
//
// Threading: all calls run synchronously on the calling JS thread. CGEvent
// posting from a background thread is OK on macOS. NSPasteboard is thread
// safe for reading/writing strings.
//
// Permissions: the OS will auto-prompt the user the first time a
// screen-recording API (screenshot) or accessibility-requiring API
// (mouseMove / mouseClick / keyPress against other apps) is invoked. The
// app binary embedding this addon must ship with matching entitlements
// (see src-tauri/entitlements.plist: cs.allow-jit,
// cs.allow-unsigned-executable-memory, cs.disable-library-validation).

#import <napi.h>
#import <AppKit/AppKit.h>
#import <Cocoa/Cocoa.h>
#import <CoreGraphics/CoreGraphics.h>
#import <ApplicationServices/ApplicationServices.h>
#import <ImageIO/ImageIO.h>
#import <CoreServices/CoreServices.h>
#import <Carbon/Carbon.h>   // virtual key codes (kVK_*)

#include <algorithm>
#include <string>
#include <unistd.h>          // usleep
#include <cctype>

// ─── Small helpers ────────────────────────────────────────────────────

static std::string StdFromNS(NSString *s) {
  if (!s) return std::string();
  return std::string([s UTF8String] ?: "");
}

static NSString *NSFromStd(const std::string &s) {
  return [NSString stringWithUTF8String:s.c_str()] ?: @"";
}

static double easeOutCubic(double t) {
  double u = 1.0 - t;
  return 1.0 - u * u * u;
}

// ─── Accessibility permission helper ──────────────────────────────────

static Napi::Value IsAccessibilityTrusted(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  bool prompt = false;
  if (info.Length() > 0 && info[0].IsObject()) {
    Napi::Object opts = info[0].As<Napi::Object>();
    if (opts.Has("prompt")) prompt = opts.Get("prompt").ToBoolean().Value();
  }
  NSDictionary *options = @{
    (__bridge NSString *)kAXTrustedCheckOptionPrompt : @(prompt)
  };
  Boolean trusted = AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options);
  return Napi::Boolean::New(env, trusted ? true : false);
}

// ─── Screenshot ────────────────────────────────────────────────────────

static Napi::Value Screenshot(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();

  double quality = 0.75;
  std::string format = "jpeg";

  if (info.Length() > 0 && info[0].IsObject()) {
    Napi::Object opts = info[0].As<Napi::Object>();
    if (opts.Has("quality")) {
      quality = opts.Get("quality").As<Napi::Number>().DoubleValue();
    }
    if (opts.Has("format")) {
      format = opts.Get("format").As<Napi::String>().Utf8Value();
    }
  }
  if (quality < 0.0) quality = 0.0;
  if (quality > 1.0) quality = 1.0;

  CGDirectDisplayID displayID = CGMainDisplayID();

  // CGDisplayCreateImage is deprecated in macOS 15 but still works; the
  // modern replacement (SCScreenshotManager / SCStream) is async and
  // requires macOS 14+, which would raise our minimum OS. Keep the sync
  // path until we bump minimumSystemVersion. The -Wdeprecated-
  // declarations warning is silenced in binding.gyp.
  CGImageRef cgImage = CGDisplayCreateImage(displayID);
  if (!cgImage) {
    Napi::Error::New(env, "CGDisplayCreateImage returned NULL (screen recording permission not granted?)")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  size_t width = CGImageGetWidth(cgImage);
  size_t height = CGImageGetHeight(cgImage);

  NSMutableData *data = [NSMutableData data];
  CFStringRef type = kUTTypeJPEG;
  if (format == "png") type = kUTTypePNG;

  CGImageDestinationRef dest = CGImageDestinationCreateWithData(
      (__bridge CFMutableDataRef)data, type, 1, NULL);
  if (!dest) {
    CGImageRelease(cgImage);
    Napi::Error::New(env, "CGImageDestinationCreateWithData failed")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  if (format == "jpeg") {
    NSDictionary *props = @{
      (__bridge NSString *)kCGImageDestinationLossyCompressionQuality : @(quality)
    };
    CGImageDestinationAddImage(dest, cgImage, (__bridge CFDictionaryRef)props);
  } else {
    CGImageDestinationAddImage(dest, cgImage, NULL);
  }

  bool ok = CGImageDestinationFinalize(dest);
  CFRelease(dest);
  CGImageRelease(cgImage);

  if (!ok) {
    Napi::Error::New(env, "CGImageDestinationFinalize failed")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::Buffer<uint8_t> buffer = Napi::Buffer<uint8_t>::Copy(
      env, (const uint8_t *)data.bytes, data.length);

  Napi::Object result = Napi::Object::New(env);
  result.Set("data", buffer);
  result.Set("width", Napi::Number::New(env, (double)width));
  result.Set("height", Napi::Number::New(env, (double)height));
  result.Set("format", Napi::String::New(env, format));
  return result;
}

// ─── Mouse ────────────────────────────────────────────────────────────

static CGPoint currentMousePosition() {
  CGEventRef e = CGEventCreate(NULL);
  CGPoint p = CGEventGetLocation(e);
  CFRelease(e);
  return p;
}

static void postMouseMove(CGPoint p) {
  CGEventRef move =
      CGEventCreateMouseEvent(NULL, kCGEventMouseMoved, p, kCGMouseButtonLeft);
  CGEventPost(kCGHIDEventTap, move);
  CFRelease(move);
}

static Napi::Value MouseMove(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
    Napi::TypeError::New(env, "mouseMove(x, y, opts?): x, y required")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  double x = info[0].As<Napi::Number>().DoubleValue();
  double y = info[1].As<Napi::Number>().DoubleValue();

  int durationMs = 0;
  std::string easing = "linear";
  if (info.Length() > 2 && info[2].IsObject()) {
    Napi::Object opts = info[2].As<Napi::Object>();
    if (opts.Has("durationMs")) {
      durationMs = opts.Get("durationMs").As<Napi::Number>().Int32Value();
    }
    if (opts.Has("easing")) {
      easing = opts.Get("easing").As<Napi::String>().Utf8Value();
    }
  }

  if (durationMs <= 0) {
    postMouseMove(CGPointMake(x, y));
    return env.Undefined();
  }

  // 60fps animation. Each frame ≈ 16ms. At least 2 frames even for short
  // durations so the cursor moves at all.
  CGPoint start = currentMousePosition();
  int steps = std::max(2, durationMs / 16);
  for (int i = 1; i <= steps; i++) {
    double t = (double)i / (double)steps;
    double eased = (easing == "ease-out-cubic") ? easeOutCubic(t) : t;
    double px = start.x + (x - start.x) * eased;
    double py = start.y + (y - start.y) * eased;
    postMouseMove(CGPointMake(px, py));
    usleep(16000);
  }
  return env.Undefined();
}

static Napi::Value MouseClick(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
    Napi::TypeError::New(env, "mouseClick(x, y, button?, clicks?): x, y required")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  double x = info[0].As<Napi::Number>().DoubleValue();
  double y = info[1].As<Napi::Number>().DoubleValue();

  std::string button = "left";
  int clicks = 1;
  if (info.Length() > 2 && info[2].IsString()) {
    button = info[2].As<Napi::String>().Utf8Value();
  }
  if (info.Length() > 3 && info[3].IsNumber()) {
    clicks = info[3].As<Napi::Number>().Int32Value();
  }
  if (clicks < 1) clicks = 1;
  if (clicks > 5) clicks = 5; // sanity cap

  CGMouseButton btn = kCGMouseButtonLeft;
  CGEventType downType = kCGEventLeftMouseDown;
  CGEventType upType = kCGEventLeftMouseUp;
  if (button == "right") {
    btn = kCGMouseButtonRight;
    downType = kCGEventRightMouseDown;
    upType = kCGEventRightMouseUp;
  } else if (button == "middle") {
    btn = kCGMouseButtonCenter;
    downType = kCGEventOtherMouseDown;
    upType = kCGEventOtherMouseUp;
  }

  // Move to target first (instant, not animated — the caller can animate
  // before clicking if they want motion).
  postMouseMove(CGPointMake(x, y));

  for (int i = 0; i < clicks; i++) {
    CGEventRef down =
        CGEventCreateMouseEvent(NULL, downType, CGPointMake(x, y), btn);
    // clickState lets the OS recognize double-clicks etc. as a single
    // sequence rather than N independent clicks.
    CGEventSetIntegerValueField(down, kCGMouseEventClickState, i + 1);
    CGEventPost(kCGHIDEventTap, down);
    CFRelease(down);

    usleep(20 * 1000);

    CGEventRef up =
        CGEventCreateMouseEvent(NULL, upType, CGPointMake(x, y), btn);
    CGEventSetIntegerValueField(up, kCGMouseEventClickState, i + 1);
    CGEventPost(kCGHIDEventTap, up);
    CFRelease(up);

    if (i < clicks - 1) usleep(50 * 1000);
  }

  return env.Undefined();
}

static Napi::Value MouseDrag(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 4) {
    Napi::TypeError::New(env, "mouseDrag(x1, y1, x2, y2, durationMs?) requires 4 numbers")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  double x1 = info[0].As<Napi::Number>().DoubleValue();
  double y1 = info[1].As<Napi::Number>().DoubleValue();
  double x2 = info[2].As<Napi::Number>().DoubleValue();
  double y2 = info[3].As<Napi::Number>().DoubleValue();
  int durationMs = 400;
  if (info.Length() > 4 && info[4].IsNumber()) {
    durationMs = info[4].As<Napi::Number>().Int32Value();
  }

  // Move to start
  postMouseMove(CGPointMake(x1, y1));
  usleep(30 * 1000);

  // Press
  CGEventRef down = CGEventCreateMouseEvent(
      NULL, kCGEventLeftMouseDown, CGPointMake(x1, y1), kCGMouseButtonLeft);
  CGEventPost(kCGHIDEventTap, down);
  CFRelease(down);

  // Drag via kCGEventLeftMouseDragged events, animated
  int steps = std::max(2, durationMs / 16);
  for (int i = 1; i <= steps; i++) {
    double t = (double)i / (double)steps;
    double eased = easeOutCubic(t);
    double px = x1 + (x2 - x1) * eased;
    double py = y1 + (y2 - y1) * eased;
    CGEventRef drag = CGEventCreateMouseEvent(
        NULL, kCGEventLeftMouseDragged, CGPointMake(px, py), kCGMouseButtonLeft);
    CGEventPost(kCGHIDEventTap, drag);
    CFRelease(drag);
    usleep(16 * 1000);
  }

  // Release
  CGEventRef up = CGEventCreateMouseEvent(
      NULL, kCGEventLeftMouseUp, CGPointMake(x2, y2), kCGMouseButtonLeft);
  CGEventPost(kCGHIDEventTap, up);
  CFRelease(up);

  return env.Undefined();
}

// ─── Keyboard ─────────────────────────────────────────────────────────

// Map a human-friendly key name to a macOS virtual key code. Supports
// letters, digits, function keys, arrows, and common named keys. Returns
// 0xFFFF if the key is unknown (caller should fall through to keyType).
static CGKeyCode keyCodeForName(const std::string &nameIn) {
  std::string n;
  n.reserve(nameIn.size());
  for (char c : nameIn) n += (char)tolower((unsigned char)c);

  if (n == "enter" || n == "return") return kVK_Return;
  if (n == "tab") return kVK_Tab;
  if (n == "space" || n == " ") return kVK_Space;
  if (n == "escape" || n == "esc") return kVK_Escape;
  if (n == "backspace" || n == "delete") return kVK_Delete;
  if (n == "forwarddelete" || n == "del") return kVK_ForwardDelete;
  if (n == "up") return kVK_UpArrow;
  if (n == "down") return kVK_DownArrow;
  if (n == "left") return kVK_LeftArrow;
  if (n == "right") return kVK_RightArrow;
  if (n == "home") return kVK_Home;
  if (n == "end") return kVK_End;
  if (n == "pageup") return kVK_PageUp;
  if (n == "pagedown") return kVK_PageDown;
  if (n == "f1") return kVK_F1;
  if (n == "f2") return kVK_F2;
  if (n == "f3") return kVK_F3;
  if (n == "f4") return kVK_F4;
  if (n == "f5") return kVK_F5;
  if (n == "f6") return kVK_F6;
  if (n == "f7") return kVK_F7;
  if (n == "f8") return kVK_F8;
  if (n == "f9") return kVK_F9;
  if (n == "f10") return kVK_F10;
  if (n == "f11") return kVK_F11;
  if (n == "f12") return kVK_F12;

  if (n.size() == 1) {
    char c = n[0];
    if (c >= 'a' && c <= 'z') {
      static const CGKeyCode letters[] = {
          kVK_ANSI_A, kVK_ANSI_B, kVK_ANSI_C, kVK_ANSI_D, kVK_ANSI_E,
          kVK_ANSI_F, kVK_ANSI_G, kVK_ANSI_H, kVK_ANSI_I, kVK_ANSI_J,
          kVK_ANSI_K, kVK_ANSI_L, kVK_ANSI_M, kVK_ANSI_N, kVK_ANSI_O,
          kVK_ANSI_P, kVK_ANSI_Q, kVK_ANSI_R, kVK_ANSI_S, kVK_ANSI_T,
          kVK_ANSI_U, kVK_ANSI_V, kVK_ANSI_W, kVK_ANSI_X, kVK_ANSI_Y,
          kVK_ANSI_Z,
      };
      return letters[c - 'a'];
    }
    if (c >= '0' && c <= '9') {
      static const CGKeyCode digits[] = {
          kVK_ANSI_0, kVK_ANSI_1, kVK_ANSI_2, kVK_ANSI_3, kVK_ANSI_4,
          kVK_ANSI_5, kVK_ANSI_6, kVK_ANSI_7, kVK_ANSI_8, kVK_ANSI_9,
      };
      return digits[c - '0'];
    }
  }
  return 0xFFFF;
}

static CGEventFlags parseModifiers(Napi::Array mods) {
  CGEventFlags flags = 0;
  for (uint32_t i = 0; i < mods.Length(); i++) {
    Napi::Value v = mods.Get(i);
    if (!v.IsString()) continue;
    std::string m = v.As<Napi::String>().Utf8Value();
    for (auto &c : m) c = (char)tolower((unsigned char)c);
    if (m == "cmd" || m == "meta" || m == "command") flags |= kCGEventFlagMaskCommand;
    else if (m == "shift") flags |= kCGEventFlagMaskShift;
    else if (m == "alt" || m == "option") flags |= kCGEventFlagMaskAlternate;
    else if (m == "ctrl" || m == "control") flags |= kCGEventFlagMaskControl;
    else if (m == "fn") flags |= kCGEventFlagMaskSecondaryFn;
  }
  return flags;
}

static Napi::Value KeyType(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "keyType(text) requires a string")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  std::string text = info[0].As<Napi::String>().Utf8Value();
  NSString *nsText = NSFromStd(text);
  NSUInteger len = [nsText length];

  // Type one unicode char at a time via CGEventKeyboardSetUnicodeString.
  // This bypasses the need to map every char to a virtual key code and
  // handles accented/CJK input transparently (the OS routes it through
  // the current input method).
  for (NSUInteger i = 0; i < len; i++) {
    unichar ch = [nsText characterAtIndex:i];

    CGEventRef down = CGEventCreateKeyboardEvent(NULL, 0, true);
    CGEventKeyboardSetUnicodeString(down, 1, &ch);
    CGEventPost(kCGHIDEventTap, down);
    CFRelease(down);

    CGEventRef up = CGEventCreateKeyboardEvent(NULL, 0, false);
    CGEventKeyboardSetUnicodeString(up, 1, &ch);
    CGEventPost(kCGHIDEventTap, up);
    CFRelease(up);

    usleep(5 * 1000);
  }
  return env.Undefined();
}

static Napi::Value KeyPress(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "keyPress(key, modifiers?) requires a key name")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  std::string key = info[0].As<Napi::String>().Utf8Value();

  CGEventFlags flags = 0;
  if (info.Length() > 1 && info[1].IsArray()) {
    flags = parseModifiers(info[1].As<Napi::Array>());
  }

  CGKeyCode code = keyCodeForName(key);
  if (code == 0xFFFF) {
    std::string msg = "Unknown key: " + key;
    Napi::Error::New(env, msg.c_str()).ThrowAsJavaScriptException();
    return env.Null();
  }

  CGEventRef down = CGEventCreateKeyboardEvent(NULL, code, true);
  CGEventSetFlags(down, flags);
  CGEventPost(kCGHIDEventTap, down);
  CFRelease(down);

  usleep(10 * 1000);

  CGEventRef up = CGEventCreateKeyboardEvent(NULL, code, false);
  CGEventSetFlags(up, flags);
  CGEventPost(kCGHIDEventTap, up);
  CFRelease(up);

  return env.Undefined();
}

// ─── Clipboard ────────────────────────────────────────────────────────

static Napi::Value ClipboardGet(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  @autoreleasepool {
    NSPasteboard *pb = [NSPasteboard generalPasteboard];
    NSString *s = [pb stringForType:NSPasteboardTypeString];
    if (!s) return Napi::String::New(env, "");
    return Napi::String::New(env, [s UTF8String] ?: "");
  }
}

static Napi::Value ClipboardSet(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "clipboardSet(text) requires a string")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  std::string text = info[0].As<Napi::String>().Utf8Value();
  @autoreleasepool {
    NSString *ns = NSFromStd(text);
    NSPasteboard *pb = [NSPasteboard generalPasteboard];
    [pb clearContents];
    BOOL ok = [pb setString:ns forType:NSPasteboardTypeString];
    return Napi::Boolean::New(env, ok ? true : false);
  }
}

static Napi::Value ClipboardVerify(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "clipboardVerify(expected) requires a string")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  std::string expected = info[0].As<Napi::String>().Utf8Value();
  @autoreleasepool {
    NSPasteboard *pb = [NSPasteboard generalPasteboard];
    NSString *s = [pb stringForType:NSPasteboardTypeString];
    if (!s) return Napi::Boolean::New(env, false);
    std::string got = StdFromNS(s);
    return Napi::Boolean::New(env, got == expected);
  }
}

// ─── Active window / window list ──────────────────────────────────────

static Napi::Value GetActiveWindow(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  @autoreleasepool {
    NSRunningApplication *app = [[NSWorkspace sharedWorkspace] frontmostApplication];
    if (!app) return env.Null();

    NSString *name = app.localizedName ?: @"";
    NSString *bundleId = app.bundleIdentifier ?: @"";

    Napi::Object result = Napi::Object::New(env);
    result.Set("title", Napi::String::New(env, [name UTF8String] ?: ""));
    result.Set("bundleId", Napi::String::New(env, [bundleId UTF8String] ?: ""));
    result.Set("pid", Napi::Number::New(env, (double)app.processIdentifier));
    return result;
  }
}

static Napi::Value ListWindows(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  CFArrayRef list = CGWindowListCopyWindowInfo(
      kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
      kCGNullWindowID);

  Napi::Array result = Napi::Array::New(env);
  if (!list) return result;

  uint32_t idx = 0;
  CFIndex count = CFArrayGetCount(list);
  for (CFIndex i = 0; i < count; i++) {
    CFDictionaryRef d =
        (CFDictionaryRef)CFArrayGetValueAtIndex(list, i);
    if (!d) continue;

    CFStringRef wname = (CFStringRef)CFDictionaryGetValue(d, kCGWindowName);
    CFStringRef owner = (CFStringRef)CFDictionaryGetValue(d, kCGWindowOwnerName);
    CFNumberRef pidRef = (CFNumberRef)CFDictionaryGetValue(d, kCGWindowOwnerPID);
    CFNumberRef layerRef = (CFNumberRef)CFDictionaryGetValue(d, kCGWindowLayer);

    // Skip system/menubar layers (layer != 0)
    int layer = 0;
    if (layerRef) CFNumberGetValue(layerRef, kCFNumberIntType, &layer);
    if (layer != 0) continue;

    int pid = 0;
    if (pidRef) CFNumberGetValue(pidRef, kCFNumberIntType, &pid);

    char nameBuf[512] = {0};
    if (wname) {
      CFStringGetCString(wname, nameBuf, sizeof(nameBuf), kCFStringEncodingUTF8);
    }
    char ownerBuf[256] = {0};
    if (owner) {
      CFStringGetCString(owner, ownerBuf, sizeof(ownerBuf), kCFStringEncodingUTF8);
    }

    Napi::Object w = Napi::Object::New(env);
    w.Set("title", Napi::String::New(env, nameBuf));
    w.Set("bundleId", Napi::String::New(env, ownerBuf));
    w.Set("pid", Napi::Number::New(env, (double)pid));
    result.Set(idx++, w);
  }
  CFRelease(list);
  return result;
}

// ─── Module init ──────────────────────────────────────────────────────

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("screenshot", Napi::Function::New(env, Screenshot));
  exports.Set("mouseMove", Napi::Function::New(env, MouseMove));
  exports.Set("mouseClick", Napi::Function::New(env, MouseClick));
  exports.Set("mouseDrag", Napi::Function::New(env, MouseDrag));
  exports.Set("keyType", Napi::Function::New(env, KeyType));
  exports.Set("keyPress", Napi::Function::New(env, KeyPress));
  exports.Set("clipboardGet", Napi::Function::New(env, ClipboardGet));
  exports.Set("clipboardSet", Napi::Function::New(env, ClipboardSet));
  exports.Set("clipboardVerify", Napi::Function::New(env, ClipboardVerify));
  exports.Set("getActiveWindow", Napi::Function::New(env, GetActiveWindow));
  exports.Set("listWindows", Napi::Function::New(env, ListWindows));
  exports.Set("isAccessibilityTrusted",
              Napi::Function::New(env, IsAccessibilityTrusted));
  return exports;
}

NODE_API_MODULE(noobclaw_desktop, Init)
