/**
 * @copyright Copyright 2017 Kevin Locke <kevin@kevinlocke.name>
 * @license MIT
 */

'use strict';

/** Copies the (enumerable and non-enumerable) own property descriptors from
 * one or more source objects to a target object.
 * @param {!Object} target Object to which property descriptors are assigned.
 * @return {!Object} target.
 */
function assignOwnPropertyDescriptors(target) {
  var targetObj = Object(target);
  var source;

  function assignProp(propName) {
    var propDesc = Object.getOwnPropertyDescriptor(source, propName);
    Object.defineProperty(targetObj, propName, propDesc);
  }

  for (var i = 1; i < arguments.length; i += 1) {
    source = arguments[i];
    Object.getOwnPropertyNames(source).forEach(assignProp);
    if (Object.getOwnPropertySymbols) {
      Object.getOwnPropertySymbols(source).forEach(assignProp);
    }
  }

  return targetObj;
}

module.exports = assignOwnPropertyDescriptors;
