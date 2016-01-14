InflateAuto
===========

[![Build status](https://img.shields.io/travis/kevinoid/inflate-auto.svg?style=flat-square)](https://travis-ci.org/kevinoid/inflate-auto)
[![Code Climate](http://img.shields.io/codeclimate/github/kevinoid/inflate-auto.svg?style=flat-square)](https://codeclimate.com/github/kevinoid/inflate-auto)
[![Coverage](https://img.shields.io/codecov/c/github/kevinoid/inflate-auto.svg?style=flat-square)](https://codecov.io/github/kevinoid/inflate-auto?branch=master)
[![Coverage](https://img.shields.io/coveralls/kevinoid/inflate-auto.svg?style=flat-square)](https://coveralls.io/r/kevinoid/inflate-auto)
[![Dependency Status](https://img.shields.io/david/kevinoid/inflate-auto.svg?style=flat-square)](https://david-dm.org/kevinoid/inflate-auto)
[![License](http://img.shields.io/:license-mit-blue.svg)](http://mit-license.org)
<!-- If no major bugs are found in the next few months, consider it stable. -->
[![Stability](http://badges.github.io/stability-badges/dist/unstable.svg)](http://github.com/badges/stability-badges)
[![Version](https://badge.fury.io/js/inflate-auto.svg)](https://badge.fury.io/js/inflate-auto)

The `InflateAuto` class is designed to function as a drop-in replacement for
`zlib.Gunzip`, `zlib.Inflate`, and `zlib.InflateRaw` when the method of
compression is not known in advance.  `InflateAuto` uses the first few bytes
of data to determine the compression method (by checking for a valid gzip or
zlib deflate header) then delegating the decompression work to the
corresponding type.

## Compatibility

`InflateAuto` should behave identically to any of the `zlib` decompression
types, with the exception of `instanceof` and `.constructor` checks.  Using
the class should be as simple as replacing `zlib.Inflate` with `InflateAuto`
in existing code.  If any real-world which code requires modification (other
than mentioned above) to work with `InflateAuto` is considered to be a bug in
`InflateAuto`.  Please report the issue so that `InflateAuto` can be fixed to
work seamlessly.

## Use Cases

The primary use case for which this module was created is decompressing HTTP
responses which declare `Content-Encoding: deflate`.  As noted in [Section
4.2.2 of RFC 7230](https://tools.ietf.org/html/rfc7230#section-4.2.2) "Some
non-conformant implementations send the `"deflate"` compressed data without
the zlib wrapper."  This has been attributed to [early Microsoft
servers](http://stackoverflow.com/a/9186091) and to [old Apache
mod\_deflate](https://mxr.mozilla.org/mozilla-esr38/source/netwerk/streamconv/converters/nsHTTPCompressConv.cpp#214),
and is almost certainly an issue in less common servers.  Regardless of the
most common cause, it is observed in real-world behavior and poses a
compatibility risk for HTTP clients which support deflate encoding.  Using
`InflateAuto` is one way to address the issue.
