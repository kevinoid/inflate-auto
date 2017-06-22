/**
 * @copyright Copyright 2016-2017 Kevin Locke <kevin@kevinlocke.name>
 * @license MIT
 */

'use strict';

var BBPromise = require('bluebird');
var InflateAuto = require('..');
var assert = require('assert');
var assignOwnPropertyDescriptors =
  require('../test-lib/assign-own-property-descriptors.js');
var extend = require('extend');
var stream = require('stream');
var streamCompare = require('stream-compare');
var util = require('util');
var zlib = require('zlib');

var Promise = global.Promise || BBPromise;
var deepEqual = assert.deepStrictEqual || assert.deepEqual;

var nodeVersion = process.version.slice(1).split('.').map(Number);

// streamCompare options to read in flowing mode with exact matching of
// event data for all events listed in the API.
var COMPARE_OPTIONS = {
  compare: deepEqual,
  events: ['close', 'data', 'destroy', 'end', 'error', 'pipe'],
  readPolicy: 'none'
};

var TEST_DATA = {
  empty: new Buffer(0),
  large: new Buffer(1024),
  // 'normal' is the default for not-data-specific tests
  normal: new Buffer('uncompressed data')
};
TEST_DATA.large.fill(0);

/* eslint-disable comma-spacing */
var SUPPORTED_FORMATS = [
  {
    Compress: zlib.Gzip,
    Decompress: zlib.Gunzip,
    compress: zlib.gzip,
    compressSync: zlib.gzipSync,
    corruptChecksum: function corruptGzipChecksum(compressed) {
      var invalid = new Buffer(compressed);
      // gzip format has 4-byte CRC32 before 4-byte size at end
      invalid[invalid.length - 5] = invalid[invalid.length - 5] ^ 0x1;
      return invalid;
    },
    data: TEST_DATA,
    dataCompressed: {
      // zlib.gzipSync(data.empty)
      empty: new Buffer([31,139,8,0,0,0,0,0,0,3,3,0,0,0,0,0,0,0,0,0]),
      // zlib.gzipSync(data.large)
      large: new Buffer([31,139,8,0,0,0,0,0,0,3,99,96,24,5,163,96,20,140,84,0,
        0,46,175,181,239,0,4,0,0]),
      // zlib.gzipSync(data.normal)
      normal: new Buffer([31,139,8,0,0,0,0,0,0,3,43,205,75,206,207,45,40,74,45,
        46,78,77,81,72,73,44,73,4,0,239,231,69,217,17,0,0,0])
    },
    decompress: zlib.gunzip,
    decompressSync: zlib.gunzipSync,
    header: new Buffer([31,139,8])
  },
  {
    Compress: zlib.Deflate,
    Decompress: zlib.Inflate,
    compress: zlib.deflate,
    compressSync: zlib.deflateSync,
    corruptChecksum: function corruptZlibChecksum(compressed) {
      var invalid = new Buffer(compressed);
      // zlib format has 4-byte Adler-32 at end
      invalid[invalid.length - 1] = invalid[invalid.length - 1] ^ 0x1;
      return invalid;
    },
    data: TEST_DATA,
    dataCompressed: {
      // zlib.deflateSync(data.empty)
      empty: new Buffer([120,156,3,0,0,0,0,1]),
      // zlib.deflateSync(data.large)
      large: new Buffer([120,156,99,96,24,5,163,96,20,140,84,0,0,4,0,0,1]),
      // zlib.deflateSync(data.normal)
      normal: new Buffer([120,156,43,205,75,206,207,45,40,74,45,46,78,77,81,72,
        73,44,73,4,0,63,144,6,211]),
      // zlib.deflateSync(data.normal, {dictionary: data.normal})
      normalWithDict:
        new Buffer([120,187,63,144,6,211,43,69,23,0,0,63,144,6,211])
    },
    decompress: zlib.inflate,
    decompressSync: zlib.inflateSync,
    header: new Buffer([120,156])
  },
  {
    Compress: zlib.DeflateRaw,
    Decompress: zlib.InflateRaw,
    compress: zlib.deflateRaw,
    compressSync: zlib.deflateRawSync,
    data: TEST_DATA,
    dataCompressed: {
      // zlib.deflateRawSync(data.empty)
      empty: new Buffer([3,0]),
      // zlib.deflateRawSync(data.large)
      large: new Buffer([99,96,24,5,163,96,20,140,84,0,0]),
      // zlib.deflateRawSync(data.normal)
      normal: new Buffer([43,205,75,206,207,45,40,74,45,46,78,77,81,72,73,44,
        73,4,0]),
      // zlib.deflateRawSync(data.normal, {dictionary: data.normal})
      normalWithDict: new Buffer([43,69,23,0,0])
    },
    decompress: zlib.inflateRaw,
    decompressSync: zlib.inflateRawSync,
    header: new Buffer(0),
    isDefault: true
  }
];
/* eslint-enable comma-spacing */

function assertInstanceOf(obj, ctor) {
  if (!(obj instanceof ctor)) {
    assert.fail(
      obj,
      ctor,
      null,
      'instanceof'
    );
  }
}

/** Make an Error object with the same properties as a given object. */
function makeError(source) {
  if (Object.getPrototypeOf(source) === Error.prototype) {
    return source;
  }
  var error = new Error(source.message);
  assignOwnPropertyDescriptors(error, source);
  return error;
}

/** Compares StreamStates ignoring the prototype of Error events. */
function compareNoErrorTypes(actualState, expectedState) {
  var actual = extend({}, actualState);
  var expected = extend({}, expectedState);

  function normalizeEvent(event) {
    if (event.name === 'error') {
      var normEvent = extend({}, event);
      normEvent.args = normEvent.args.map(makeError);
      return normEvent;
    }

    return event;
  }
  actual.events = actual.events.map(normalizeEvent);
  expected.events = expected.events.map(normalizeEvent);

  deepEqual(actual, expected);
}

/** Defines tests which are run for a given format. */
function defineFormatTests(format) {
  var emptyCompressed = format.dataCompressed.empty;
  var largeCompressed = format.dataCompressed.large;

  // Data with a different header than the expected one
  var otherCompressed, otherHeader;
  if (format === SUPPORTED_FORMATS[0]) {
    otherCompressed = SUPPORTED_FORMATS[1].dataCompressed.normal;
    otherHeader = SUPPORTED_FORMATS[1].header;
  } else {
    otherCompressed = SUPPORTED_FORMATS[0].dataCompressed.normal;
    otherHeader = SUPPORTED_FORMATS[0].header;
  }

  var compressed = format.dataCompressed.normal;
  var uncompressed = format.data.normal;

  var Decompress = format.Decompress;
  var compress = format.compress;
  var corruptChecksum = format.corruptChecksum;
  var decompress = format.decompress;
  var decompressSync = format.decompressSync;
  var isDefaultFormat = format.isDefault;
  var header = format.header;
  var headerLen = header.length;

  describe('.inflateAuto', function() {
    it('decompresses all data in a single call', function(done) {
      decompress(compressed, function(errDecompress, dataDecompress) {
        assert.ifError(errDecompress);
        InflateAuto.inflateAuto(compressed, function(errAuto, dataAuto) {
          assert.ifError(errAuto);
          deepEqual(dataAuto, dataDecompress);
          done();
        });
      });
    });

    it('can accept options argument', function(done) {
      var opts = {chunkSize: zlib.Z_MIN_CHUNK};
      InflateAuto.inflateAuto(compressed, opts, function(errAuto, dataAuto) {
        assert.ifError(errAuto);

        // Node 0.10 does not support opts
        if (decompress.length < 3) {
          done();
          return;
        }

        decompress(compressed, opts, function(errDecompress, dataDecompress) {
          assert.ifError(errDecompress);
          deepEqual(dataAuto, dataDecompress);
          done();
        });
      });
    });

    it('can use PassThrough as defaultFormat', function(done) {
      var opts = {defaultFormat: stream.PassThrough};
      InflateAuto.inflateAuto(uncompressed, opts, function(errAuto, dataAuto) {
        assert.ifError(errAuto);
        deepEqual(dataAuto, uncompressed);
        done();
      });
    });

    it('passes format Error to the callback', function(done) {
      var zeros = new Buffer(20);
      zeros.fill(0);
      decompress(zeros, function(errDecompress, dataDecompress) {
        assert(errDecompress, 'expected Error to test');
        InflateAuto.inflateAuto(zeros, function(errAuto, dataAuto) {
          deepEqual(errAuto, errDecompress);
          deepEqual(dataAuto, dataDecompress);
          done();
        });
      });
    });

    if (isDefaultFormat) {
      it('handles truncated header like zlib', function(done) {
        var trunc = compressed.slice(0, 1);
        decompress(trunc, function(errDecompress, dataDecompress) {
          InflateAuto.inflateAuto(trunc, function(errAuto, dataAuto) {
            deepEqual(errAuto, errDecompress);
            deepEqual(dataAuto, dataDecompress);
            done();
          });
        });
      });
    }

    it('handles string argument like zlib', function(done) {
      var compressedStr = compressed.toString('binary');
      decompress(compressedStr, function(errDecompress, dataDecompress) {
        InflateAuto.inflateAuto(compressedStr, function(errAuto, dataAuto) {
          deepEqual(errAuto, errDecompress);
          deepEqual(dataAuto, dataDecompress);
          done();
        });
      });
    });
  });

  if (decompressSync) {
    it('as synchronous function', function() {
      var dataDecompress = decompressSync(compressed);
      var dataAuto = InflateAuto.inflateAutoSync(compressed);
      deepEqual(dataAuto, dataDecompress);
    });
  }

  it('single-write with immediate end', function() {
    var zlibStream = new Decompress();
    var inflateAuto = new InflateAuto();
    var result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);
    result.checkpoint();
    zlibStream.end(compressed);
    inflateAuto.end(compressed);
    result.checkpoint();
    return result;
  });

  it('single-write delayed end', function() {
    var zlibStream = new Decompress();
    var inflateAuto = new InflateAuto();
    var result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);

    var zlibWriteP = BBPromise.promisify(zlibStream.write);
    var autoWriteP = BBPromise.promisify(inflateAuto.write);

    return Promise.all([
      zlibWriteP.call(zlibStream, compressed),
      autoWriteP.call(inflateAuto, compressed)
    ]).then(function() {
      result.checkpoint();
      zlibStream.end();
      inflateAuto.end();
      result.checkpoint();

      return result;
    });
  });

  [1, 2, 3].forEach(function(blockSize) {
    it(blockSize + ' byte writes', function() {
      var zlibStream = new Decompress();
      var inflateAuto = new InflateAuto();
      var result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);

      for (var i = 0; i < compressed.length; i += 1) {
        var block = compressed.slice(i * blockSize, (i + 1) * blockSize);
        zlibStream.write(block);
        inflateAuto.write(block);
        result.checkpoint();
      }

      zlibStream.end();
      inflateAuto.end();
      result.checkpoint();

      return result;
    });
  });

  if (isDefaultFormat) {
    it('no writes', function() {
      var zlibStream = new Decompress();
      var inflateAuto = new InflateAuto();
      var result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);
      zlibStream.end();
      inflateAuto.end();
      result.checkpoint();
      return result;
    });
  }

  it('no data after header', function() {
    var zlibStream = new Decompress();
    var inflateAuto = new InflateAuto();
    var result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);
    zlibStream.end(header);
    inflateAuto.end(header);
    result.checkpoint();
    return result;
  });

  if (isDefaultFormat) {
    SUPPORTED_FORMATS.forEach(function(supportedFormat) {
      var formatName = supportedFormat.Compress.name;
      var formatHeader = supportedFormat.header;
      var formatHeaderLen = formatHeader.length;

      function testPartialHeader(len) {
        it(len + ' bytes of ' + formatName + ' header', function() {
          var zlibStream = new Decompress();
          var inflateAuto = new InflateAuto();
          var result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);
          var partial = formatHeader.slice(0, len);
          zlibStream.end(partial);
          inflateAuto.end(partial);
          result.checkpoint();
          return result;
        });
      }
      for (var i = 1; i < formatHeaderLen; i += 1) {
        testPartialHeader(i);
      }
    });
  }

  it('compressed empty data', function() {
    var zlibStream = new Decompress();
    var inflateAuto = new InflateAuto();
    var result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);
    zlibStream.end(emptyCompressed);
    inflateAuto.end(emptyCompressed);
    result.checkpoint();
    return result;
  });

  // This behavior changed in node v5 and later due to
  // https://github.com/nodejs/node/pull/2595
  it('handles truncated compressed data', function() {
    // Truncate shortly after the header (if any) for type detection
    var truncated = compressed.slice(0, headerLen + 1);
    var zlibStream = new Decompress();
    var inflateAuto = new InflateAuto();
    var result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);
    zlibStream.end(truncated);
    inflateAuto.end(truncated);
    result.checkpoint();
    return result;
  });

  // This behavior changed in node v6 and later due to
  // https://github.com/nodejs/node/pull/5120
  it('handles concatenated compressed data', function() {
    var doubledata = Buffer.concat([compressed, compressed]);
    var zlibStream = new Decompress();
    var inflateAuto = new InflateAuto();
    var result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);
    zlibStream.end(doubledata);
    inflateAuto.end(doubledata);
    result.checkpoint();
    return result;
  });

  it('handles concatenated empty compressed data', function() {
    var doubleempty = Buffer.concat([emptyCompressed, emptyCompressed]);
    var zlibStream = new Decompress();
    var inflateAuto = new InflateAuto();
    var result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);
    zlibStream.end(doubleempty);
    inflateAuto.end(doubleempty);
    result.checkpoint();
    return result;
  });

  it('handles concatenated 0', function() {
    var zeros = new Buffer(20);
    zeros.fill(0);
    var compressedWithZeros = Buffer.concat([compressed, zeros]);
    var zlibStream = new Decompress();
    var inflateAuto = new InflateAuto();
    var result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);
    zlibStream.end(compressedWithZeros);
    inflateAuto.end(compressedWithZeros);
    result.checkpoint();
    return result;
  });

  it('handles concatenated garbage', function() {
    var garbage = new Buffer(20);
    garbage.fill(42);
    var compressedWithGarbage = Buffer.concat([compressed, garbage]);
    var zlibStream = new Decompress();
    var inflateAuto = new InflateAuto();
    var result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);
    zlibStream.end(compressedWithGarbage);
    inflateAuto.end(compressedWithGarbage);
    result.checkpoint();
    return result;
  });

  it('handles corrupted compressed data', function() {
    var corrupted = new Buffer(compressed);
    // Leave signature intact
    corrupted.fill(42, headerLen);
    var zlibStream = new Decompress();
    var inflateAuto = new InflateAuto();
    var result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);
    zlibStream.end(corrupted);
    inflateAuto.end(corrupted);
    result.checkpoint();
    return result;
  });

  if (corruptChecksum) {
    it('corrupted checksum', function() {
      var zlibStream = new zlib.Inflate();
      var inflateAuto = new InflateAuto();
      var result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);
      var invalid = corruptChecksum(compressed);
      zlibStream.end(invalid);
      inflateAuto.end(invalid);
      result.checkpoint();
      return result;
    });
  }

  var compressedWithDict = format.dataCompressed.normalWithDict;
  if (compressedWithDict && compress.length === 3) {
    it('handles dictionary', function() {
      var options = {dictionary: uncompressed};
      var zlibStream = new Decompress(options);
      var inflateAuto = new InflateAuto(options);
      var result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);
      zlibStream.end(compressedWithDict);
      inflateAuto.end(compressedWithDict);
      result.checkpoint();
      return result;
    });

    it('handles missing dictionary', function() {
      var zlibStream = new Decompress();
      var inflateAuto = new InflateAuto();
      var result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);
      zlibStream.end(compressedWithDict);
      inflateAuto.end(compressedWithDict);
      result.checkpoint();
      return result;
    });
  }

  if (!isDefaultFormat) {
    it('emits error for format error in _flush', function(done) {
      var inflateAuto = new InflateAuto({defaultFormat: null});
      var truncated = compressed.slice(0, 1);
      inflateAuto.on('error', function(err) {
        assert(err, 'expected format error');
        assert(/format/i.test(err.message));
        deepEqual(err.data, truncated);
        done();
      });
      inflateAuto.end(truncated);
    });
  }

  // For objectMode: true validation is done in _transform.  Check we match.
  it('errors on write of invalid type', function() {
    var options = {objectMode: true};
    var zlibStream = new Decompress(options);
    var inflateAuto = new InflateAuto(options);
    var compareOptions = extend({}, COMPARE_OPTIONS);
    compareOptions.endEvents = ['end'];

    // nodejs/node@b514bd231 (Node 8) changed Error to TypeError.
    if (nodeVersion[0] < 8) {
      compareOptions.compare = compareNoErrorTypes;
    }

    var result = streamCompare(inflateAuto, zlibStream, compareOptions);
    zlibStream.write(true);
    inflateAuto.write(true);
    zlibStream.end(compressed);
    inflateAuto.end(compressed);
    result.checkpoint();
    return result;
  });

  if (zlib.inflateSync) {
    describe('.inflateAutoSync()', function() {
      it('invalid type synchronously', function() {
        var errInflate;
        try {
          decompressSync(true);
        } catch (err) {
          errInflate = err;
        }

        var errAuto;
        try {
          InflateAuto.inflateAutoSync(true);
        } catch (err) {
          errAuto = err;
        }

        deepEqual(errAuto, errInflate);
      });

      if (isDefaultFormat) {
        SUPPORTED_FORMATS.forEach(function(supportedFormat) {
          var formatName = supportedFormat.Compress.name;
          var formatHeader = supportedFormat.header;
          if (formatHeader.length <= 1) {
            return;
          }

          it('partial ' + formatName + ' header', function() {
            var partial = formatHeader.slice(0, 1);

            var dataInflate, errInflate;
            try {
              dataInflate = decompressSync(partial);
            } catch (err) {
              errInflate = err;
            }

            var dataAuto, errAuto;
            try {
              dataAuto = InflateAuto.inflateAutoSync(partial);
            } catch (err) {
              errAuto = err;
            }

            deepEqual(errAuto, errInflate);
            deepEqual(dataAuto, dataInflate);
          });
        });
      }

      it('can use PassThrough as defaultFormat', function() {
        var opts = {defaultFormat: stream.PassThrough};
        var dataAuto = InflateAuto.inflateAutoSync(uncompressed, opts);
        deepEqual(dataAuto, uncompressed);
      });

      it('handles string argument like zlib', function() {
        var compressedStr = compressed.toString('binary');

        var dataInflate, errInflate;
        try {
          dataInflate = decompressSync(compressedStr);
        } catch (err) {
          errInflate = err;
        }

        var dataAuto, errAuto;
        try {
          dataAuto = InflateAuto.inflateAutoSync(compressedStr);
        } catch (err) {
          errAuto = err;
        }

        deepEqual(errAuto, errInflate);
        deepEqual(dataAuto, dataInflate);
      });
    });
  }

  describe('Constructor', function() {
    describe('validation', function() {
      function checkOptions(stricter, options) {
        var descPrefix = stricter ? 'is stricter for ' : 'same for ';
        it(descPrefix + util.inspect(options), function() {
          var errInflate;
          // eslint-disable-next-line no-new
          try { new Decompress(options); } catch (err) { errInflate = err; }

          var errAuto;
          // eslint-disable-next-line no-new
          try { new InflateAuto(options); } catch (err) { errAuto = err; }

          // Convert to generic Error for pre-nodejs/node@b514bd231
          if (nodeVersion[0] < 8 &&
              errAuto &&
              errInflate &&
              Object.getPrototypeOf(errAuto) !==
                Object.getPrototypeOf(errInflate)) {
            errAuto = makeError(errAuto);
          }

          if (stricter) {
            // InflateAuto throws an Error while Decompress does not
            assert.ok(errAuto);
            assert.ifError(errInflate);
          } else if (errInflate) {
            deepEqual(errAuto, errInflate);
          }
        });
      }

      [
        null,
        true,
        {chunkSize: zlib.Z_MAX_CHUNK + 1},
        {chunkSize: zlib.Z_MAX_CHUNK},
        {chunkSize: zlib.Z_MIN_CHUNK - 1},
        {chunkSize: zlib.Z_MIN_CHUNK},
        {chunkSize: Infinity},
        {chunkSize: NaN},
        {dictionary: []},
        {dictionary: true},
        {finishFlush: 0},
        {finishFlush: zlib.Z_FULL_FLUSH},
        {finishFlush: NaN},
        {flush: 0},
        {flush: -1},
        {flush: Infinity},
        {flush: String(zlib.Z_FULL_FLUSH)},
        {flush: zlib.Z_FULL_FLUSH},
        {level: 0},
        {level: zlib.Z_MAX_LEVEL + 1},
        {level: zlib.Z_MAX_LEVEL},
        {level: zlib.Z_MIN_LEVEL - 1},
        {level: zlib.Z_MIN_LEVEL},
        {level: Infinity},
        {level: NaN},
        {memLevel: zlib.Z_MAX_MEMLEVEL + 1},
        {memLevel: zlib.Z_MAX_MEMLEVEL},
        {memLevel: zlib.Z_MIN_MEMLEVEL},
        {memLevel: Infinity},
        {memLevel: NaN},
        {strategy: 0},
        {strategy: -1},
        {strategy: zlib.Z_FILTERED},
        {strategy: Infinity},
        {strategy: NaN},
        {strategy: String(zlib.Z_FILTERED)},
        {windowBits: zlib.Z_MAX_WINDOWBITS + 1},
        {windowBits: zlib.Z_MAX_WINDOWBITS},
        {windowBits: zlib.Z_MIN_WINDOWBITS - 1},
        {windowBits: zlib.Z_MIN_WINDOWBITS},
        {windowBits: Infinity},
        {windowBits: NaN}
      ].forEach(checkOptions.bind(null, false));

      // finishFlush added in nodejs/node@97816679 (Node 7)
      // backported in nodejs/node@5f11b5369 (Node 6)
      [
        {finishFlush: -1},
        {finishFlush: Infinity},
        {finishFlush: String(zlib.Z_FULL_FLUSH)}
      ].forEach(checkOptions.bind(null, nodeVersion[0] < 6));

      // Checking falsey values changed in nodejs/node@efae43f0ee2 (Node 8)
      [
        {chunkSize: 0},
        {chunkSize: false},
        {dictionary: 0},
        {dictionary: false},
        {finishFlush: false},
        {flush: false},
        {level: false},
        {memLevel: 0},
        {memLevel: false},
        {strategy: false},
        {windowBits: 0},
        {windowBits: false}
      ].forEach(checkOptions.bind(null, nodeVersion[0] < 8));

      // Checking for zero, NaN, Infinity, and strict types changed in
      // nodejs/node@add4b0ab8cc (Node 8.2.0)
      [
        {level: String(zlib.Z_MIN_LEVEL)},
        {memLevel: String(zlib.Z_MIN_MEMLEVEL)},
        {windowBits: String(zlib.Z_MIN_WINDOWBITS)}
      ].forEach(checkOptions.bind(
        null,
        nodeVersion[0] < 8 || (nodeVersion[0] === 8 && nodeVersion[1] < 2)
      ));
    });

    var stringChunkOpts = {chunkSize: String(zlib.Z_MIN_CHUNK)};
    it('throws for ' + util.inspect(stringChunkOpts), function() {
      var errInflate;
      // eslint-disable-next-line no-new
      try { new Decompress(stringChunkOpts); } catch (err) { errInflate = err; }

      var errAuto;
      // eslint-disable-next-line no-new
      try { new InflateAuto(stringChunkOpts); } catch (err) { errAuto = err; }

      // Checking changed in nodejs/node@add4b0ab8cc (Node 8.2.0) to throw
      // RangeError in Zlib instead of TypeError in Buffer.
      if (nodeVersion[0] < 8 || (nodeVersion[0] === 8 && nodeVersion[1] < 2)) {
        assert.ok(errAuto);
        assert.ok(errInflate);
      } else {
        deepEqual(errAuto, errInflate);
      }
    });

    it('supports chunkSize', function() {
      var options = {chunkSize: zlib.Z_MIN_CHUNK};
      var zlibStream = new Decompress(options);
      var inflateAuto = new InflateAuto(options);
      var result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);
      zlibStream.end(largeCompressed);
      inflateAuto.end(largeCompressed);
      return result;
    });

    it('supports finishFlush', function() {
      var options = {finishFlush: zlib.Z_SYNC_FLUSH};
      var zlibStream = new Decompress(options);
      var inflateAuto = new InflateAuto(options);
      var result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);
      var truncated = largeCompressed.slice(0, -1);
      zlibStream.end(truncated);
      inflateAuto.end(truncated);
      return result;
    });
  });

  describe('#close()', function() {
    it('without writing', function() {
      var zlibStream = new Decompress();
      var inflateAuto = new InflateAuto();
      var result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);
      return new Promise(function(resolve, reject) {
        zlibStream.close(function() {
          var zlibArgs = arguments;
          inflateAuto.close(function() {
            var inflateArgs = arguments;
            deepEqual(inflateArgs, zlibArgs);

            setImmediate(function() {
              result.end();
              resolve(result);
            });
          });
        });
      });
    });

    // Zlib behavior changed in 8b43d3f5 (6.0.0) to emit on every call.
    // InflateAuto implements the earlier behavior.
    it('emits once for multiple calls', function() {
      var inflateAuto = new InflateAuto();

      var closeEmitted = false;
      inflateAuto.on('close', function() {
        assert.strictEqual(closeEmitted, false);
        closeEmitted = true;
      });

      inflateAuto.once('close', function() {
        inflateAuto.close();
      });

      inflateAuto.close();
      inflateAuto.close();

      return new Promise(function(resolve, reject) {
        setImmediate(function() {
          assert.strictEqual(closeEmitted, true);
          resolve();
        });
      });
    });

    it('before #end()', function() {
      var zlibStream = new zlib.Inflate();
      var inflateAuto = new InflateAuto();
      var result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);

      zlibStream.close();
      inflateAuto.close();
      result.checkpoint();

      zlibStream.end();
      inflateAuto.end();
      result.checkpoint();

      return result;
    });

    it('#reset() after #close()', function() {
      var zlibStream = new zlib.Inflate();
      var inflateAuto = new InflateAuto();
      var result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);

      zlibStream.close();
      inflateAuto.close();
      result.checkpoint();

      var errInflate;
      try { zlibStream.reset(); } catch (err) { errInflate = err; }
      var errAuto;
      try { inflateAuto.reset(); } catch (err) { errAuto = err; }

      // nodejs/node@6441556 (v6.2.1) changed the assertion to check _handle
      // which is null rather than false in this case.  It's not worth
      // complicating the code to mimic this.  Ignore the difference
      if (errInflate) {
        errInflate.actual = false;
      }

      deepEqual(errAuto, errInflate);

      result.end();
      return result;
    });

    it('#write() after #close()', function() {
      var zlibStream = new zlib.Inflate();
      var inflateAuto = new InflateAuto();
      var result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);
      zlibStream.close();
      inflateAuto.close();
      result.checkpoint();

      return new Promise(function(resolve, reject) {
        var writeArgs = [];
        function onWrite() {
          writeArgs.push(arguments);
          if (writeArgs.length === 2) {
            deepEqual(writeArgs[0], writeArgs[1]);
            result.end();
            resolve(result);
          }
        }

        zlibStream.write(new Buffer(0), onWrite);
        inflateAuto.write(new Buffer(0), onWrite);
        result.checkpoint();
      });
    });
  });

  describe('#getFormat()', function() {
    it('returns format set by #setFormat()', function() {
      var inflateAuto = new InflateAuto();
      inflateAuto.setFormat(Decompress);
      assert.strictEqual(inflateAuto.getFormat(), Decompress);
    });

    function MyDecompress() {
      Decompress.apply(this, arguments);
    }
    // Note:  MyDecompress.prototype.constructor intentionally not set
    MyDecompress.prototype = Object.create(Decompress.prototype);

    it('returns custom format set by #setFormat()', function() {
      var inflateAuto = new InflateAuto();
      inflateAuto.setFormat(MyDecompress);
      assert.strictEqual(inflateAuto.getFormat(), MyDecompress);
    });

    it('returns the detected format', function(done) {
      var inflateAuto = new InflateAuto();
      inflateAuto.on('format', function() {
        assert.strictEqual(inflateAuto.getFormat(), Decompress);
        done();
      });
      inflateAuto.write(compressed);
    });
  });

  describe('#flush()', function() {
    it('before write', function() {
      var zlibStream = new Decompress();
      var inflateAuto = new InflateAuto();
      var result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);
      zlibStream.flush();
      inflateAuto.flush();
      result.checkpoint();

      zlibStream.end(compressed);
      inflateAuto.end(compressed);
      result.checkpoint();

      return result;
    });

    // This behavior changed in node v5 and later due to
    // https://github.com/nodejs/node/pull/2595
    it('Z_FINISH before write', function() {
      var zlibStream = new Decompress();
      var inflateAuto = new InflateAuto();
      var result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);
      zlibStream.flush(zlib.Z_FINISH);
      inflateAuto.flush(zlib.Z_FINISH);
      result.checkpoint();

      zlibStream.end(compressed);
      inflateAuto.end(compressed);
      result.checkpoint();

      return result;
    });

    it('between writes', function() {
      var zlibStream = new Decompress();
      var inflateAuto = new InflateAuto();
      var result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);
      zlibStream.write(compressed.slice(0, 4));
      inflateAuto.write(compressed.slice(0, 4));
      result.checkpoint();

      zlibStream.flush();
      inflateAuto.flush();
      result.checkpoint();

      zlibStream.end(compressed.slice(4));
      inflateAuto.end(compressed.slice(4));
      result.checkpoint();

      return result;
    });

    // This behavior changed in node v5 and later due to
    // https://github.com/nodejs/node/pull/2595
    it('Z_FINISH between writes', function() {
      var zlibStream = new Decompress();
      var inflateAuto = new InflateAuto();
      var result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);
      zlibStream.write(compressed.slice(0, 4));
      inflateAuto.write(compressed.slice(0, 4));
      result.checkpoint();

      zlibStream.flush(zlib.Z_FINISH);
      inflateAuto.flush(zlib.Z_FINISH);
      result.checkpoint();

      zlibStream.end(compressed.slice(4));
      inflateAuto.end(compressed.slice(4));
      result.checkpoint();

      return result;
    });
  });

  describe('#params()', function() {
    // existence check
    it('has the same type', function() {
      var autoType = typeof InflateAuto.prototype.params;
      var zlibType = typeof Decompress.prototype.params;
      assert.strictEqual(autoType, zlibType);

      autoType = typeof new InflateAuto().params;
      zlibType = typeof new Decompress().params;
      assert.strictEqual(autoType, zlibType);
    });

    if (!Decompress.prototype.params) {
      return;
    }

    // Note:  Params have no effect on inflate, but calling .params() has
    // effects due to 0-byte Z_FINISH flush call.

    // FIXME: Calling .params() immediately before or after .write()/.end()
    // can have differing behavior between InflateAuto and Zlib because the
    // write queue is held in Zlib and because Zlib._transform() cheats and
    // checks ._writableState and sets Z_FINISH before ._flush() is called.
    // So .write(chunk) .end() has different behavior from .end(chunk) when
    // the write is buffered. (e.g. .params() .end(chunk)).
    //
    // This appears as "unexpected end of file" error when .end() is called
    // immediately after .params() due to Z_FINISH flush type being set on
    // empty write.
    //
    // This can't be fixed without abusing stream.Transform (e.g. by calling
    // _decoder.end() from this.end() before this._flush()).  Since this is
    // an edge case without known use cases, delay this risky fix for now.

    it('before write', function() {
      var zlibStream = new Decompress();
      var inflateAuto = new InflateAuto();
      var result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);

      var level = zlib.Z_BEST_COMPRESSION;
      var strategy = zlib.Z_FILTERED;
      zlibStream.params(level, strategy, function(err) {
        assert.ifError(err);
        zlibStream.end(compressed);
      });
      inflateAuto.params(level, strategy, function(err) {
        assert.ifError(err);
        inflateAuto.end(compressed);
      });
      result.checkpoint();

      return result;
    });

    it('between writes', function() {
      var zlibStream = new Decompress();
      var inflateAuto = new InflateAuto();
      var result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);

      var zlibWriteP = BBPromise.promisify(zlibStream.write);
      var autoWriteP = BBPromise.promisify(inflateAuto.write);

      var partial = compressed.slice(0, 4);
      return Promise.all([
        zlibWriteP.call(zlibStream, partial),
        autoWriteP.call(inflateAuto, partial)
      ]).then(function() {
        result.checkpoint();

        var remainder = compressed.slice(4);

        zlibStream.params(
          zlib.Z_BEST_COMPRESSION,
          zlib.Z_FILTERED,
          function(err) {
            assert.ifError(err);
            zlibStream.end(remainder);
          }
        );
        inflateAuto.params(
          zlib.Z_BEST_COMPRESSION,
          zlib.Z_FILTERED,
          function(err) {
            assert.ifError(err);
            inflateAuto.end(remainder);
          }
        );
        result.checkpoint();

        return result;
      });
    });

    // Zlib causes uncaughtException for params after close, so skip testing
    // after end.

    // Note:  Argument errors behavior is not guaranteed.  See method
    // comment for details.
  });

  describe('#reset()', function() {
    it('before write', function() {
      var zlibStream = new Decompress();
      var inflateAuto = new InflateAuto();
      var result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);

      zlibStream.reset();
      inflateAuto.reset();
      result.checkpoint();

      zlibStream.end(compressed);
      inflateAuto.end(compressed);
      result.checkpoint();

      return result;
    });

    if (headerLen > 0) {
      it('discards partial header', function() {
        var zlibStream = new Decompress();
        var inflateAuto = new InflateAuto();
        var result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);

        var dataAuto = [];
        inflateAuto.on('data', function(data) {
          dataAuto.push(data);
        });

        var zlibWriteP = BBPromise.promisify(zlibStream.write);
        var autoWriteP = BBPromise.promisify(inflateAuto.write);

        var partial = compressed.slice(0, 1);
        return Promise.all([
          zlibWriteP.call(zlibStream, partial),
          autoWriteP.call(inflateAuto, partial)
        ]).then(function() {
          result.checkpoint();

          // IMPORTANT:  Can't call Zlib.reset() with write in progress
          // Since write is run from uv work queue thread and reset from main
          zlibStream.reset();
          inflateAuto.reset();
          result.checkpoint();

          zlibStream.end(compressed);
          inflateAuto.end(compressed);
          result.checkpoint();

          // Gunzip gained reset in v6.0.0
          // https://github.com/nodejs/node/commit/f380db23
          // If zlib stream emits a header error, test for success instead of ==
          return new Promise(function(resolve, reject) {
            var headerError = false;
            zlibStream.once('error', function(err) {
              if (err.message === 'incorrect header check') {
                headerError = true;
                // Comparison result ignored.  Suppress unhandled rejection.
                result.catch(function(errResult) {});
              }
            });
            zlibStream.once('end', function() {
              resolve(result);
            });

            inflateAuto.once('end', function() {
              deepEqual(Buffer.concat(dataAuto), uncompressed);
              if (headerError) {
                resolve();
              }
            });
          });
        });
      });

      it('forgets partial header', function() {
        var zlibStream = new Decompress();
        var inflateAuto = new InflateAuto();
        var result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);

        // Note:  Only write to inflateAuto since zlib stream could error on
        // first byte due to invalid header.
        var autoWriteP = BBPromise.promisify(inflateAuto.write);

        // Write data with a different header before reset to check that reset
        // clears any partial-header state.
        return autoWriteP.call(inflateAuto, otherCompressed.slice(0, 1))
          .then(function() {
            // IMPORTANT:  Can't call Zlib.reset() with write in progress
            // Since write is run from uv work queue thread and reset from main
            zlibStream.reset();
            inflateAuto.reset();
            result.checkpoint();

            zlibStream.end(compressed);
            inflateAuto.end(compressed);
            result.checkpoint();

            return result;
          });
      });
    }

    it('discards post-header data', function() {
      var zlibStream = new Decompress();
      var inflateAuto = new InflateAuto();
      var result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);

      var zlibWriteP = BBPromise.promisify(zlibStream.write);
      var autoWriteP = BBPromise.promisify(inflateAuto.write);

      var partial = compressed.slice(0, headerLen + 1);
      return Promise.all([
        zlibWriteP.call(zlibStream, partial),
        autoWriteP.call(inflateAuto, partial)
      ]).then(function() {
        result.checkpoint();

        // IMPORTANT:  Can't call Zlib.reset() with write in progress
        // Since write is run from uv work queue thread and reset from main
        zlibStream.reset();
        inflateAuto.reset();
        result.checkpoint();

        zlibStream.end(compressed);
        inflateAuto.end(compressed);
        result.checkpoint();

        return result;
      });
    });

    // Note:  Behavior on compression type change after reset is not
    // guaranteed.  See method comment for details.
  });

  describe('#setEncoding()', function() {
    it('behaves the same before writes', function() {
      var zlibStream = new Decompress();
      var inflateAuto = new InflateAuto();
      var result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);

      zlibStream.setEncoding('utf8');
      inflateAuto.setEncoding('utf8');
      result.checkpoint();

      zlibStream.end(compressed);
      inflateAuto.end(compressed);
      result.checkpoint();

      return result;
    });

    it('behaves the same after format', function() {
      var zlibStream = new Decompress();
      var inflateAuto = new InflateAuto();
      var result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);

      var zlibWriteP = BBPromise.promisify(zlibStream.write);
      var autoWriteP = BBPromise.promisify(inflateAuto.write);

      var chunk = compressed.slice(0, headerLen + 4);
      return Promise.all([
        zlibWriteP.call(zlibStream, chunk),
        autoWriteP.call(inflateAuto, chunk)
      ]).then(function() {
        result.checkpoint();

        zlibStream.setEncoding('utf8');
        inflateAuto.setEncoding('utf8');
        result.checkpoint();

        var rest = compressed.slice(chunk.length);
        zlibStream.end(rest);
        inflateAuto.end(rest);
        result.checkpoint();

        return result;
      });
    });
  });

  describe('#setFormat()', function() {
    it('emits \'format\' event with decoder', function() {
      var inflateAuto = new InflateAuto();
      var gotFormat = false;
      inflateAuto.on('format', function(decoder) {
        assert(decoder instanceof Decompress);
        gotFormat = true;
      });
      inflateAuto.setFormat(Decompress);
      assert.strictEqual(gotFormat, true);
    });

    it('can set correct format before write', function() {
      var zlibStream = new Decompress();
      var inflateAuto = new InflateAuto();
      var result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);
      inflateAuto.setFormat(Decompress);
      result.checkpoint();
      zlibStream.end(compressed);
      inflateAuto.end(compressed);
      result.checkpoint();
      return result;
    });

    it('can set incorrect format before write', function() {
      var zlibStream = new Decompress();
      var inflateAuto = new InflateAuto();
      var result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);
      inflateAuto.setFormat(Decompress);
      result.checkpoint();
      zlibStream.end(otherCompressed);
      inflateAuto.end(otherCompressed);
      result.checkpoint();
      return result;
    });

    it('can set same format twice', function() {
      var zlibStream = new Decompress();
      var inflateAuto = new InflateAuto();
      var result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);
      inflateAuto.setFormat(Decompress);
      inflateAuto.setFormat(Decompress);
      result.checkpoint();
      zlibStream.end(compressed);
      inflateAuto.end(compressed);
      result.checkpoint();
      return result;
    });

    it('throws if changing format', function() {
      var inflateAuto = new InflateAuto();
      inflateAuto.setFormat(zlib.Inflate);
      try {
        inflateAuto.setFormat(zlib.Gunzip);
        throw new Error('Should have thrown');
      } catch (err) {
        assert(/\bformat\b/i.test(err.message));
      }
    });

    it('throws if changing detected format', function() {
      var inflateAuto = new InflateAuto();
      inflateAuto.write(otherHeader);
      try {
        inflateAuto.setFormat(Decompress);
        throw new Error('Should have thrown');
      } catch (err) {
        assert(/\bformat\b/i.test(err.message));
      }
    });
  });

  // _processChunk is a semi-public API since it is called externally for
  // synchronous operation.  Other code may rely on this.
  describe('#_processChunk()', function() {
    // existence check
    it('has the same type', function() {
      var autoType = typeof InflateAuto.prototype._processChunk;
      var zlibType = typeof Decompress.prototype._processChunk;
      assert.strictEqual(autoType, zlibType);

      autoType = typeof new InflateAuto()._processChunk;
      zlibType = typeof new Decompress()._processChunk;
      assert.strictEqual(autoType, zlibType);
    });

    if (!Decompress.prototype._processChunk) {
      return;
    }

    describe('with cb', function() {
      // Note:  When called with callback without 'error' listener on 0.12
      // 'error' is emitted asynchronously causing unhandledException.
      // Not currently tested.

      it('emits error without calling callback', function() {
        var zlibStream = new Decompress();
        var inflateAuto = new InflateAuto();
        var result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);

        function neverCalled() {
          throw new Error('should not be called');
        }

        var zeros = new Buffer(10);
        zeros.fill(0);
        zlibStream._processChunk(zeros, zlib.Z_FINISH, neverCalled);
        inflateAuto._processChunk(zeros, zlib.Z_FINISH, neverCalled);
        result.checkpoint();
        return result;
      });

      it('yields format error', function(done) {
        var inflateAuto = new InflateAuto({defaultFormat: null});
        var zeros = new Buffer(10);
        zeros.fill(0);
        inflateAuto.on('error', function() {
          throw new Error('error should not be emitted');
        });
        inflateAuto._processChunk(zeros, zlib.Z_NO_FLUSH, function(err) {
          assert(err, 'expected format error');
          assert(/format/i.test(err.message));
          deepEqual(err.data, zeros);
          done();
        });
      });

      it('works if _transform does not yield synchronously', function(done) {
        function AsyncTransform() { stream.Transform.apply(this, arguments); }
        AsyncTransform.prototype = Object.create(stream.Transform.prototype);
        AsyncTransform.prototype.constructor = AsyncTransform;
        AsyncTransform.prototype._transform = function(data, enc, cb) {
          process.nextTick(function() {
            cb(null, data);
          });
        };

        var inflateAuto = new InflateAuto({defaultFormat: AsyncTransform});
        var zeros = new Buffer(10);
        zeros.fill(0);
        inflateAuto.on('error', function() {
          throw new Error('error should not be emitted');
        });
        inflateAuto._processChunk(zeros, zlib.Z_NO_FLUSH, function(err, data) {
          deepEqual(data, zeros);
          done();
        });
      });

      it('buffers inconclusive data', function(done) {
        var inflateAuto = new InflateAuto();
        var trunc = compressed.slice(0, 1);
        inflateAuto.on('error', function() {
          throw new Error('error should not be emitted');
        });
        inflateAuto._processChunk(trunc, zlib.Z_NO_FLUSH, function(err, data) {
          assert.ifError(err);
          assert.strictEqual(data, undefined);
          done();
        });
      });
    });

    describe('without cb', function() {
      it('throws without error listener', function() {
        var zlibStream = new Decompress();
        var inflateAuto = new InflateAuto();

        var zeros = new Buffer(10);
        zeros.fill(0);

        var errInflate;
        try {
          zlibStream._processChunk(zeros, zlib.Z_FINISH);
        } catch (err) {
          errInflate = err;
        }

        var errAuto;
        try {
          inflateAuto._processChunk(zeros, zlib.Z_FINISH);
        } catch (err) {
          errAuto = err;
        }

        deepEqual(errAuto, errInflate);
      });

      it('throws with error listener', function() {
        var zlibStream = new Decompress();
        var inflateAuto = new InflateAuto();
        var result = streamCompare(inflateAuto, zlibStream, COMPARE_OPTIONS);

        var zeros = new Buffer(10);
        zeros.fill(0);

        var errInflate;
        try {
          zlibStream._processChunk(zeros, zlib.Z_FINISH);
        } catch (err) {
          errInflate = err;
        }

        var errAuto;
        try {
          inflateAuto._processChunk(zeros, zlib.Z_FINISH);
        } catch (err) {
          errAuto = err;
        }

        deepEqual(errAuto, errInflate);
        result.checkpoint();
      });

      it('throws format errors', function() {
        var inflateAuto = new InflateAuto({defaultFormat: null});
        var zeros = new Buffer(10);
        zeros.fill(0);
        inflateAuto.on('error', function() {
          throw new Error('error should not be emitted');
        });
        assert.throws(function() {
          inflateAuto._processChunk(zeros, zlib.Z_NO_FLUSH);
        });
      });

      it('throws if format lacks _processChunk and _transform', function() {
        function NoTransform() { stream.Duplex.apply(this, arguments); }
        NoTransform.prototype = Object.create(stream.Duplex.prototype);
        NoTransform.prototype.constructor = NoTransform;
        NoTransform.prototype._read = function() {};
        NoTransform.prototype._write = function(chunk, enc, cb) {
          this.push(chunk);
          cb();
        };

        var inflateAuto = new InflateAuto({defaultFormat: NoTransform});
        var zeros = new Buffer(10);
        zeros.fill(0);
        inflateAuto.on('error', function() {
          throw new Error('error should not be emitted');
        });
        assert.throws(
          function() {
            inflateAuto._processChunk(zeros, zlib.Z_NO_FLUSH);
          },
          /NoTransform.*_processChunk/
        );
      });

      it('throws if _transform does not yield synchronously', function() {
        function AsyncTransform() { stream.Transform.apply(this, arguments); }
        AsyncTransform.prototype = Object.create(stream.Transform.prototype);
        AsyncTransform.prototype.constructor = AsyncTransform;
        AsyncTransform.prototype._transform = function() {};

        var inflateAuto = new InflateAuto({defaultFormat: AsyncTransform});
        var zeros = new Buffer(10);
        zeros.fill(0);
        inflateAuto.on('error', function() {
          throw new Error('error should not be emitted');
        });
        assert.throws(
          function() {
            inflateAuto._processChunk(zeros, zlib.Z_NO_FLUSH);
          },
          /AsyncTransform.*_processChunk/
        );
      });

      it('throws if _transform yields Error', function() {
        var errTest = new Error('test');
        function ErrorTransform() { stream.Transform.apply(this, arguments); }
        ErrorTransform.prototype = Object.create(stream.Transform.prototype);
        ErrorTransform.prototype.constructor = ErrorTransform;
        ErrorTransform.prototype._transform = function(data, enc, cb) {
          cb(errTest);
        };

        var inflateAuto = new InflateAuto({defaultFormat: ErrorTransform});
        var zeros = new Buffer(10);
        zeros.fill(0);
        inflateAuto.on('error', function() {
          throw new Error('error should not be emitted');
        });
        assert.throws(
          function() {
            inflateAuto._processChunk(zeros, zlib.Z_NO_FLUSH);
          },
          function(err) {
            return err === errTest;
          }
        );
      });
    });
  });
}

describe('InflateAuto', function() {
  // Match constructor behavior of Gunzip/Inflate/InflateRaw
  it('instantiates without new', function() {
    // eslint-disable-next-line new-cap
    var auto = InflateAuto();
    assertInstanceOf(auto, InflateAuto);
  });

  it('accepts Array-like detectors', function() {
    var auto = new InflateAuto({
      detectors: {
        0: zlib.Gunzip,
        length: 1
      }
    });
    deepEqual(auto._detectors, [zlib.Gunzip]);
  });

  it('throws TypeError for non-Array-like detectors', function() {
    assert.throws(
      // eslint-disable-next-line no-new
      function() { new InflateAuto({detectors: true}); },
      TypeError
    );
  });

  it('throws TypeError for non-function detector', function() {
    assert.throws(
      // eslint-disable-next-line no-new
      function() { new InflateAuto({detectors: [zlib.Gunzip, null]}); },
      TypeError
    );
  });

  it('throws TypeError for non-function defaultFormat', function() {
    assert.throws(
      // eslint-disable-next-line no-new
      function() { new InflateAuto({defaultFormat: true}); },
      TypeError
    );
  });

  it('defaultFormat null disables default', function(done) {
    var auto = new InflateAuto({defaultFormat: null});
    var testData = new Buffer(10);
    testData.fill(0);
    auto.on('error', function(err) {
      assert(err, 'expected format mismatch error');
      assert(/format/i.test(err.message));
      deepEqual(err.data, testData);
      done();
    });
    auto.write(testData);
  });

  it('emits error for format detection error in _transform', function(done) {
    var inflateAuto = new InflateAuto({defaultFormat: null});
    var zeros = new Buffer(10);
    zeros.fill(0);
    inflateAuto.once('error', function(err) {
      assert(err, 'expected format error');
      assert(/format/i.test(err.message));
      deepEqual(err.data, zeros);
      done();
    });
    inflateAuto.write(zeros);
  });

  // Analogous to Gunzip/Inflate/InflateRaw
  describe('.createInflateAuto()', function() {
    it('is a factory function', function() {
      var auto = InflateAuto.createInflateAuto();
      assertInstanceOf(auto, InflateAuto);
    });
  });

  describe('#flush()', function() {
    // To prevent deadlocks of callers waiting for flush before writing
    it('calls its callback before format detection', function(done) {
      var auto = new InflateAuto();
      auto.on('error', done);
      auto.flush(done);
    });
  });

  describe('#getFormat()', function() {
    it('returns null before format detection', function() {
      var inflateAuto = new InflateAuto();
      assert.strictEqual(inflateAuto.getFormat(), null);
    });
  });

  if (InflateAuto.prototype.params) {
    describe('#params()', function() {
      // To prevent deadlocks of callers waiting for params before writing
      it('calls its callback before format detection', function(done) {
        var auto = new InflateAuto();
        auto.on('error', done);
        auto.params(zlib.Z_BEST_COMPRESSION, zlib.Z_FILTERED, done);
      });
    });
  }

  SUPPORTED_FORMATS.forEach(function(format) {
    describe(format.Compress.name + ' support', function() {
      defineFormatTests(format);
    });
  });
});
