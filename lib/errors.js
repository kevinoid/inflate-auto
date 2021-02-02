/**
 * Caller-visible Errors thrown by this module.
 *
 * Based on Node.js core errors in lib/internal/errors.js @ v15.0.1.
 *
 * Hopefully the constructors will be exposed in a future version:
 * https://github.com/nodejs/node/issues/14554
 *
 * Copies are already proliferating:
 * https://github.com/nodejs/readable-stream/blob/v3.6.0/errors.js
 * https://github.com/streamich/memfs/blob/v3.2.0/src/internal/errors.ts
 *
 * Looks like there was an attempt to create a standalone module:
 * https://github.com/jasnell/internal-errors
 *
 * @copyright Copyright Joyent, Inc. and other Node contributors.
 * @copyright Copyright 2020 Kevin Locke <kevin@kevinlocke.name>
 * @license MIT
 */

// Most of the content in this file is copied verbatim from Node.js.
// Test coverage is not necessary and checking skews coverage numbers.
/* istanbul ignore file */

'use strict';

const ArrayIsArray = Array.isArray;
const ObjectDefineProperty = Object.defineProperty;

const messages = new Map();
const codes = exports;

const classRegExp = /^([A-Z][a-z0-9]*)+$/;
// Sorted by a rough estimate on most frequently used entries.
const kTypes = [
  'string',
  'function',
  'number',
  'object',
  // Accept 'Function' and 'Object' as alternative to the lower cased version.
  'Function',
  'Object',
  'boolean',
  'bigint',
  'symbol'
];

let excludedStackFn;

let internalUtilInspect = null;
function lazyInternalUtilInspect() {
  if (!internalUtilInspect) {
    internalUtilInspect = require('util');
  }
  return internalUtilInspect;
}

const assert = require('assert');

function makeNodeErrorWithCode(Base, key) {
  return function NodeError(...args) {
    let error;
    if (excludedStackFn === undefined) {
      error = new Base();
    } else {
      const limit = Error.stackTraceLimit;
      Error.stackTraceLimit = 0;
      error = new Base();
      // Reset the limit and setting the name property.
      Error.stackTraceLimit = limit;
    }
    const message = getMessage(key, args, error);
    ObjectDefineProperty(error, 'message', {
      value: message,
      enumerable: false,
      writable: true,
      configurable: true,
    });
    ObjectDefineProperty(error, 'toString', {
      value() {
        return `${this.name} [${key}]: ${this.message}`;
      },
      enumerable: false,
      writable: true,
      configurable: true,
    });
    addCodeToName(error, Base.name, key);
    error.code = key;
    return error;
  };
}

function addCodeToName(err, name, code) {
  // Set the stack
  if (excludedStackFn !== undefined) {
    Error.captureStackTrace(err, excludedStackFn);
  }
  // Add the error code to the name to include it in the stack trace.
  err.name = `${name} [${code}]`;
  // Access the stack to generate the error message including the error code
  // from the name.
  // eslint-disable-next-line no-unused-expressions
  err.stack;
  // Reset the name to the actual name.
  if (name === 'SystemError') {
    ObjectDefineProperty(err, 'name', {
      value: name,
      enumerable: false,
      writable: true,
      configurable: true
    });
  } else {
    delete err.name;
  }
}

// Utility function for registering the error codes. Only used here. Exported
// *only* to allow for testing.
function E(sym, val, def) {
  messages.set(sym, val);
  def = makeNodeErrorWithCode(def, sym);
  codes[sym] = def;
}

function getMessage(key, args, self) {
  const msg = messages.get(key);

  if (typeof msg === 'function') {
    assert(
      msg.length <= args.length, // Default options do not count.
      `Code: ${key}; The provided arguments length (${args.length}) does not ` +
        `match the required ones (${msg.length}).`
    );
    return msg.apply(self, args);
  }

  const expectedLength = (msg.match(/%[dfijoOs]/g) || []).length;
  assert(
    expectedLength === args.length,
    `Code: ${key}; The provided arguments length (${args.length}) does not ` +
      `match the required ones (${expectedLength}).`
  );
  if (args.length === 0)
    return msg;

  args.unshift(msg);
  return lazyInternalUtilInspect().format.apply(null, args);
}

E('ERR_BUFFER_TOO_LARGE',
  'Cannot create a Buffer larger than %s bytes',
  RangeError);
E('ERR_INVALID_ARG_TYPE',
  (name, expected, actual) => {
    assert(typeof name === 'string', "'name' must be a string");
    if (!ArrayIsArray(expected)) {
      expected = [expected];
    }

    let msg = 'The ';
    if (name.endsWith(' argument')) {
      // For cases like 'first argument'
      msg += `${name} `;
    } else {
      const type = name.includes('.') ? 'property' : 'argument';
      msg += `"${name}" ${type} `;
    }
    msg += 'must be ';

    const types = [];
    const instances = [];
    const other = [];

    for (const value of expected) {
      assert(typeof value === 'string',
             'All expected entries have to be of type string');
      if (kTypes.includes(value)) {
        types.push(value.toLowerCase());
      } else if (classRegExp.test(value)) {
        instances.push(value);
      } else {
        assert(value !== 'object',
               'The value "object" should be written as "Object"');
        other.push(value);
      }
    }

    // Special handle `object` in case other instances are allowed to outline
    // the differences between each other.
    if (instances.length > 0) {
      const pos = types.indexOf('object');
      if (pos !== -1) {
        types.splice(pos, 1);
        instances.push('Object');
      }
    }

    if (types.length > 0) {
      if (types.length > 2) {
        const last = types.pop();
        msg += `one of type ${types.join(', ')}, or ${last}`;
      } else if (types.length === 2) {
        msg += `one of type ${types[0]} or ${types[1]}`;
      } else {
        msg += `of type ${types[0]}`;
      }
      if (instances.length > 0 || other.length > 0)
        msg += ' or ';
    }

    if (instances.length > 0) {
      if (instances.length > 2) {
        const last = instances.pop();
        msg += `an instance of ${instances.join(', ')}, or ${last}`;
      } else {
        msg += `an instance of ${instances[0]}`;
        if (instances.length === 2) {
          msg += ` or ${instances[1]}`;
        }
      }
      if (other.length > 0)
        msg += ' or ';
    }

    if (other.length > 0) {
      if (other.length > 2) {
        const last = other.pop();
        msg += `one of ${other.join(', ')}, or ${last}`;
      } else if (other.length === 2) {
        msg += `one of ${other[0]} or ${other[1]}`;
      } else {
        if (other[0].toLowerCase() !== other[0])
          msg += 'an ';
        msg += `${other[0]}`;
      }
    }

    if (actual == null) {
      msg += `. Received ${actual}`;
    } else if (typeof actual === 'function' && actual.name) {
      msg += `. Received function ${actual.name}`;
    } else if (typeof actual === 'object') {
      if (actual.constructor && actual.constructor.name) {
        msg += `. Received an instance of ${actual.constructor.name}`;
      } else {
        const inspected = lazyInternalUtilInspect()
          .inspect(actual, { depth: -1 });
        msg += `. Received ${inspected}`;
      }
    } else {
      let inspected = lazyInternalUtilInspect()
        .inspect(actual, { colors: false });
      if (inspected.length > 25)
        inspected = `${inspected.slice(0, 25)}...`;
      msg += `. Received type ${typeof actual} (${inspected})`;
    }
    return msg;
  }, TypeError);
E('ERR_STREAM_PREMATURE_CLOSE', 'Premature close', Error);

codes.ERR_SYNC_NOT_SUPPORTED = class InflateAutoError extends Error {
  constructor(target) {
    super();
    let message = 'Synchronous operation is not supported';
    if (target) {
      message += ` by ${target}`;
    }
    message += '.';
    Object.defineProperty(this, 'message', {
      value: message,
      enumerable: false,
      writable: true,
      configurable: true,
    });
    this.name = 'InflateAutoError';
    this.code = 'ERR_SYNC_NOT_SUPPORTED';
  }
};
