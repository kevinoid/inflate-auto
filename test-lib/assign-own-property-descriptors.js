/**
 * @copyright Copyright 2017-2018 Kevin Locke <kevin@kevinlocke.name>
 * @license MIT
 */

'use strict';

/** Copies the (enumerable and non-enumerable) own property descriptors from
 * one or more source objects to a target object.
 * @param {!Object} target Object to which property descriptors are assigned.
 * @param {!Object} ...sources Objects from which property descriptors are
 * copied.
 * @return {!Object} target.
 */
function assignOwnPropertyDescriptors(target, ...sources) {
  const targetObj = Object(target);

  sources.forEach((source) => {
    function assignProp(propName) {
      const propDesc = Object.getOwnPropertyDescriptor(source, propName);
      Object.defineProperty(targetObj, propName, propDesc);
    }

    Object.getOwnPropertyNames(source).forEach(assignProp);
    if (Object.getOwnPropertySymbols) {
      Object.getOwnPropertySymbols(source).forEach(assignProp);
    }
  });

  return targetObj;
}

module.exports = assignOwnPropertyDescriptors;
