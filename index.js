/**
 * @copyright Copyright 2016 Kevin Locke <kevin@kevinlocke.name>
 * @license MIT
 */
'use strict';

const Buffer = require('buffer').Buffer;
const Transform = require('stream').Transform;
const assert = require('assert').ok;
const inherits = require('util').inherits;
const zlib = require('zlib');

/////////////////////////////////////////////////////////////////////////////
// Copied from lib/zlib.js @ v5.4.1
// FIXME: Isn't there an npm module which does this?
// get-stream is close, but only reads strings not read/write Buffers.

const kMaxLength = require('buffer').kMaxLength;
const kRangeErrorMessage = 'Cannot create final Buffer. ' +
    'It would be larger than 0x' + kMaxLength.toString(16) + ' bytes';

function zlibBuffer(engine, buffer, callback) {
  var buffers = [];
  var nread = 0;

  engine.on('error', onError);
  engine.on('end', onEnd);

  engine.end(buffer);
  flow();

  function flow() {
    var chunk;
    while (null !== (chunk = engine.read())) {
      buffers.push(chunk);
      nread += chunk.length;
    }
    engine.once('readable', flow);
  }

  function onError(err) {
    engine.removeListener('end', onEnd);
    engine.removeListener('readable', flow);
    callback(err);
  }

  function onEnd() {
    var buf;
    var err = null;

    if (nread >= kMaxLength) {
      err = new RangeError(kRangeErrorMessage);
    } else {
      buf = Buffer.concat(buffers, nread);
    }

    buffers = [];
    engine.close();
    callback(err, buf);
  }
}

function zlibBufferSync(engine, buffer) {
  if (typeof buffer === 'string')
    buffer = new Buffer(buffer);
  if (!(buffer instanceof Buffer))
    throw new TypeError('Not a string or buffer');

  var inflater = engine._chooseInflaterNow(buffer);

  var flushFlag = zlib.Z_FINISH;

  return inflater._processChunk(buffer, flushFlag);
}

/////////////////////////////////////////////////////////////////////////////

/**
 * @constructor
 * @extends stream.Transform
 * @param {Object} opts Options to pass to the zlib constructor.
 */
function InflateAuto(opts) {
  if (!(this instanceof InflateAuto)) return new InflateAuto(opts);

  Transform.call(this, opts);

  /** Whether #close() has been called.
   * @private {boolean} */
  this._closed = false;
  /** The instance of a zlib class which does the inflating for the detected
   * compression type.
   * @private {zlib.Gunzip|zlib.Inflate|zlib.InflateRaw} */
  this._inflater = null;
  /** Options to pass to the inflater when created.
   * @private {Object} */
  this._options = opts;
}
inherits(InflateAuto, Transform);

InflateAuto.createInflateAuto = function createInflateAuto(opts) {
  return new InflateAuto(opts);
};

InflateAuto.inflateAuto = function inflateAuto(buffer, opts, callback) {
  if (typeof opts === 'function') {
    callback = opts;
    opts = {};
  }
  return zlibBuffer(new InflateAuto(opts), buffer, callback);
};

InflateAuto.inflateAutoSync = function inflateAutoSync(buffer, opts) {
  return zlibBufferSync(new InflateAuto(opts), buffer);
};

/** Chooses which zlib inflater to use based on the data in a Buffer, returning
 * null when uncertain.
 *
 * This method detects the existence of a gzip or zlib header at the beginning
 * of the Buffer and returns an instance of the corresponding zlib class:
 * - If a valid gzip header is found, instance of zlib.Gunzip.
 * - If a valid zlib deflate header is found, an instance of zlib.Deflate.
 * - If a valid header of any type could be completed by more data, null.
 * - Otherwise, an instance of zlib.DeflateRaw.
 *
 * @protected
 * @param {buffer.Buffer} chunk Data from which to deduce the compression
 * type.
 * @return {zlib.Gunzip|zlib.Inflate|zlib.InflateRaw} An instance of the zlib
 * type which will inflate chunk and following data, or null if chunk is too
 * short to deduce the type conclusively.
 */
InflateAuto.prototype._chooseInflater = function _chooseInflater(chunk) {
  if (!chunk || !chunk.length) {
    // No data to determine inflater
    return null;
  }

  // Check for zlib header per Section 2.2 of RFC 1950
  // CM field (least-significant 4 bits) must be 8
  // FCHECK field ensures first 16-bit BE int is a multiple of 31
  if ((chunk[0] & 0x0f) === 8) {
    if (chunk.length === 1) {
      // Can't know yet whether header is valid
      return null;
    } else if ((chunk.readUInt16BE(0) % 31) === 0) {
      // Valid zlib header
      return new zlib.Inflate(this._options);
    }
  // Check for gzip header per Section 2.3.1 of RFC 1952
  } else if (chunk[0] === 0x1f) {
    if (chunk.length === 1) {
      // Can't know yet whether header is valid
      return null;
    } else if (chunk[1] === 0x8b) {
      if (chunk.length === 2) {
        // Can't know yet whether header is valid
        return null;
      } else if (chunk[2] === 8) {
        // Valid gzip header
        return new zlib.Gunzip(this._options);
      }
    }
  }

  // Not a valid zlib or gzip header
  return new zlib.InflateRaw(this._options);
};

/** Chooses which zlib inflater to use based on the data in a Buffer,
 * returning a default when uncertain.
 *
 * This method behaves like _chooseInflater except that if a valid header can
 * not be found, an instance of zlib.InflateRaw is returned (rather than null)
 * for use in cases where all data is present and "undecided" is not an
 * option.
 *
 * @protected
 * @param {buffer.Buffer} chunk Data from which to deduce the compression
 * type.
 * @return {!(zlib.Gunzip|zlib.Inflate|zlib.InflateRaw)} An instance of the
 * zlib type which will inflate chunk and following data.
 * @see #_chooseInflater()
 */
InflateAuto.prototype._chooseInflaterNow = function _chooseInflaterNow(chunk) {
  return this._chooseInflater(chunk) || new zlib.InflateRaw(this._options);
};

/** Flushes any buffered data when the stream is ending.
 * @protected
 * @param {?function(Error)=} callback
 */
InflateAuto.prototype._flush = function _flush(callback) {
  if (this._buffered) {
    assert(!this._inflater);

    // Have insufficient data for header checks.  Must be raw.
    this._setInflater(this._chooseInflaterNow(this._buffered));
    var chunk = this._buffered;
    delete this._buffered;
    return this._inflater.end(chunk, callback);
  }

  if (this._inflater)
    return this._inflater.end(callback);

  if (this._closed)
    return callback(new Error('zlib binding closed'));

  // No data has been written and close has not been called.  Nothing to do.
  process.nextTick(callback);
};

/** Sets the inflater class.
 *
 * @protected
 * @param {!stream.Duplex} inflater An instance of the class which will be
 * used to inflate the data.
 * @see #_chooseInflater()
 */
InflateAuto.prototype._setInflater = function _setInflater(inflater) {
  var self = this;

  // We would need to disconnect event handlers and close the previous
  // inflater to avoid leaking.  No current use case.
  assert(!this._inflater, 'changing inflater not supported');

  this._inflater = inflater;

  inflater.on('data', function(chunk) {
    self.push(chunk);
  });

  // proxy important events from the inflater
  // Note:  Same events as Readable.wrap except pause/unpause
  ['close', 'destroy', 'error'].forEach(function(event) {
    inflater.on(event, self.emit.bind(self, event));
  });

  if (this._queuedMethodCalls) {
    this._queuedMethodCalls.forEach(function(mc) {
      inflater[mc.name].apply(inflater, mc.args);
    });
    delete this._queuedMethodCalls;
  }
};

/** Deflates a chunk of data.
 *
 * @protected
 * @param {buffer.Buffer} chunk Chunk of data to deflate.
 * @param {?string} encoding Ignored.
 * @param {?function(Error)=} callback
 */
InflateAuto.prototype._transform = function _transform(chunk, encoding,
    callback) {
  if (this._inflater)
    return this._inflater.write(chunk, encoding, callback);

  if (chunk !== null && !(chunk instanceof Buffer))
    return callback(new Error('invalid input'));

  if (this._closed)
    return callback(new Error('zlib binding closed'));

  if (chunk === null || chunk.length === 0)
    return process.nextTick(callback);

  if (this._buffered) {
    chunk = Buffer.concat([this._buffered, chunk]);
    delete this._buffered;
  }

  var inflater = this._chooseInflater(chunk);
  if (!inflater) {
    this._buffered = chunk;
    return process.nextTick(callback);
  }

  this._setInflater(inflater);
  return this._inflater.write(chunk, encoding, callback);
};

/** Closes this stream and its underlying resources (zlib handle).
 *
 * @param {?function(Error)=} callback
 */
InflateAuto.prototype.close = function close(callback) {
  if (this._inflater)
    return this._inflater.close.apply(this._inflater, arguments);

  if (callback)
    process.nextTick(callback);

  if (this._closed)
    return;

  this._closed = true;
  process.nextTick(this.emit.bind(this), 'close');
};

/** Sets the type of flushing behavior of the writes to zlib.
 *
 * For inflate, this has no visible effect.  This method is kept for
 * compatibility only.
 *
 * @param {number} kind Flush behavior of writes to zlib.  Must be one of the
 * zlib flush constant values.
 * @param {?function(Error)=} callback
 */
InflateAuto.prototype.flush = function flush(kind, callback) {
  if (this._inflater)
    return this._inflater.flush.apply(this._inflater, arguments);

  this._queueMethodCall('flush', arguments);
};

/** Sets the deflate compression parameters.
 *
 * For inflate, this has no effect.  This method is kept for compatibility
 * only.
 *
 * Note: Parameter checking is not performed if the type hasn't been
 * determined.  Although this is currently possible (since parameters are
 * currently independent of type) it requires instantiating a zlib object with
 * bindings, which is heavy for checking args which haven't changed since this
 * method was added to the Node API.  If there is a use case for this, please
 * open an issue.
 *
 * @param {number} level Compression level (between zlib.Z_MIN_LEVEL and
 * zlib.Z_MAX_LEVEL).
 * @param {number} strategy Compression strategy (one of the zlib strategy
 * constant values).
 * @param {?function(Error)=} callback
 */
InflateAuto.prototype.params = function params(level, strategy, callback) {
  if (this._inflater)
    return this._inflater.params.apply(this._inflater, arguments);

  this._queueMethodCall('params', arguments);
};

/** Discards any buffered data and resets the decoder to its initial state.
 *
 * Note:  If a type has been detected, reset does not currently clear the
 * detection (for performance and to reduce unnecessary complexity).  If there
 * is a real-world use case for this type of "full reset", please open an
 * issue.
 */
InflateAuto.prototype.reset = function reset() {
  if (this._inflater)
    return this._inflater.reset.apply(this._inflater, arguments);

  assert(!this._closed, 'zlib binding closed');
  delete this._buffered;
};

/** Queues a method call for the inflater until one is set.
 *
 * In addition to queueing the method call, if the arguments includes a
 * callback function, that function is invoked immediately in order to
 * prevent deadlocks in existing code which doesn't write until the callback
 * completes.
 *
 * @protected
 * @param {string} name Name of the method to call.
 * @param {!(Arguments|Array)} args Arguments to apply to the method call.
 */
InflateAuto.prototype._queueMethodCall = function _queueMethodCall(name, args) {
  assert(!this._inflater);

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
