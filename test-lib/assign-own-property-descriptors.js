/**
 * @copyright Copyright 2017-2018 Kevin Locke <kevin@kevinlocke.name>
 * @license MIT
 */

'use strict';

/**
 * Copies the (enumerable and non-enumerable) own property descriptors from
 * one or more source objects to a target object.
 *
 * @param {!object} target Object to which property descriptors are assigned.
 * @param {!object} sources Objects from which property descriptors are copied.
 * @returns {!object} target.
 */
function assignOwnPropertyDescriptors(target, ...sources) {
  // eslint-disable-next-line no-new-object
  const targetObj = new Object(target);

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
