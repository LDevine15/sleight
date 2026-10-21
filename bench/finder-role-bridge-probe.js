// Fixed local NSString bridge calibration. No app, AX query, file, or input access.
function run(argv) {
  var result = { probe: 'finder-role-bridge', importState: 'unavailable', routes: [],
    constants: { roleAttributeEqual: 'unavailable', windowRoleEqual: 'unavailable' } };
  if (argv && argv.length) {
    result.error = 'arguments-not-supported';
    return JSON.stringify(result);
  }
  try { ObjC.import('AppKit'); ObjC.import('CoreFoundation'); }
  catch (error) { return JSON.stringify(result); }
  result.importState = 'available';

  function usable(value) {
    try { return !!value && !(value.isNil && value.isNil()); }
    catch (error) { return false; }
  }
  function equal(a, b) {
    if (!usable(a) || !usable(b)) return 'unavailable';
    try {
      var value = Number($.CFEqual(a, b));
      return value === 1 ? 'yes' : value === 0 ? 'no' : 'unavailable';
    } catch (error) { return 'unavailable'; }
  }
  function type(value) {
    if (!usable(value)) return 'unavailable';
    try {
      var actual = Number($.CFGetTypeID(value)), string = Number($.CFStringGetTypeID());
      if (!isFinite(actual) || actual <= 0 || !isFinite(string) || string <= 0) return 'unavailable';
      return actual === string ? 'cf-string' : 'other';
    } catch (error) { return 'unavailable'; }
  }
  function conversion(value, expected, deep) {
    if (!usable(value)) return 'unavailable';
    try {
      var converted = deep ? ObjC.deepUnwrap(value) : ObjC.unwrap(value);
      if (converted == null) return 'nil';
      if (typeof converted !== 'string') return 'nonstring';
      return converted === expected ? 'expected' : 'other-string';
    } catch (error) { return 'unavailable'; }
  }
  function row(name, route, value, expected, other) {
    result.routes.push({ value: name, route: route, nativeType: type(value),
      nativeExpectedEqual: equal(value, expected), nativeOtherEqual: equal(value, other),
      unwrap: conversion(value, name, false), deepUnwrap: conversion(value, name, true) });
  }
  var windowString, roleString;
  try { windowString = $('AXWindow'); roleString = $('AXRole'); } catch (error) {}
  try { result.constants.roleAttributeEqual = equal(roleString, $.NSAccessibilityRoleAttribute); } catch (error) {}
  try { result.constants.windowRoleEqual = equal(windowString, $.NSAccessibilityWindowRole); } catch (error) {}
  [{ name: 'AXWindow', value: windowString, other: roleString }, { name: 'AXRole', value: roleString, other: windowString }].forEach(function (item) {
    row(item.name, 'bridged-nsstring', item.value, item.value, item.other);
    var reference, roundtrip;
    if (usable(item.value)) {
      try { reference = ObjC.castObjectToRef(item.value); } catch (error) {}
    }
    row(item.name, 'cast-object-to-ref', reference, item.value, item.other);
    if (usable(reference)) {
      try { roundtrip = ObjC.castRefToObject(reference); } catch (error) {}
    }
    row(item.name, 'cast-ref-to-object-roundtrip', roundtrip, item.value, item.other);
  });
  return JSON.stringify(result);
}
