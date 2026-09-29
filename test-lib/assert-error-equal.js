/**
 * @copyright Copyright 2020 Kevin Locke <kevin@kevinlocke.name>
 * @license MIT
 */

'use strict';

const {
  AssertionError,
  deepStrictEqual,
  strictEqual,
} = require('node:assert');

const nodeVersion = process.version.slice(1).split('.').map(Number);

// Dummy function value for equality comparison
const funcValue = () => {};

function collectPropertyDescriptors(propMap, obj) {
  const proto = Object.getPrototypeOf(obj);
  if (proto !== Error.prototype) {
    collectPropertyDescriptors(propMap, proto);
  }
  const ownPropertyDescriptors = Object.getOwnPropertyDescriptors(obj);
  for (const [p, d] of Object.entries(ownPropertyDescriptors)) {
    // Removed (below Error.prototype in inheritance hierarchy) in
    // a86a295fd7 https://github.com/nodejs/node/pull/33857
    if (p === 'constructor' && nodeVersion[0] < 15) {
      continue;
    }

    const desc = {
      configurable: d.configurable,
      enumerable: d.enumerable,
      writable: d.writable,
    };

    // Skip properties where values are not asserted to be equal
    if (p !== 'stack') {
      // Treat accessor and data properties as equal if value returned by
      // getter is equal to the data property value.
      desc.value = obj[p];

      // Function values (e.g. toString) are not asserted to be equal
      if (typeof desc.value === 'function') {
        desc.value = funcValue;
      }
    }

    // Changed in 87fb1c297ad https://github.com/nodejs/node/pull/29677
    if (p === 'code'
      && (nodeVersion[0] < 12
        || (nodeVersion[0] === 12 && nodeVersion[1] < 12))) {
      delete desc.enumerable;
      delete desc.writable;
    }

    // Changed in 1ed3c54ecbd https://github.com/nodejs/node/pull/26738
    if (p === 'name' && nodeVersion[0] < 12) {
      delete desc.writable;
      delete desc.value;
    }

    propMap.set(p, desc);
  }
}

/**
 * Asserts that Error instances represent the same error.
 *
 * Since Node.js does not expose its Error constructors (see
 * https://github.com/nodejs/node/issues/14554), it is difficult to create
 * Error instances which have exactly the same properties and prototype.
 * Especially when the prototypes change between versions, such as in
 * https://github.com/nodejs/node/pull/33857.
 *
 * This function asserts that two Error objects are equal in ways that callers
 * are likely to use (e.g. property enumerability, configurability,
 * writability, values, own properties, and stringification).
 *
 * @param {Error} actual Actual error.
 * @param {Error} expected Expected error.
 * @param {string=} message Error message.
 * @throws {AssertionError} If actual is not the same error as expected.
 */
function assertErrorEqual(actual, expected, message) {
  if (actual === expected) {
    return;
  }

  if (!(actual instanceof Error) || !(expected instanceof Error)) {
    deepStrictEqual(actual, expected, message);
    return;
  }

  // Check instance of same built-in Error type (if any)
  for (const builtInError of [
    EvalError,
    RangeError,
    ReferenceError,
    SyntaxError,
    TypeError,
    URIError,
  ]) {
    const isActualBuiltIn = actual instanceof builtInError;
    const isExpectedBuiltIn = expected instanceof builtInError;
    if (isActualBuiltIn !== isExpectedBuiltIn) {
      message ||= `Expected "actual" and "expected" to be instanceof ${
        builtInError.prototype.name}: actual ${
        isActualBuiltIn ? 'is' : 'is not'}, expected ${
        isExpectedBuiltIn ? 'is' : 'is not'}.`;
      throw new AssertionError({
        actual,
        expected,
        message,
        operator: 'errorEqual',
      });
    }

    if (isActualBuiltIn) {
      // Once the type is found, there's no need to check further
      break;
    }
  }

  // Note: Would be nice if OwnPropertyNames was the same, but some vary
  // (e.g. toString moved from proto to instance in nodejs/node@a86a295fd71)

  const actualProps = new Map();
  collectPropertyDescriptors(actualProps, actual);
  const expectedProps = new Map();
  collectPropertyDescriptors(expectedProps, expected);

  // message changed in https://github.com/nodejs/node/pull/29675
  // ac2fc0dd5f for v14.0.0
  // 33c5dbe197 for v13.6.0
  // df94cfb67c for v12.16.0
  // Note: difficult to check in collectPropertyDescriptors because .message
  // is field of Error while .code can be get/set of Error or prop of TypeError
  // Changed in 87fb1c297ad https://github.com/nodejs/node/pull/29677
  if (actual.code === 'ERR_INVALID_ARG_TYPE'
    && expected.code === 'ERR_INVALID_ARG_TYPE'
    && (nodeVersion[0] < 12
      || (nodeVersion[0] === 12 && nodeVersion[1] < 16)
      || (nodeVersion[0] === 13 && nodeVersion[1] < 6))) {
    actualProps.delete('message');
    expectedProps.delete('message');
  } else {
    strictEqual(String(actual), String(expected), message);
  }

  deepStrictEqual(actualProps, expectedProps, message);
}

module.exports = assertErrorEqual;
