// Posts one left mouse-up at the pointer's current position, through the HID tap. With no button held it changes nothing;
// after an arm leaves a drag half done, it ends the app's mouse tracking loop. A mouse-up posted to the app's pid didn't
// (Finder, 2026-10-16). The pointer doesn't move.
ObjC.import('CoreGraphics');
function run() {
  const location = $.CGEventGetLocation($.CGEventCreate(null));
  $.CGEventPost(0, $.CGEventCreateMouseEvent(null, 2, location, 0));
  return 'released';
}
