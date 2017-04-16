
/**
 *  All things JavaScript-ifying xray.
 */
var sg                  = require('sgsg');
var _                   = sg._;
var AWSXRay             = require('aws-xray-sdk');
var nginx               = require('nginx-json/subrequest');

var mwUtils             = AWSXRay.middleware;
var IncomingRequestData = mwUtils.IncomingRequestData;

AWSXRay.config([AWSXRay.plugins.EC2Plugin]);

var xray = {};

/**
 *  Send the response to options.(service | ip:port).
 *
 *  Since we rely on nginx and its X-Accel-Redirect, we have to do this in order to propigate the
 *  magic header to the reverse-proxied-to server.
 *
 */
xray.balanceTo = function(req, res, path, options_) {
  var xrayTraceHeader   = res.sg.xrayTraceHeader  || mwUtils.processHeaders(req);
  var options           = _.extend({}, options_ || {});

  options.root    = xrayTraceHeader.Root    || options.root;
  options.parent  = xrayTraceHeader.Parent  || options.parent;
  options.sampled = xrayTraceHeader.Sampled || options.sampled;

  // If we still do not have a root, make one
  if (!options.root) {
    options.root = "1-"+sg.randomString(8, sg.hexCharSet)+'-'+sg.randomString(24, sg.hexCharSet);
  }

  // Fixup sampled
  if (!('sampled' in options)) {
    options.sampled = '0';
  } else if (options.sampled === true) {
    options.sampled = '1';
  } else if (options.sampled === false) {
    options.sampled = '0';
  }

  nginx.instrumentedBalanceTo(req, res, path, options);
};

/**
 *  Middleware-ify the req and res objects.
 *
 *  Do the XRay middleware-ification on raw req and res objects.
 *
 *  A lot of this was stolen from the AWS code for middleware-ifying Express apps.
 */
xray.mwRawReqRes = function(req, res, name, shouldSampleIt) {
  var segment;

  // Make sure that sg has done its mw-ification
  if (!res.sg) { sg.mwReqRes(req, res); }

  // Get the values from the magic XRay header
  var xrayTraceHeader = mwUtils.processHeaders(req);

  // Fixup -- We use the already-existing Sampled, or set it; Root and Parent we do not fixup
  xrayTraceHeader.Sampled   = xrayTraceHeader.Sampled   || shouldSampleIt;

  // Create the Segment object
  if (xrayTraceHeader.Parent) {
    segment  = new AWSXRay.Segment(name, xrayTraceHeader.Root, xrayTraceHeader.Parent);
  } else {
    segment  = new AWSXRay.Segment(name, xrayTraceHeader.Root);
  }

  segment.addIncomingRequestData(new IncomingRequestData(req));

  res.sg.xrayTraceHeader = xrayTraceHeader;

  // Do the middleware trick
  var origEnd   = res.end;
  res.end = function() {
    res.end   = origEnd;

    // This sets segment.fault or segment.error
    if (AWSXRay.utils.getCauseTypeFromHttpStatus(res.statusCode)) {
      segment[AWSXRay.utils.getCauseTypeFromHttpStatus(res.statusCode)] = true;
    }

    segment.http.close(res);
    segment.close();

    return res.end.apply(res, arguments);
  };

  // Tell XRay the segment
  if (AWSXRay.isAutomaticMode()) {
    var ns = AWSXRay.getNamespace();
    ns.bindEmitter(req);
    ns.bindEmitter(res);

    ns.run(function () {
      AWSXRay.setSegment(segment);
    });
  } else {
    req.segment = segment;
  }
};

_.each(xray, function(value, key) {
  exports[key] = value;
});

