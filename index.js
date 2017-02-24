/**
 * @copyright Copyright 2016-2017 Kevin Locke <kevin@kevinlocke.name>
 * @license MIT
 */

'use strict';

var Transform = require('stream').Transform;
var assert = require('assert').ok;
var inherits = require('util').inherits;
var zlib = require('zlib');
var zlibInternal = require('./lib/zlib-internal');

function isFunction(val) {
  return typeof val === 'function';
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
 * @return {?function(new:stream.Duplex, Object=)|undefined} Constructor for a
 * <code>stream.Duplex</code> class to decode <code>chunk</code> and subsequent
 * data written to the stream, <code>null</code> if the format is
 * unrecognized/unsupported, <code>undefined</code> if format detection requires
 * more data.
 */

/** Options for {@link InflateAuto}.
 *
 * Note that the InflateAuto options object is passed to the constructor for
 * the detected data format to allow drop-in replacement.  It may have
 * additional properties to the ones defined here.
 *
 * @typedef {{
 *   defaultFormat: ?function(new:stream.Duplex, Object=)|false|undefined,
 *   detectors: Array<!InflateAuto.FormatDetector>|undefined
 * }} InflateAuto.InflateAutoOptions
 * @extends zlib.Zlib.options
 * @property {function(new:stream.Duplex, Object=)=} defaultFormat Constructor
 * of the format which is used if no detectors match.  Pass <code>null</code>
 * or <code>false</code> for no default. (default: <code>InflateRaw</code>)
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
 * @constructor
 * @extends stream.Transform
 * @param {InflateAuto.InflateAutoOptions=} opts Combined options for this
 * class and for the detected format.
 */
function InflateAuto(opts) {
  if (!(this instanceof InflateAuto)) {
    return new InflateAuto(opts);
  }

  Transform.call(this, opts);

  // Note:  Copy validation code rather than calling Zlib constructor to avoid
  // overhead of zlib binding initialization.
  zlibInternal.validateOptions(opts);

  /** Whether #close() has been called.
   * @private {boolean} */
  this._closed = false;

  // For Zlib compatibility
  this._finishFlushFlag = opts && typeof opts.finishFlush !== 'undefined' ?
    opts.finishFlush : zlib.Z_FINISH;

  /** Instance of a class which does the decoding for the detected data format.
   * @private {stream.Duplex} */
  this._decoder = null;

  /** Detectors for formats supported by this instance.
   * @private {!Array<InflateAuto.FormatDetector>}
   */
  this._detectors = null;
  if (opts && opts.detectors) {
    if (Math.floor(opts.detectors.length) !== opts.detectors.length) {
      throw new TypeError('detectors must be Array-like');
    }

    if (!Array.prototype.every.call(opts.detectors, isFunction)) {
      throw new TypeError('All detectors must be functions');
    }

    this._detectors = Array.prototype.slice.call(opts.detectors);
  } else {
    this._detectors = [
      InflateAuto.detectors.detectDeflate,
      InflateAuto.detectors.detectGzip
    ];
  }

  /** Detectors which are still plausible given previous data.
   * @private {!Array<InflateAuto.FormatDetector>}
   */
  this._detectorsLeft = this._detectors;

  /** Default format which is used if no detectors match.
   * @private {function(new:stream.Duplex, Object=)}
   */
  this._defaultFormat = null;
  if (opts && opts.defaultFormat) {
    if (typeof opts.defaultFormat !== 'function') {
      throw new TypeError('defaultFormat must be a constructor function');
    }
    this._defaultFormat = opts.defaultFormat;
  } else if (!opts || opts.defaultFormat === undefined) {
    this._defaultFormat = zlib.InflateRaw;
  }

  /** Options to pass to the format constructor when created.
   * @private {Object} */
  this._opts = opts;

  /* Invariant:
   * At most one of _decoder or _writeBuf is non-null.
   * Since writes are being forwarded or buffered.
   */
  this._writeBuf = null;

  // Behave like Zlib where close is unconditionally called on 'end'
  this.once('end', this.close);
}
inherits(InflateAuto, Transform);

/** Creates an instance of {@link InflateAuto}.
 * Analogous to {@link zlib.createInflate}.
 *
 * @param {Object=} opts Constructor options.
 */
InflateAuto.createInflateAuto = function createInflateAuto(opts) {
  return new InflateAuto(opts);
};

/**
 * Format detectors supported by default.
 * @const
 * @enum {InflateAuto.FormatDetector}
 */
InflateAuto.detectors = {
  /** Detects the ZLIB DEFLATE format, as specified in RFC 1950.
   * @param {!Buffer} chunk Chunk of data to check.
   * @return {?zlib.Inflate|undefined} <code>zlib.Inflate</code> if the data
   * conforms to RFC 1950 Section 2.2, <code>undefined</code> if the data may
   * conform, <code>null</code> if it does not conform.
   */
  detectDeflate: function detectDeflate(chunk) {
    // CM field (least-significant 4 bits) must be 8
    // FCHECK field ensures first 16-bit BE int is a multiple of 31
    if ((chunk[0] & 0x0f) === 8) {
      if (chunk.length === 1) {
        // Can't know yet whether header is valid
        return undefined;
      } else if ((chunk.readUInt16BE(0) % 31) === 0) {
        // Valid ZLIB header
        return zlib.Inflate;
      }
    }
    return null;
  },
  /** Detects the GZIP format, as specified in RFC 1952.
   * @param {!Buffer} chunk Chunk of data to check.
   * @return {?zlib.Gunzip|undefined} <code>zlib.Gunzip</code> if the data
   * conforms to RFC 1952, <code>undefined</code> if the data may conform,
   * <code>null</code> if it does not conform.
   */
  detectGzip: function detectGzip(chunk) {
    // Check for gzip header per Section 2.3.1 of RFC 1952
    if (chunk[0] === 0x1f) {
      if (chunk.length === 1) {
        // Can't know yet whether header is valid
        return undefined;
      } else if (chunk[1] === 0x8b) {
        if (chunk.length === 2) {
          // Can't know yet whether header is valid
          return undefined;
        } else if (chunk[2] === 8) {
          // Valid gzip header
          return zlib.Gunzip;
        }
      }
    }
    return null;
  }
};

/** Decompresses a compressed <code>Buffer</code>.
 * Analogous to {@link zlib.inflate}.
 *
 * @param {!Buffer} buffer Compressed data to decompress.
 * @param {Object=} opts Decompression options.
 * @param {!function(Error, Buffer=)} callback Callback which receives the
 * decompressed data.
 */
InflateAuto.inflateAuto = function inflateAuto(buffer, opts, callback) {
  if (typeof opts === 'function') {
    callback = opts;
    opts = {};
  }
  return zlibInternal.zlibBuffer(new InflateAuto(opts), buffer, callback);
};

if (zlib.inflateSync) {
  /** Decompresses a compressed Buffer synchronously.
   * Analogous to {@link zlib.inflateSync}.
   * Only defined when {@link zlib.inflateSync} is available.
   *
   * @param {!Buffer} buffer Compressed data to decompress.
   * @param {Object=} opts Decompression options.
   * @return {!Buffer} Decompressed data.
   */
  InflateAuto.inflateAutoSync = function inflateAutoSync(buffer, opts) {
    return zlibInternal.zlibBufferSync(new InflateAuto(opts), buffer);
  };
}

/** Detects the format of a given <code>Buffer</code>.
 *
 * This method passes <code>chunk</code> to each of the {@link
 * InflateAutoOptions.detectors}.  The first detector to match is returned.
 * If at least one detector is indeterminate and <code>end</code> is
 * <code>false</code>, <code>null</code> is returned.  Otherwise
 * {@link InflateAutoOptions.defaultFormat} is returned or an <code>Error</code>
 * is thrown.
 *
 * @protected
 * @param {Buffer} chunk Beginning of data for which to detect the
 * compression format.
 * @param {boolean} end Is <code>chunk</code> the end of the data stream?
 * @return {?function(new:stream.Duplex, Object=)}
 * An instance of the zlib type which will decode <code>chunk</code> and
 * subsequent data, or <code>null</code> if <code>chunk</code> is too short to
 * deduce the format conclusively and <code>end</code> is <code>false</code>.
 * @throws If any detector throws or <code>end</code> is <code>true</code> and
 * no default format is given.
 */
InflateAuto.prototype._detectFormat = function _detectFormat(chunk, end) {
  if (chunk && chunk.length > 0) {
    var detectors = this._detectorsLeft;
    var plausible = [];
    for (var i = 0; i < detectors.length; i += 1) {
      var detector = detectors[i];
      var format = detector(chunk);
      if (format) {
        return format;
      }
      if (format === undefined) {
        plausible.push(detector);
      }
    }
    this._detectorsLeft = plausible;
  }

  if (this._detectorsLeft.length === 0 || end) {
    if (this._defaultFormat) {
      return this._defaultFormat;
    }

    var err = new Error('data did not match any supported formats');
    err.data = chunk;
    throw err;
  }

  return null;
};

/** Flushes any buffered data when the stream is ending.
 *
 * @protected
 * @param {function(Error=)} callback
 */
InflateAuto.prototype._flush = function _flush(callback) {
  if (this._closed) {
    callback(new Error('zlib binding closed'));
    return;
  }

  if (!this._decoder) {
    // Previous header checks inconclusive.  Must choose one now.
    try {
      this.setFormat(this._detectFormat(this._writeBuf, true));
    } catch (err) {
      callback(err);
      return;
    }
  }

  // callback must not be called until all data has been written.
  // So call on 'end', not 'finish'.
  //
  // Note:  Not called on 'error' since errors events already forwarded
  // and should not emit 'end' after 'error'
  this._decoder.once('end', callback);

  var chunk = this._writeBuf;
  this._writeBuf = null;
  this._decoder.end(chunk);
};

if (zlib.Inflate.prototype._processChunk) {
  /** Process a chunk of data, synchronously or asynchronously.
   *
   * @protected
   * @param {!Buffer} chunk Chunk of data to write.
   * @param {number} flushFlag Flush flag with which to write the data.
   * @param {?function(Error=)=} cb Callback.  Synchronous if falsey.
   * @return {!Buffer|undefined} Decompressed chunk if synchronous, otherwise
   * <code>undefined</code>.
   * @throws If a detector or format constructor throws and <code>cb</code> is
   * not a function.
   */
  InflateAuto.prototype._processChunk = function _processChunk(chunk, flushFlag,
    cb) {
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
        // Suppress throwing for unhandled 'error' event when called without cb.
        // zlib classes emit and listen for 'error' internally (in Node 0.12)
        var errorListener;
        if (typeof cb !== 'function') {
          errorListener = function() {};
          this.on('error', errorListener);
        }

        try {
          return this._decoder._processChunk(chunk, flushFlag, cb);
        } finally {
          if (errorListener) {
            this.removeListener('error', errorListener);
          }
        }
      }

      // Fallback to _transform, where possible.
      // Only works synchronously when callback is called with data immediately.
      if (typeof this._decoder._transform === 'function') {
        var needCb = false;
        var retVal;
        if (typeof cb !== 'function') {
          needCb = true;
          cb = function(err, result) {
            if (err) {
              throw err;
            }
            retVal = result;
          };
        }
        this._decoder._transform(chunk, null, cb);
        if (!needCb || retVal) {
          return retVal;
        }
      }

      var formatName =
        (this._decoder.constructor && this._decoder.constructor.name) ||
        'format';
      throw new Error(formatName + ' does not support _processChunk');
    }

    this._writeBuf = chunk;
    process.nextTick(cb);
    return undefined;
  };
}

/** Sets the format which will be used to decode data written to this stream.
 *
 * Note:  The current implementation only allows the format to be set once.
 * Calling this method after the format has been set will throw an exception.
 *
 * @param {function(new:stream.Duplex,Object=)} Format Constructor for the
 * stream class which will be used to decode data written to this stream.
 * @throws If previously set to a different <code>Format</code> or
 * <code>Format</code> constructor throws.
 * @see #_detectFormat()
 */
InflateAuto.prototype.setFormat = function setFormat(Format) {
  var self = this;

  if (this._decoder && Format === this._decoder.constructor) {
    return;
  }

  // We would need to disconnect event handlers and close the previous
  // format to avoid leaking.  No current use case.
  if (this._decoder) {
    throw new Error('Changing format is not supported');
  }

  var format = new Format(this._opts);
  this._decoder = format;

  // Ensure .constructor is set properly by Format constructor
  if (format.constructor !== Format) {
    format.constructor = Format;
  }

  format.on('data', function(chunk) {
    self.push(chunk);
  });

  // proxy important events from the format
  // Note:  Same events as Readable.wrap except pause/unpause and close.
  ['destroy', 'error'].forEach(function(event) {
    format.on(event, self.emit.bind(self, event));
  });

  // 'close' handled specially to ensure correct order with 'end'
  this.removeListener('end', this.close);
  var endEmitted = false;
  this.once('end', function() { endEmitted = true; });
  var formatEndEmitted = false;
  format.once('end', function() { formatEndEmitted = true; });
  format.on('close', function() {
    if (formatEndEmitted && !endEmitted) {
      self.once('end', function() { self.emit('close'); });
    } else {
      self.emit('close');
    }
  });

  self.emit('format', format);

  if (this._queuedMethodCalls) {
    this._queuedMethodCalls.forEach(function(mc) {
      format[mc.name].apply(format, mc.args);
    });
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
InflateAuto.prototype._transform = function _transform(chunk, encoding,
  callback) {
  if (!this._decoder) {
    if (chunk !== null && !(chunk instanceof Buffer)) {
      callback(new Error('invalid input'));
      return;
    }

    if (this._closed) {
      callback(new Error('zlib binding closed'));
      return;
    }

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
    process.nextTick(callback);
  }
};

/** Writes data to this stream before the format has been detected, performing
 * format detection and returning the combined write buffer.
 *
 * @private
 * @param {Buffer} chunk Chunk of data to write.
 * @return {Buffer} <code>chunk</code> appended to any previously buffered
 * data.
 * @throws If a detector or format constructor throws.  In this case the data
 * will be saved in <code>_writeBuf</code>.
 */
InflateAuto.prototype._writeEarly = function _writeEarly(chunk) {
  if (chunk === null || chunk.length === 0) {
    return chunk;
  }

  var signature;
  if (this._writeBuf) {
    signature = Buffer.concat([this._writeBuf, chunk]);
  } else {
    signature = chunk;
  }

  // If _detectFormat or setFormat throw, data will be buffered
  this._writeBuf = signature;

  var Format = this._detectFormat(signature);
  if (Format) {
    this.setFormat(Format);
  }

  // Caller is responsible for writing or buffering returned data
  this._writeBuf = null;
  return signature;
};

/** Closes this stream and its underlying resources (zlib handle).
 *
 * @param {?function(Error)=} callback Callback once resources have been
 * freed.
 */
InflateAuto.prototype.close = function close(callback) {
  if (this._decoder && typeof this._decoder.close === 'function') {
    return this._decoder.close.apply(this._decoder, arguments);
  }

  if (callback) {
    process.nextTick(callback);
  }

  if (!this._closed) {
    this._closed = true;
    process.nextTick(this.emit.bind(this, 'close'));
  }

  return undefined;
};

/** Gets the constructor function used to create the decoder for data written
 * to this stream.
 *
 * @return {?function(new:stream.Duplex,Object=)} Constructor for the stream
 * class which is used to decode data written to this stream, or
 * <code>null</code> if the format has not been detected or set.
 * @see #_detectFormat()
 * @see #setFormat()
 */
InflateAuto.prototype.getFormat = function getFormat() {
  return this._decoder && this._decoder.constructor;
};

/** Flushes queued writes with a given zlib flush behavior.
 *
 * @param {number=} kind Flush behavior of writes to zlib.  Must be one of the
 * zlib flush constant values.
 * @param {?function(Error)=} callback Callback once data has been flushed.
 */
InflateAuto.prototype.flush = function flush(kind, callback) {
  if (this._decoder) {
    return this._decoder.flush.apply(this._decoder, arguments);
  }

  this._queueMethodCall('flush', arguments);
  return undefined;
};

if (zlib.Inflate.prototype.params) {
  /** Sets the inflate compression parameters.
   *
   * <p>For inflate, this has no effect.  This method is kept for compatibility
   * only.  It is only defined when {@link Inflate.prototype.params} is
   * defined.</p>
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
      return this._decoder.params.apply(this._decoder, arguments);
    }

    this._queueMethodCall('params', arguments);
    return undefined;
  };
}

/** Discards any buffered data and resets the decoder to its initial state.
 *
 * <p><b>Note:</b>  If a format has been detected, reset does not currently
 * clear the detection (for performance and to reduce complexity).  If there
 * is a real-world use case for this type of "full reset", please open an
 * issue.</p>
 */
InflateAuto.prototype.reset = function reset() {
  if (this._decoder) {
    return this._decoder.reset.apply(this._decoder, arguments);
  }

  assert(!this._closed, 'zlib binding closed');
  this._writeBuf = null;
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
 * @param {!(Arguments|Array)} args Arguments to pass to the method call.
 */
InflateAuto.prototype._queueMethodCall = function _queueMethodCall(name, args) {
  assert(!this._decoder);

  // Ideally we would let the proxied method call the callback,
  // but callers may depend on a reply before the next write.
  // So call the callback now to avoid deadlocks.
  var lastArg = args[args.length - 1];
  if (typeof lastArg === 'function') {
    args = Array.prototype.slice.call(args, 0, -1);
    process.nextTick(lastArg);
  }

  if (!this._queuedMethodCalls) {
    this._queuedMethodCalls = [];
  }
  this._queuedMethodCalls.push({name: name, args: args});
};

module.exports = InflateAuto;
