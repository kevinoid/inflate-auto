// Test writing null
// Test writing 0 bytes
// Test writing 1 byte
// Test writing 2 bytes (deflate, gzip, and raw)
// Test writing 3 bytes (deflate, gzip, and raw)
// Test each of the above followed by close
// Test each of the above followed by another write
// Test corrupted data for deflate, gzip, and raw
// Check close, flush, params, reset method functionality
// Check close, flush, params, reset work when called before write
'use strict';

const Buffer = require('buffer').Buffer;
const InflateAuto = require('..');
const should = require('should');
const zlib = require('zlib');

describe('InflateAuto', function() {
  // Match constructor behavior of Gunzip/Inflate/InflateRaw
  it('instantiates without new', function() {
    var auto = InflateAuto();
    should(auto).be.instanceof(InflateAuto);
  });

  it('supports no writes', function(done) {
    var auto = new InflateAuto();
    auto.on('error', done);
    auto.end(done);
  });

  it('supports writing no data', function(done) {
    var auto = new InflateAuto();
    auto.on('error', done);
    auto.end(new Buffer(0), done);
  });

  it('detects gzip', function(done) {
    var input = new Buffer([0]);
    zlib.gzip(input, function(err, gzipped) {
      should.not.exist(err);

      InflateAuto.inflateAuto(gzipped, function(errAuto, output) {
        should.not.exist(errAuto);

        should.deepEqual(output, input);
        done();
      });
    });
  });

  it('detects deflate', function(done) {
    var input = new Buffer([0]);
    zlib.deflate(input, function(err, deflated) {
      should.not.exist(err);

      InflateAuto.inflateAuto(deflated, function(errAuto, output) {
        should.not.exist(errAuto);

        should.deepEqual(output, input);
        done();
      });
    });
  });

  it('fallback to deflate raw', function(done) {
    var input = new Buffer([0]);
    zlib.deflateRaw(input, function(err, deflated) {
      should.not.exist(err);

      InflateAuto.inflateAuto(deflated, function(errAuto, output) {
        should.not.exist(errAuto);

        should.deepEqual(output, input);
        done();
      });
    });
  });

  /** Inflate data by writing blocks of a given size. */
  function inflateBlocks(deflated, blocksize, cb) {
    var auto = new InflateAuto();
    auto.on('error', cb);

    var output = [];
    auto.on('data', function(data) {
      output.push(data);
    });
    auto.on('end', function() {
      cb(null, Buffer.concat(output));
    });

    for (var i = 0; i < deflated.length; i += blocksize) {
      auto.write(deflated.slice(i, i + blocksize)).should.be.true();
    }
    auto.end();
  }

  it('detects gzip - 1 byte writes', function(done) {
    var input = new Buffer([0]);
    zlib.gzip(input, function(errGzip, gzipped) {
      should.not.exist(errGzip);

      inflateBlocks(gzipped, 1, function(errAuto, output) {
        should.not.exist(errAuto);
        should.deepEqual(output, input);
        done();
      });
    });
  });

  it('detects deflate - 1 byte writes', function(done) {
    var input = new Buffer([0]);
    zlib.deflate(input, function(errDeflate, deflated) {
      should.not.exist(errDeflate);

      inflateBlocks(deflated, 1, function(errAuto, output) {
        should.not.exist(errAuto);
        should.deepEqual(output, input);
        done();
      });
    });
  });

  it('fallback to deflate raw - 1 byte writes', function(done) {
    var input = new Buffer([0]);
    zlib.deflateRaw(input, function(errDeflate, deflated) {
      should.not.exist(errDeflate);

      inflateBlocks(deflated, 1, function(errAuto, output) {
        should.not.exist(errAuto);
        should.deepEqual(output, input);
        done();
      });
    });
  });

  it('treats partial deflate header as raw', function(done) {
    var partial = new Buffer([0x78]);
    zlib.inflateRaw(partial, function(errInflate, dataInflate) {
      InflateAuto.inflateAuto(partial, function(errAuto, dataAuto) {
        should.deepEqual(errInflate, errAuto);
        should.deepEqual(dataInflate, dataAuto);
        done();
      });
    });
  });

  it('treats partial gzip header as raw', function(done) {
    var partial = new Buffer([0x1f]);
    zlib.inflateRaw(partial, function(errInflate, dataInflate) {
      InflateAuto.inflateAuto(partial, function(errAuto, dataAuto) {
        should.deepEqual(errInflate, errAuto);
        should.deepEqual(dataInflate, dataAuto);
        done();
      });
    });
  });

  // For objectMode: true validation is done in _transform.  Check we match.
  it('errors on write of invalid type', function(done) {
    var inflate = new zlib.Inflate({objectMode: true});
    var haveErr1 = false;
    inflate.on('error', function(errInflate) {
      var auto = new InflateAuto({objectMode: true});
      var haveErr2 = false;
      auto.on('error', function(errAuto) {
        should.deepEqual(errInflate, errAuto);
        done();
      });
      auto.on('end', function() {
        haveErr2.should.be.true();
      });

      auto.write(true);
      auto.end();
    });
    inflate.on('end', function() {
      haveErr1.should.be.true();
    });

    inflate.write(true);
    inflate.end();
  });

  it('emits same error as Gzip for 0-buffer', function(done) {
    // Note:  gunzip silently fails when input is very short.  Make > 15 bytes.
    var bad = new Buffer(16);
    bad.fill(0);
    bad.writeUInt8(0x1f, 0);
    bad.writeUInt8(0x8b, 1);
    bad.writeUInt8(0x08, 2);
    zlib.gunzip(bad, function(errGunzip, dataGunzip) {
      InflateAuto.inflateAuto(bad, function(errAuto, dataAuto) {
        should.exist(errGunzip);
        should.deepEqual(errGunzip, errAuto);
        should.deepEqual(dataGunzip, dataAuto);
        done();
      });
    });
  });

  it('emits same error as Inflate for 0-buffer', function(done) {
    // Note:  inflate silently fails when input is very short.  Make > 6 bytes.
    var bad = new Buffer([0x78, 0x9c, 0, 0, 0, 0, 0]);
    zlib.inflate(bad, function(errInflate, dataInflate) {
      InflateAuto.inflateAuto(bad, function(errAuto, dataAuto) {
        should.exist(errInflate);
        should.deepEqual(errInflate, errAuto);
        should.deepEqual(dataInflate, dataAuto);
        done();
      });
    });
  });

  it('emits same error as InflateRaw for 0-buffer', function(done) {
    // Note:  inflate silently fails when input is very short.  Make > 4 bytes.
    var bad = new Buffer([0, 0, 0, 0, 0]);
    zlib.inflateRaw(bad, function(errInflate, dataInflate) {
      InflateAuto.inflateAuto(bad, function(errAuto, dataAuto) {
        should.exist(errInflate);
        should.deepEqual(errInflate, errAuto);
        should.deepEqual(dataInflate, dataAuto);
        done();
      });
    });
  });

  // Analogous to Gunzip/Inflate/InflateRaw
  describe('.createInflateAuto()', function() {
    it('is a factory function', function() {
      var auto = InflateAuto.createInflateAuto();
      should(auto).be.instanceof(InflateAuto);
    });
  });

  describe('.inflateAutoSync()', function() {
    it('can inflate synchronously', function() {
      var input = new Buffer([0]);
      var deflated = zlib.deflateSync(input);
      var inflated = InflateAuto.inflateAutoSync(deflated);
      should.deepEqual(inflated, input);
    });

    it('can inflate strings synchronously', function() {
      var input = new Buffer([0]);
      // Note:  deflateSync is invalid UTF-8.  deflateRawSync is ok.
      var deflated = zlib.deflateRawSync(input);
      var inflated = InflateAuto.inflateAutoSync(deflated.toString());
      should.deepEqual(inflated, input);
    });

    it('errors like Inflate for invalid type synchronously', function() {
      var errInflate, errAuto;
      try { zlib.inflateSync(true); } catch (err) { errInflate = err; }
      try { InflateAuto.inflateAutoSync(true); } catch (err) { errAuto = err; }
      should.deepEqual(errInflate, errAuto);
    });

    it('errors like InflateRaw for partial header', function() {
      var partial = new Buffer([0x78]);

      var dataInflate, errInflate;
      try {
        dataInflate = zlib.inflateRawSync(partial);
      } catch (err) {
        errInflate = err;
      }

      var dataAuto, errAuto;
      try {
        dataAuto = InflateAuto.inflateAutoSync(partial);
      } catch (err) {
        errAuto = err;
      }

      should.deepEqual(errInflate, errAuto);
      should.deepEqual(dataInflate, dataAuto);
    });
  });

  describe('#close()', function() {
    it('calls its callback immediately', function(done) {
      var auto = new InflateAuto();
      auto.on('error', done);
      auto.close(done);
    });

    it('emits the close event', function(done) {
      var auto = new InflateAuto();
      auto.on('error', done);
      auto.on('close', done);
      auto.close();
    });

    it('only emits the close event once', function(done) {
      var auto = new InflateAuto();
      auto.on('error', done);
      var closeCount = 0;
      auto.on('close', function() {
        ++closeCount;
        closeCount.should.equal(1);
        auto.close();
        setTimeout(done, 1);
      });
      auto.close();
    });

    it('emits error on #end() after #close()', function(done) {
      var auto = new InflateAuto();
      var inflate = new zlib.Inflate();

      var autoErr;
      var inflateErr;
      function oneDone(err) {
        if (this === auto) {
          autoErr = err || false;
        } else {
          inflateErr = err || false;
        }

        if (autoErr !== undefined && inflateErr !== undefined) {
          should.deepEqual(autoErr, inflateErr);
          done();
        }
      }

      inflate.on('error', oneDone);
      inflate.on('end', oneDone);
      inflate.close();
      inflate.end(function(inflateErr2) {
        auto.on('error', oneDone);
        auto.on('end', oneDone);
        auto.close();
        auto.end(function(autoErr2) {
          should.deepEqual(inflateErr2, autoErr2);
        });
      });
    });

    it('throws on #reset() after #close()', function(done) {
      var inflate = new zlib.Inflate();
      inflate.on('error', done);
      inflate.close();
      var errInflate;
      try { inflate.reset(); } catch (err) { errInflate = err; }

      var auto = new InflateAuto();
      auto.on('error', done);
      auto.close();
      var errAuto;
      try { auto.reset(); } catch (err) { errAuto = err; }

      should.deepEqual(errInflate, errAuto);
      // Wait for error event, if any
      setTimeout(done, 1);
    });

    it('returns error on #write() after #close()', function(done) {
      var auto = new InflateAuto();
      var inflate = new zlib.Inflate();

      var autoErr;
      var inflateErr;
      function oneDone(err) {
        if (this === auto) {
          autoErr = err || false;
        } else {
          inflateErr = err || false;
        }

        if (autoErr !== undefined && inflateErr !== undefined) {
          should.deepEqual(autoErr, inflateErr);
          done();
        }
      }

      inflate.on('error', oneDone);
      inflate.on('end', oneDone);
      inflate.close();
      inflate.write(new Buffer(0), function(inflateErr2) {
        should.exist(inflateErr2);

        auto.on('error', oneDone);
        auto.on('end', oneDone);
        auto.close();
        auto.write(new Buffer(0), function(autoErr2) {
          should.deepEqual(inflateErr2, autoErr2);
        });
      });
    });
  });

  describe('#flush()', function() {
    // To prevent deadlocks of callers waiting for flush before writing
    it('calls its callback immediately', function(done) {
      var auto = new InflateAuto();
      auto.on('error', done);
      auto.flush(done);
    });

    // Note:  No good way to test functionality, since flush doesn't have a
    // visible effect for inflate.
    it('doesn\'t cause error before write', function(done) {
      var input = new Buffer([0]);
      zlib.deflate(input, function(err, deflated) {
        should.not.exist(err);

        var auto = new InflateAuto();
        auto.on('error', done);

        var output = [];
        auto.on('data', function(data) {
          output.push(data);
        });
        auto.on('end', function() {
          should.deepEqual(Buffer.concat(output), input);
          done();
        });

        auto.flush();
        auto.end(deflated);
      });
    });

    it('doesn\'t cause error between writes', function(done) {
      var input = new Buffer([0]);
      zlib.deflate(input, function(err, deflated) {
        should.not.exist(err);

        var auto = new InflateAuto();
        auto.on('error', done);

        var output = [];
        auto.on('data', function(data) {
          output.push(data);
        });
        auto.on('end', function() {
          should.deepEqual(Buffer.concat(output), input);
          done();
        });

        auto.write(deflated.slice(0, 4));
        auto.flush();
        auto.end(deflated.slice(4));
      });
    });
  });

  describe('#params()', function() {
    // To prevent deadlocks of callers waiting for params before writing
    it('calls its callback immediately', function(done) {
      var auto = new InflateAuto();
      auto.on('error', done);
      auto.params(zlib.Z_BEST_COMPRESSION, zlib.Z_FILTERED, done);
    });

    // Note:  Params has no effect on inflate.  Tested only to avoid errors.
    it('doesn\'t cause error before write', function(done) {
      var input = new Buffer([0]);
      zlib.deflate(input, function(err, deflated) {
        should.not.exist(err);

        var auto = new InflateAuto();
        auto.on('error', done);

        var output = [];
        auto.on('data', function(data) {
          output.push(data);
        });
        auto.on('end', function() {
          should.deepEqual(Buffer.concat(output), input);
          done();
        });

        auto.params(zlib.Z_BEST_COMPRESSION, zlib.Z_FILTERED);
        auto.end(deflated);
      });
    });

    it('doesn\'t cause error between writes', function(done) {
      var input = new Buffer([0]);
      zlib.deflate(input, function(err, deflated) {
        should.not.exist(err);

        var auto = new InflateAuto();
        auto.on('error', done);

        var output = [];
        auto.on('data', function(data) {
          output.push(data);
        });
        auto.on('end', function() {
          should.deepEqual(Buffer.concat(output), input);
          done();
        });

        auto.write(deflated.slice(0, 4));
        auto.params(zlib.Z_BEST_COMPRESSION, zlib.Z_FILTERED);
        auto.end(deflated.slice(4));
      });
    });

    // Note:  Argument errors behavior is not guaranteed.  See method comment
    // for details.
  });

  describe('#reset()', function() {
    it('does nothing pre-write', function(done) {
      var input = new Buffer([0]);
      zlib.deflate(input, function(err, deflated) {
        should.not.exist(err);

        var auto = new InflateAuto();
        auto.on('error', done);

        var output = [];
        auto.on('data', function(data) {
          output.push(data);
        });
        auto.on('end', function() {
          should.deepEqual(Buffer.concat(output), input);
          done();
        });

        auto.reset();
        auto.end(deflated);
      });
    });

    it('discards partial header', function(done) {
      var input = new Buffer([0]);
      zlib.deflate(input, function(err, deflated) {
        should.not.exist(err);

        var auto = new InflateAuto();
        auto.on('error', done);

        var output = [];
        auto.on('data', function(data) {
          output.push(data);
        });
        auto.on('end', function() {
          should.deepEqual(Buffer.concat(output), input);
          done();
        });

        auto.write(deflated.slice(0, 1));
        auto.reset();
        auto.write(deflated);
        auto.end();
      });
    });

    it('discards post-header data', function(done) {
      var input = new Buffer([0]);
      zlib.deflate(input, function(err, deflated) {
        should.not.exist(err);

        var auto = new InflateAuto();
        auto.on('error', done);

        var output = [];
        auto.on('data', function(data) {
          output.push(data);
        });
        auto.on('end', function() {
          should.deepEqual(Buffer.concat(output), input);
          done();
        });

        auto.write(deflated.slice(0, 3));
        auto.reset();
        auto.write(deflated);
        auto.end();
      });
    });

    // Note:  Behavior on compression type change after reset is not
    // guaranteed.  See method comment for details.
  });
});
