/**
 * @copyright Copyright 2020 Kevin Locke <kevin@kevinlocke.name>
 * @license MIT
 */

'use strict';

const {
  AssertionError,
  deepStrictEqual,
  strictEqual,
} = require('assert');

const nodeVersion = process.version.slice(1).split('.').map(Number);

// Dummy function value for equality comparison
const funcValue = () => {};

function collectPropertyDescriptors(propMap, obj) {
  const proto = Object.getPrototypeOf(obj);
  if (proto !== Error.prototype) {
    collectPropertyDescriptors(propMap, proto);
  }
  for (const [p, d] of Object.entries(Object.getOwnPropertyDescriptors(obj))) {
    // Removed (below Error.prototype in inheritance hierarchy) in
    // a86a295fd7 https://github.com/nodejs/node/pull/33857
    if (p === 'constructor' && nodeVersion[0] < 15) {
      continue; // eslint-disable-line no-continue
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
 * @throws If actual is not the same error as expected.
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
  [
    EvalError,
    RangeError,
    ReferenceError,
    SyntaxError,
    TypeError,
    URIError,
  ].some((builtInError) => {
    const actualInstanceOf = actual instanceof builtInError;
    const expectedInstanceOf = expected instanceof builtInError;
    if (actualInstanceOf !== expectedInstanceOf) {
      if (!message) {
        message = `Expected "actual" and "expected" to be instanceof ${
          builtInError.prototype.name}: actual ${
          actualInstanceOf ? 'is' : 'is not'}, expected ${
          expectedInstanceOf ? 'is' : 'is not'}.`;
      }
      throw new AssertionError({
        actual,
        expected,
        message,
        operator: 'errorEqual',
      });
    }

    return actualInstanceOf;
  });

  // Note: Would be nice if OwnPropertyNames was the same, but some vary
  // (e.g. toString moved from proto to instance in nodejs/node@a86a295fd71)

  const actualProps = new Map();
  collectPropertyDescriptors(actualProps, actual);
  const expectedProps = new Map();
  collectPropertyDescriptors(expectedProps, expected);
  deepStrictEqual(actualProps, expectedProps, message);

  strictEqual(String(actual), String(expected), message);
}

module.exports = assertErrorEqual;
