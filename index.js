/**
 * @copyright Copyright 2016-2020 Kevin Locke <kevin@kevinlocke.name>
 * @license MIT
 * @module inflate-auto
 */

// It's helpful to use named parameters for documentation, which makes
// re-building the argument list annoying and error prone.  Since that is done
// frequently in this module, disable prefer-rest-params here.
/* eslint-disable prefer-rest-params */

'use strict';

const assert = require('node:assert');
const { Transform } = require('node:stream');
const {
  debuglog,
  types: {
    isAnyArrayBuffer,
    isArrayBufferView,
  },
} = require('node:util');
const zlib = require('node:zlib');

const {
  ERR_INVALID_ARG_TYPE,
  ERR_STREAM_PREMATURE_CLOSE,
  ERR_SYNC_NOT_SUPPORTED,
} = require('./lib/errors.js');
const zlibInternal = require('./lib/zlib-internal.js');

const {
  INFLATE, Z_NO_FLUSH, Z_BLOCK, Z_FULL_FLUSH, Z_FINISH,
} = zlib.constants;

const debug = debuglog('inflate-auto');

// ZlibBase is not considered to be a part of the Node.js API.
// The risk that it will change is weighed against the value of more closely
// matching the behavior of the zlib classes in several version-dependent ways
// (e.g. autoDestroy, constructor argument validation, underscore properties).
const ZlibBase = Object.getPrototypeOf(Object.getPrototypeOf(zlib.Inflate));
const useZlibBase = ZlibBase.name === 'ZlibBase' && ZlibBase.length === 4;
if (!useZlibBase) {
  debug(
    'Not using zlib base class %s with %d arguments',
    ZlibBase.name,
    ZlibBase.length,
  );
}

// Default options passed to ZlibBase by Zlib (i.e. classes other than Brotli)
const zlibDefaultOpts = {
  flush: Z_NO_FLUSH,
  finishFlush: Z_FINISH,
  fullFlush: Z_FULL_FLUSH,
};

/**
 * Inherit the prototype methods from one constructor into another, as done
 * by ES6 class declarations.
 *
 * @private
 */
function inheritsES6(Ctor, SuperCtor) {
  Object.setPrototypeOf(Ctor.prototype, SuperCtor.prototype);
  Object.setPrototypeOf(Ctor, SuperCtor);
}

function isNotFunction(val) {
  return typeof val !== 'function';
}

function runDetectors(chunk, detectors, detectorsLeft) {
  for (const detector of detectors) {
    const format = detector(chunk);
    if (format) {
      return format;
    }
    if (format === undefined) {
      detectorsLeft.push(detector);
    }
  }

  return undefined;
}

/** A function which detects the format for a given chunk of data.
 *
 * The function may be called any number of times with non-<code>null</code>,
 * non-empty <code>Buffer</code>s.  The return value can be any of the
 * following:
 * <ol>
 * <li>If a format can be definitively determined:  A constructor for the
 * <code>stream.Duplex</code> class of the format which takes the
 * <code>options</code> Object as an argument.  An instance of the class will
 * be used to decode data written to this stream.</li>
 * <li>If all formats supported by this detector can be definitively ruled out:
 * <code>null</code>.  This function will not be called again unless the
 * stream is reset.</li>
 * <li>None of the above: <code>undefined</code>.  This function will be called
 * again when more data is available.</li>
 * </ol>
 *
 * @callback InflateAuto.FormatDetector
 * @param {!Buffer} chunk Non-empty chunk of data to check.
 * @returns {?function(new: module:stream.Duplex, object=)|undefined}
 * Constructor for a <code>stream.Duplex</code> class to decode
 * <code>chunk</code> and subsequent data written to the stream,
 * <code>null</code> if the format is unrecognized/unsupported,
 * <code>undefined</code> if format detection requires more data.
 */

/**
 * Define JSDoc type for <code>ArrayBufferView</code>
 * {@see https://developer.mozilla.org/en-US/docs/Web/API/ArrayBufferView}
 * {@see ArrayBuffer.isView}
 *
 * @typedef {
 *   Int8Array|
 *   Uint8Array|
 *   Uint8ClampedArray|
 *   Int16Array|
 *   Uint16Array|
 *   Int32Array|
 *   Uint32Array|
 *   Float32Array|
 *   Float64Array|
 *   DataView|
 *   Buffer} ArrayBufferView
 */

/** Options for {@link InflateAuto}.
 *
 * Note that the InflateAuto options object is passed to the constructor for
 * the detected data format to allow drop-in replacement.  It may have
 * additional properties to the ones defined here.
 *
 * @typedef {{
 *   defaultFormat:
 *     ?function(new:module:stream.Duplex, object=)|boolean|undefined,
 *   detectors: Array<!InflateAuto.FormatDetector>|undefined
 * }} InflateAuto.InflateAutoOptions
 * @augments zlib.Zlib.options
 * @property {function(new:module:stream.Duplex, object=)|boolean=
 * } defaultFormat Constructor of the format which is used if no detectors
 * match.  Pass <code>null</code> or <code>false</code> for no default.
 * (default: <code>InflateRaw</code>)
 * @property {Array<!InflateAuto.FormatDetector>=} detectors Functions which
 * detect the data format for a chunk of data and return the constructor for a
 * class to decode the data.  If any detector requires large amounts of data,
 * adjust <code>highWaterMark</code> appropriately.  (default:
 * <code>[detectDeflate, detectGzip]</code>)
 */
// var InflateAutoOptions;

/** Decompressor for DEFLATE compressed data in either zlib, gzip, or "raw"
 * format.
 *
 * <p>This class is intended to be a drop-in replacement for
 * <code>zlib.Inflate</code>, <code>zlib.InflateRaw</code>, and/or
 * <code>zlib.Gunzip</code>.</p>
 *
 * <p>This class emits the additional event <code>'format'</code> when the
 * compression format has been set or detected with the instance of the format
 * class which will be used to decode the data.</p>
 *
 * @class
 * @augments module:stream.Transform
 * @param {InflateAuto.InflateAutoOptions=} opts Combined options for this
 * class and for the detected format.
 */
function InflateAuto(opts) {
  if (!(this instanceof InflateAuto)) {
    return new InflateAuto(opts);
  }

  if (useZlibBase) {
    ZlibBase.call(
      this,
      opts,
      INFLATE,
      {},
      zlibDefaultOpts,
    );
  } else {
    // Ignore encoding, objectMode, and writableObjectMode
    // as done in nodejs/node@add4b0ab8c (v9 and later)
    if (opts && (opts.encoding || opts.objectMode || opts.writableObjectMode)) {
      opts = { ...opts };
      opts.encoding = undefined;
      opts.objectMode = false;
      opts.writableObjectMode = false;
    }

    Transform.call(this, opts);

    // Required by zlibInternal.zlibBufferSync
    this._finishFlushFlag =
      opts && opts.finishFlush >= Z_NO_FLUSH && opts.finishFlush <= Z_BLOCK
        ? opts.finishFlush
        : zlibDefaultOpts.finishFlush;
    this._info = opts && opts.info;

    // Behave like Zlib where close is unconditionally called on 'end'
    this.once('end', this.close);
  }

  // null if #close() has been called, otherwise a (dummy) object
  this._handle = {
    close: () => {},
  };

  /**
   * Instance of a class which does the decoding for the detected data format.
   *
   * @private
   */
  this._decoder = null; // eslint-disable-line unicorn/no-null

  /**
   * Detectors for formats supported by this instance.
   *
   * @private
   */
  this._detectors = undefined;
  if (opts && opts.detectors) {
    if (Math.floor(opts.detectors.length) !== opts.detectors.length) {
      throw new ERR_INVALID_ARG_TYPE(
        'opts.detectors',
        'Array-like',
        opts.detectors,
      );
    }

    const nonFuncInd = Array.prototype.find.call(opts.detectors, isNotFunction);
    if (nonFuncInd >= 0) {
      throw new ERR_INVALID_ARG_TYPE(
        `opts.detectors[${nonFuncInd}]`,
        'function',
        opts.detectors[nonFuncInd],
      );
    }

    this._detectors = Array.prototype.slice.call(opts.detectors);
  } else {
    this._detectors = [
      InflateAuto.detectors.detectDeflate,
      InflateAuto.detectors.detectGzip,
    ];
  }

  /**
   * Detectors which are still plausible given previous data.
   *
   * @private
   */
  this._detectorsLeft = this._detectors;

  /**
   * Default format which is used if no detectors match.
   *
   * @private
   */
  this._defaultFormat = undefined;
  if (opts && opts.defaultFormat) {
    if (typeof opts.defaultFormat !== 'function') {
      throw new ERR_INVALID_ARG_TYPE(
        'opts.defaultFormat',
        'function',
        opts.defaultFormat,
      );
    }
    this._defaultFormat = opts.defaultFormat;
  } else if (!opts || opts.defaultFormat === undefined) {
    this._defaultFormat = zlib.InflateRaw;
  }

  /**
   * Options to pass to the format constructor when created.
   *
   * @private
   */
  this._opts = opts;

  /* Invariant:
   * At most one of _decoder or _writeBuf is not undefined.
   * Since writes are being forwarded or buffered.
   */
  this._writeBuf = undefined;
}
inheritsES6(InflateAuto, useZlibBase ? ZlibBase : Transform);

if (!useZlibBase) {
  // Define _closed from _handle as Zlib does since nodejs/node@b53473f0e7e (v7)
  Object.defineProperty(InflateAuto.prototype, '_closed', {
    configurable: true,
    enumerable: true,
    get() {
      return !this._handle;
    },
  });
}

/** Creates an instance of {@link InflateAuto}.
 * Analogous to {@link zlib.createInflate}.
 *
 * @param {object=} opts Constructor options.
 * @returns {InflateAuto} Instance of InflateAuto with <code>opts</code>.
 */
InflateAuto.createInflateAuto = function createInflateAuto(opts) {
  return new InflateAuto(opts);
};

/**
 * Format detectors supported by default.
 *
 * @constant
 * @enum {InflateAuto.FormatDetector}
 */
InflateAuto.detectors = {
  /** Detects the ZLIB DEFLATE format, as specified in RFC 1950.
   *
   * @param {!Buffer} chunk Chunk of data to check.
   * @returns {?zlib.Inflate|undefined} <code>zlib.Inflate</code> if the data
   * conforms to RFC 1950 Section 2.2, <code>undefined</code> if the data may
   * conform, <code>null</code> if it does not conform.
   */
  detectDeflate: function detectDeflate(chunk) {
    // CM field (least-significant 4 bits) must be 8
    // eslint-disable-next-line no-bitwise
    if ((chunk[0] & 0x0F) === 8) {
      if (chunk.length === 1) {
        // Can't know yet whether header is valid
        return undefined;
      }

      // FCHECK field ensures first 16-bit BE int is a multiple of 31
      if ((chunk.readUInt16BE(0) % 31) === 0) {
        // Valid ZLIB header
        return zlib.Inflate;
      }
    }

    // eslint-disable-next-line unicorn/no-null
    return null;
  },
  /** Detects the GZIP format, as specified in RFC 1952.
   *
   * @param {!Buffer} chunk Chunk of data to check.
   * @returns {?zlib.Gunzip|undefined} <code>zlib.Gunzip</code> if the data
   * conforms to RFC 1952, <code>undefined</code> if the data may conform,
   * <code>null</code> if it does not conform.
   */
  detectGzip: function detectGzip(chunk) {
    // Check for gzip header per Section 2.3.1 of RFC 1952
    if (chunk[0] === 0x1F) {
      if (chunk.length === 1) {
        // Can't know yet whether header is valid
        return undefined;
      }

      if (chunk[1] === 0x8B) {
        if (chunk.length === 2) {
          // Can't know yet whether header is valid
          return undefined;
        }

        if (chunk[2] === 8) {
          // Valid gzip header
          return zlib.Gunzip;
        }
      }
    }

    // eslint-disable-next-line unicorn/no-null
    return null;
  },
};

/** Decompresses a compressed <code>Buffer</code>.
 * Analogous to {@link zlib.inflate}.
 *
 * @param {!Buffer} buffer Compressed data to decompress.
 * @param {object=} opts Decompression options.
 * @param {!function(Error, Buffer=)} callback Callback which receives the
 * decompressed data.
 */
InflateAuto.inflateAuto = function inflateAuto(buffer, opts, callback) {
  if (typeof opts === 'function') {
    callback = opts;
    opts = {};
  }
  zlibInternal.zlibBuffer(new InflateAuto(opts), buffer, callback);
};

/** Decompresses a compressed Buffer synchronously.
 * Analogous to {@link zlib.inflateSync}.
 *
 * @param {!Buffer} buffer Compressed data to decompress.
 * @param {object=} opts Decompression options.
 * @returns {!Buffer} Decompressed data.
 */
InflateAuto.inflateAutoSync = function inflateAutoSync(buffer, opts) {
  return zlibInternal.zlibBufferSync(new InflateAuto(opts), buffer);
};

/** Implements {@link #destroy} on this stream by ensuring
 * <code>_handle</code> is set <code>null</code> (for <code>_closed</code>)
 * as done by {@link zlib.ZlibBase#_destroy} since nodejs/node@8a02d941b6c
 * (v12) and nodejs/node@c6a43fa2ef (v10.15.1).
 *
 * @param {Error} err Error passed to {@link #destroy}.
 * @param {function(Error=)} callback Callback once destroyed.
 */
InflateAuto.prototype._destroy = function _destroy(err, callback) {
  // eslint-disable-next-line unicorn/no-null
  this._handle = null;
  callback(err);
};

/** Detects the format of a given <code>Buffer</code>.
 *
 * This method passes <code>chunk</code> to each of the {@link
 * module:inflate-auto.InflateAutoOptions.detectors}.  The first detector to
 * match is returned.  If at least one detector is indeterminate and
 * <code>end</code> is <code>false</code>, <code>null</code> is returned.
 * Otherwise {@link module:inflate-auto.InflateAutoOptions.defaultFormat} is
 * returned or an <code>Error</code> is thrown.
 *
 * @protected
 * @param {Buffer} chunk Beginning of data for which to detect the
 * compression format.
 * @param {boolean} end Is <code>chunk</code> the end of the data stream?
 * @returns {?function(new:module:stream.Duplex, object=)}
 * An instance of the zlib type which will decode <code>chunk</code> and
 * subsequent data, or <code>null</code> if <code>chunk</code> is too short to
 * deduce the format conclusively and <code>end</code> is <code>false</code>.
 * @throws If any detector throws or <code>end</code> is <code>true</code> and
 * no default format is given.
 */
InflateAuto.prototype._detectFormat = function _detectFormat(chunk, end) {
  if (chunk && chunk.length > 0) {
    const newDetectorsLeft = [];
    const format = runDetectors(chunk, this._detectorsLeft, newDetectorsLeft);
    if (format) {
      return format;
    }
    this._detectorsLeft = newDetectorsLeft;
  }

  if (this._detectorsLeft.length === 0 || end) {
    if (this._defaultFormat) {
      return this._defaultFormat;
    }

    const err = new Error('data did not match any supported formats');
    err.data = chunk;
    throw err;
  }

  return undefined;
};

/** Flushes any buffered data when the stream is ending.
 *
 * @protected
 * @param {function(Error=)} callback Callback once stream has ended.
 */
InflateAuto.prototype._flush = function _flush(callback) {
  if (!this._decoder) {
    // Previous header checks inconclusive.  Must choose one now.
    try {
      this.setFormat(this._detectFormat(this._writeBuf, true));
    } catch (err) {
      // Before nodejs/node#28979 (v13) _flush would be called after a write
      // error.  If it returned an error, both would be emitted.  This occurrs
      // when _writeEarly fails in both (e.g. due to defaultFormat: null).
      // Avoid emitting an error twice in this case.
      callback(
        this._writableState && this._writableState.errorEmitted ? undefined
          : err,
      );
      return;
    }
  }

  // callback must not be called until all data has been pushed to this stream.
  // So call on 'end', not 'finish'.
  //
  // Note:  Not called on 'error' since errors events already forwarded
  // and should not emit 'end' after 'error'
  this._decoder.once('end', callback);

  const chunk = this._writeBuf;
  this._writeBuf = undefined;
  this._decoder.end(chunk);
};

if (zlib.Inflate.prototype._processChunk) {
  /** Process a chunk of data, synchronously or asynchronously.
   *
   * @protected
   * @param {!TypedArray|!DataView} chunk Chunk of data to write.
   * @param {number} flushFlag Flush flag with which to write the data.
   * @param {?function(Error=)=} cb Callback.  Synchronous if falsey.
   * @returns {!Buffer|undefined} Decompressed chunk if synchronous, otherwise
   * <code>undefined</code>.
   * @throws If a detector or format constructor throws and <code>cb</code> is
   * not a function.
   */
  InflateAuto.prototype._processChunk = function _processChunk(
    chunk,
    flushFlag,
    cb,
  ) {
    if (!Buffer.isBuffer(chunk)) {
      if (isArrayBufferView(chunk)) {
        chunk = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      } else if (isAnyArrayBuffer(chunk) || typeof chunk === 'string') {
        chunk = Buffer.from(chunk);
      } else {
        throw new ERR_INVALID_ARG_TYPE(
          'chunk',
          ['string', 'Buffer', 'TypedArray', 'DataView', 'ArrayBuffer'],
          chunk,
        );
      }
    }

    if (!this._decoder) {
      try {
        chunk = this._writeEarly(chunk);
      } catch (err) {
        if (typeof cb === 'function') {
          cb(err);
          return undefined;
        }

        throw err;
      }

      if (!this._decoder && typeof cb !== 'function') {
        // Synchronous calls operate on complete buffer.  Choose format now.
        this.setFormat(this._detectFormat(chunk, true));
      }
    }

    if (this._decoder) {
      if (typeof this._decoder._processChunk === 'function') {
        // Suppress throwing for unhandled 'error' event when called without cb,
        // as done by processChunkSync.
        // Note: Can't unregister handler when _processChunk returns due to
        // #destroy(err) emitting after next tick on error since
        // nodejs/node#32220 (v14).  processChunkSync leaves it permanently.
        if (typeof cb !== 'function') {
          this.on('error', () => {});
        }

        return this._decoder._processChunk(chunk, flushFlag, cb);
      }

      // Fallback to _transform, where possible.
      // Only works synchronously when callback is called with data immediately.
      if (typeof this._decoder._transform === 'function') {
        let needCb = false;
        let retVal;
        if (typeof cb !== 'function') {
          needCb = true;
          cb = function(err, result) {
            if (err) {
              throw err;
            }
            retVal = result;
          };
        }
        this._decoder._transform(chunk, undefined, cb);
        if (!needCb || retVal) {
          return retVal;
        }
      }

      const fmtName =
        (this._decoder.constructor && this._decoder.constructor.name)
        || 'the detected format';
      throw new ERR_SYNC_NOT_SUPPORTED(fmtName);
    }

    this._writeBuf = chunk;
    queueMicrotask(cb);
    return undefined;
  };
}

/** Sets the format which will be used to decode data written to this stream.
 *
 * Note:  The current implementation only allows the format to be set once.
 * Calling this method after the format has been set will throw an exception.
 *
 * @param {function(new:module:stream.Duplex, object=)} Format Constructor for
 * the stream class which will be used to decode data written to this stream.
 * @throws If previously set to a different <code>Format</code> or
 * <code>Format</code> constructor throws.
 * @see #_detectFormat()
 */
InflateAuto.prototype.setFormat = function setFormat(Format) {
  if (this._decoder && Format === this._decoder.constructor) {
    return;
  }

  // We would need to disconnect event handlers and close the previous
  // format to avoid leaking.  No current use case.
  if (this._decoder) {
    throw new Error('Changing format is not supported');
  }

  // Reuse instance from option validation, if Format matches.
  const format = new Format(this._opts);

  this._decoder = format;

  // Ensure .constructor is set properly by Format constructor
  if (format.constructor !== Format) {
    format.constructor = Format;
  }

  format.on('data', (chunk) => this.push(chunk));
  format.once('end', (chunk) => {
    // format may emit 'end' before 'finish' (and before .end() is called)
    // when there is data after the end of compressed input.
    // https://github.com/nodejs/node/pull/26363
    // Call push(null) to end this stream when the format has ended.
    this.push(null);  // eslint-disable-line unicorn/no-null
  });
  // Note: Readable.wrap proxies 'destroy' event.  No current use is known, but
  // we proxy it here for compatibility with non-Zlib formats.
  format.on('destroy', (...args) => this.emit('destroy', ...args));
  format.on('error', (...args) => {
    if (this._readableState && this._readableState.autoDestroy) {
      this.destroy(...args);
    } else {
      this.emit('error', ...args);
    }
  });

  this.emit('format', format);

  if (this._queuedMethodCalls) {
    for (const mc of this._queuedMethodCalls) {
      format[mc.name](...mc.args);
    }
    delete this._queuedMethodCalls;
  }
};

/** Inflates a chunk of data.
 *
 * @protected
 * @param {Buffer} chunk Chunk of data to inflate.
 * @param {?string} encoding Ignored.
 * @param {?function(Error)=} callback Callback once chunk has been written.
 */
InflateAuto.prototype._transform = function _transform(
  chunk,
  encoding,
  callback,
) {
  if (!this._decoder) {
    try {
      chunk = this._writeEarly(chunk);
    } catch (err) {
      callback(err);
      return;
    }
  }

  if (this._decoder) {
    this._decoder.write(chunk, encoding, callback);
  } else {
    this._writeBuf = chunk;
    queueMicrotask(callback);
  }
};

/** Writes data to this stream before the format has been detected, performing
 * format detection and returning the combined write buffer.
 *
 * @private
 * @param {Buffer} chunk Chunk of data to write.
 * @returns {Buffer} <code>chunk</code> appended to any previously buffered
 * data.
 * @throws If a detector or format constructor throws.  In this case the data
 * will be saved in <code>_writeBuf</code>.
 */
InflateAuto.prototype._writeEarly = function _writeEarly(chunk) {
  if (chunk === null || chunk.length === 0) {
    return chunk;
  }

  let signature;
  if (this._writeBuf) {
    signature = Buffer.concat([this._writeBuf, chunk]);
  } else {
    signature = chunk;
  }

  // If _detectFormat or setFormat throw, data will be buffered
  this._writeBuf = signature;

  const Format = this._detectFormat(signature);
  if (Format) {
    this.setFormat(Format);
  }

  // Caller is responsible for writing or buffering returned data
  this._writeBuf = undefined;
  return signature;
};

/** Closes this stream and its underlying resources (zlib handle).
 *
 * @param {?function(Error)=} callback Callback once resources have been
 * freed.
 */
InflateAuto.prototype.close = function close(callback) {
  if (this._decoder && typeof this._decoder.close === 'function') {
    this._decoder.close(callback);
  } else if (callback) {
    queueMicrotask(() => {
      callback(new ERR_STREAM_PREMATURE_CLOSE());
    });
  }

  this.destroy();
};

/** Gets the constructor function used to create the decoder for data written
 * to this stream.
 *
 * @returns {?function(new:module:stream.Duplex, object=)} Constructor for the
 * stream class which is used to decode data written to this stream, or
 * <code>undefined</code> if the format has not been detected or set.
 * @see #_detectFormat()
 * @see #setFormat()
 */
InflateAuto.prototype.getFormat = function getFormat() {
  return this._decoder && this._decoder.constructor;
};

// Not known to return anything, but passes through return value anyway.
// eslint-disable-next-line jsdoc/require-returns
/** Flushes queued writes with a given zlib flush behavior.
 *
 * @param {number=} kind Flush behavior of writes to zlib.  Must be one of the
 * zlib flush constant values.
 * @param {?function(Error)=} callback Callback once data has been flushed.
 */
InflateAuto.prototype.flush = function flush(kind, callback) {
  if (this._decoder) {
    return this._decoder.flush(...arguments);
  }

  this._queueMethodCall('flush', arguments);
  return undefined;
};

if (zlib.Inflate.prototype.params) {
  // Not known to return anything, but passes through return value anyway.
  // eslint-disable-next-line jsdoc/require-returns
  /** Sets the inflate compression parameters.
   *
   * <p>For inflate, this has no effect.  This method is kept for compatibility
   * only.  It is only defined when {@link
   * module:inflate-auto.Inflate.prototype.params} is defined.</p>
   *
   * <p>Note: Parameter checking is not performed if the format hasn't been
   * determined.  Although this is currently possible (since parameters are
   * currently independent of format) it requires instantiating a zlib object
   * with bindings, which is heavy for checking args which haven't changed
   * since this method was added to the Node API.  If there is a use case for
   * such checking, please open an issue.</p>
   *
   * @param {number} level Compression level (between {@link zlib.Z_MIN_LEVEL}
   * and {@link zlib.Z_MAX_LEVEL}).
   * @param {number} strategy Compression strategy (one of the zlib strategy
   * constant values).
   * @param {?function(Error)=} callback Callback once parameters have been
   * set.
   */
  InflateAuto.prototype.params = function params(level, strategy, callback) {
    if (this._decoder) {
      return this._decoder.params(...arguments);
    }

    this._queueMethodCall('params', arguments);
    return undefined;
  };
}

// Not known to return anything, but passes through return value anyway.
// eslint-disable-next-line jsdoc/require-returns
/** Discards any buffered data and resets the decoder to its initial state.
 *
 * <p><b>Note:</b>  If a format has been detected, reset does not currently
 * clear the detection (for performance and to reduce complexity).  If there
 * is a real-world use case for this type of "full reset", please open an
 * issue.</p>
 */
InflateAuto.prototype.reset = function reset() {
  if (this._decoder) {
    return this._decoder.reset(...arguments);
  }

  assert(!!this._handle, 'zlib binding closed');
  this._writeBuf = undefined;
  this._detectorsLeft = this._detectors;
  return undefined;
};

/** Queues a method call for the format until one is set.
 *
 * <p>In addition to queueing the method call, if the arguments includes a
 * callback function, that function is invoked immediately in order to
 * prevent deadlocks in existing code which doesn't write until the callback
 * completes.</p>
 *
 * @protected
 * @param {string} name Name of the method to call.
 * @param {!(arguments|Array)} args Arguments to pass to the method call.
 */
InflateAuto.prototype._queueMethodCall = function _queueMethodCall(name, args) {
  assert(!this._decoder);

  // Ideally we would let the proxied method call the callback,
  // but callers may depend on a reply before the next write.
  // So call the callback now to avoid deadlocks.
  const lastArg = args.at(-1);
  if (typeof lastArg === 'function') {
    args = Array.prototype.slice.call(args, 0, -1);
    queueMicrotask(lastArg);
  }

  this._queuedMethodCalls ||= [];
  this._queuedMethodCalls.push({ name, args });
};

module.exports = InflateAuto;
